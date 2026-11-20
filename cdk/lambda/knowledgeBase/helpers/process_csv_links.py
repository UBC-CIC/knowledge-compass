"""
process_csv_links.py

Worker for the link phase of a CSV ingestion run (see csv_links.py). Invoked
asynchronously ("task": "process_csv_links" in main.py) once the CSV's own
rows are indexed; the run stays 'running' until this finalizes it.

Per invocation:
- every distinct pending URL of the CSV is fetched once (link_fetcher.py) on a
  small thread pool; DB writes and embedding stay on the main thread (the
  psycopg2 connection is not shared across threads);
- a URL another CSV already fetched in the same sync session is not fetched
  again: its rows are just marked successful;
- HTML/PDF text is chunked like Markdown / documents and written with
  process_document_batch.write_chunks, so re-crawling an unchanged page
  re-embeds nothing. PDFs are read (Textract OCR with a pypdf fallback, see
  pdf_text.py) on the fetch threads, so a slow OCR job overlaps other
  fetches. The linking rows' other columns are attached to the source
  (metadata.rows) and every chunk (metadata.csv_rows);
- a failed fetch only fails its rows. A permanent failure (dead link,
  blocked, disallowed, unsupported) removes previously indexed content for
  that URL; a transient one (timeout, 5xx, a PDF OCR could not finish right
  now) keeps it;
- no new URL is started once less than one fetch + embedding margin of
  Lambda time is left; the worker then re-invokes itself for the rest (up
  to LINK_MAX_CONTINUATIONS times) before finalizing the run.
"""

import hashlib
import json
import logging
import os
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

from helpers.admin_audit import actor_from_event
from helpers.csv_links import (
    delete_unreferenced_link_sources,
    delete_unreferenced_row_sources,
    invoke_link_worker,
    row_source_url,
)
from helpers.html_extract import extract_html
from helpers.link_fetcher import HTML, PDF, FetchError, FetchLimits, LinkFetcher
from helpers.pdf_text import extract_pdf, ocr_enabled
from helpers.process_document_batch import (
    _chunk_document_text,
    _chunk_markdown,
    write_chunk_sets,
    write_chunks,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Time kept free for embedding + writing the last in-flight pages.
_EMBED_RESERVE_SECONDS = 60
# With OCR on, a fetch also needs time for Textract to read a PDF, so new
# fetches stop this much earlier (pdf_text keeps its own reserve on top).
_OCR_RESERVE_SECONDS = 90
_MAX_ROWS_IN_METADATA = 20
_DEFAULT_LAMBDA_SECONDS = 600
_ROW_INDEX_BATCH = 10
_URL_ROW_BATCH = 10
_ROW_INDEX_RESERVE_SECONDS = 15


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# ── DB access ─────────────────────────────────────────────────────────────────

class LinkStore:
    """All SQL the worker runs, so tests can swap in an in-memory store."""

    def __init__(self, connection):
        self.connection = connection

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def _one(self, sql, params=()):
        with self.connection.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchone()

    def _all(self, sql, params=()):
        with self.connection.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.fetchall()

    def _exec(self, sql, params=()) -> int:
        with self.connection.cursor() as cursor:
            cursor.execute(sql, params)
            return cursor.rowcount

    def run_is_active(self, run_id: str) -> bool:
        row = self._one(
            "SELECT status, metadata->>'link_phase' FROM ingestion_runs WHERE id = %s::uuid",
            (run_id,),
        )
        return bool(row) and row[0] == "running" and row[1] == "running"

    def pending_urls(self, data_source_id: str) -> list:
        rows = self._all(
            """
            SELECT normalized_url, source_url
            FROM csv_row_links
            WHERE data_source_id = %s::uuid AND status = 'pending' AND source_url IS NOT NULL
            GROUP BY normalized_url, source_url
            ORDER BY min(row_number)
            """,
            (data_source_id,),
        )
        return [{"normalized_url": r[0], "source_url": r[1]} for r in rows]

    def session_fetch(self, source_url: str, session_id: str) -> dict | None:
        row = self._one(
            """
            SELECT metadata->>'http_status', metadata->>'content_type'
            FROM sources
            WHERE url = %s AND metadata->>'fetch_session' = %s
              AND EXISTS (SELECT 1 FROM chunks c WHERE c.source_id = sources.id)
            """,
            (source_url, session_id),
        )
        if not row:
            return None
        return {"http_status": int(row[0]) if row[0] else None, "content_type": row[1]}

    def source_exists(self, source_url: str) -> bool:
        return self._one("SELECT 1 FROM sources WHERE url = %s", (source_url,)) is not None

    @staticmethod
    def _row_record(row) -> dict:
        keys = (
            "id", "data_source_id", "csv_file", "row_key", "row_number",
            "raw_url", "normalized_url", "source_url", "row_metadata", "status",
            "reason", "raw_citation_url", "citation_url", "citation_warning",
            "title", "description", "row_text", "resource_hash", "row_source_id",
        )
        record = dict(zip(keys, row))
        record["id"] = str(record["id"])
        record["data_source_id"] = str(record["data_source_id"])
        if record["row_source_id"]:
            record["row_source_id"] = str(record["row_source_id"])
        record["row_metadata"] = record["row_metadata"] or {}
        return record

    def pending_index_rows(self, data_source_id: str, limit: int = _ROW_INDEX_BATCH) -> list:
        rows = self._all(
            """
            SELECT l.id, l.data_source_id, ds.name, l.row_key, l.row_number,
                   l.raw_url, l.normalized_url, l.source_url, l.row_metadata,
                   l.status, l.reason, l.raw_citation_url, l.citation_url,
                   l.citation_warning, l.title, l.description, l.row_text,
                   l.resource_hash, l.row_source_id
            FROM csv_row_links l
            JOIN data_sources ds ON ds.id = l.data_source_id
            WHERE l.data_source_id = %s::uuid AND l.indexed_at IS NULL
            ORDER BY l.row_number, l.row_key
            LIMIT %s
            """,
            (data_source_id, limit),
        )
        return [self._row_record(row) for row in rows]

    def rows_for_source(self, source_url: str, data_source_id: str, limit: int = _URL_ROW_BATCH) -> list:
        rows = self._all(
            """
            SELECT l.id, l.data_source_id, ds.name, l.row_key, l.row_number,
                   l.raw_url, l.normalized_url, l.source_url, l.row_metadata,
                   l.status, l.reason, l.raw_citation_url, l.citation_url,
                   l.citation_warning, l.title, l.description, l.row_text,
                   l.resource_hash, l.row_source_id
            FROM csv_row_links l
            JOIN data_sources ds ON ds.id = l.data_source_id
            WHERE l.source_url = %s
              AND l.data_source_id = %s::uuid
              AND l.status = 'pending'
            ORDER BY l.row_number, l.row_key
            LIMIT %s
            """,
            (source_url, data_source_id, limit),
        )
        return [self._row_record(row) for row in rows]

    def canonical_content(self, source_url: str) -> tuple[str | None, list]:
        source = self._one("SELECT name FROM sources WHERE url = %s", (source_url,))
        if not source:
            return None, []
        rows = self._all(
            """
            SELECT c.chunk_index, c.body, c.embed_text, c.word_count,
                   c.content_hash, c.metadata
            FROM chunks c
            JOIN sources s ON s.id = c.source_id
            WHERE s.url = %s
            ORDER BY c.chunk_index
            """,
            (source_url,),
        )
        chunks = [
            {
                "chunk_index": row[0],
                "body": row[1],
                "text": row[2],
                "word_count": row[3],
                "content_hash": row[4],
                "metadata": row[5] or {},
            }
            for row in rows
        ]
        return source[0], chunks

    def upsert_row_source(self, row: dict, *, name: str, metadata: dict) -> str:
        source_url = row_source_url(row["data_source_id"], row["row_key"])
        source = self._one(
            """
            INSERT INTO sources (name, url, source_type, metadata)
            VALUES (%s, %s, 'csv_row', %s::jsonb)
            ON CONFLICT (url) DO UPDATE SET
              name        = EXCLUDED.name,
              source_type = EXCLUDED.source_type,
              metadata    = EXCLUDED.metadata,
              updated_at  = now()
            RETURNING id
            """,
            (name[:1024], source_url, json.dumps(metadata)),
        )
        return str(source[0])

    def mark_row_indexed(self, row_id: str, source_id: str, *, indexed: bool,
                         fetched_content: bool, reason: str | None):
        self._exec(
            """
            UPDATE csv_row_links
            SET row_source_id = %s::uuid,
                row_indexed = %s,
                fetched_content_indexed = %s,
                indexing_reason = %s,
                indexed_at = now(),
                updated_at = now()
            WHERE id = %s::uuid
            """,
            (source_id, indexed, fetched_content, reason, row_id),
        )

    def mark_row_ids(self, row_ids: list, status: str, *, reason=None, http_status=None,
                     content_type=None, fetched=False) -> int:
        if not row_ids:
            return 0
        return self._exec(
            """
            UPDATE csv_row_links
            SET status = %s,
                reason = %s,
                http_status = %s,
                content_type = %s,
                fetched_at = CASE WHEN %s THEN now() ELSE fetched_at END,
                updated_at = now()
            WHERE id = ANY(%s::uuid[]) AND status = 'pending'
            """,
            (status, reason, http_status, content_type, fetched, row_ids),
        )

    def count_index_pending(self, data_source_id: str) -> int:
        row = self._one(
            "SELECT count(*) FROM csv_row_links WHERE data_source_id = %s::uuid AND indexed_at IS NULL",
            (data_source_id,),
        )
        return int(row[0])

    def fail_index_pending(self, data_source_id: str, reason: str):
        self._exec(
            """
            UPDATE csv_row_links
            SET row_indexed = false, fetched_content_indexed = false,
                indexing_reason = %s, indexed_at = now(), updated_at = now()
            WHERE data_source_id = %s::uuid AND indexed_at IS NULL
            """,
            (reason, data_source_id),
        )

    def drop_fetched_content(self, source_url: str):
        self._exec(
            """
            DELETE FROM chunks c
            USING csv_row_links l
            WHERE l.source_url = %s
              AND l.row_source_id = c.source_id
              AND c.chunk_index > 0
            """,
            (source_url,),
        )
        self._exec(
            """
            UPDATE csv_row_links l
            SET fetched_content_indexed = false,
                row_indexed = EXISTS (
                  SELECT 1 FROM chunks c
                  WHERE c.source_id = l.row_source_id AND c.chunk_index = 0
                ),
                indexing_reason = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM chunks c
                    WHERE c.source_id = l.row_source_id AND c.chunk_index = 0
                  ) THEN NULL
                  ELSE 'no descriptive row text or fetched content'
                END,
                indexed_at = now(),
                updated_at = now()
            WHERE l.source_url = %s
            """,
            (source_url,),
        )

    def upsert_link_source(self, source_url: str, *, name: str, metadata: dict) -> str:
        row = self._one(
            """
            INSERT INTO sources (name, url, source_type, metadata)
            VALUES (%s, %s, 'csv_link', %s::jsonb)
            ON CONFLICT (url) DO UPDATE SET
              name        = EXCLUDED.name,
              source_type = EXCLUDED.source_type,
              metadata    = EXCLUDED.metadata,
              updated_at  = now()
            RETURNING id
            """,
            (name[:1024], source_url, json.dumps(metadata)),
        )
        return str(row[0])

    def refresh_source_rows(self, source_url: str):
        """Attach the (first few) CSV rows linking to this URL to its source and chunks."""
        rows = self._all(
            """
            SELECT l.data_source_id, ds.name, l.row_key, l.row_number, l.row_metadata,
                   count(*) OVER () AS total
            FROM csv_row_links l
            JOIN data_sources ds ON ds.id = l.data_source_id
            WHERE l.source_url = %s
            ORDER BY ds.created_at, l.row_number
            LIMIT %s
            """,
            (source_url, _MAX_ROWS_IN_METADATA),
        )
        linked = [
            {
                "csv_data_source_id": str(r[0]),
                "csv_file": r[1],
                "row_key": r[2],
                "row_number": r[3],
                "columns": r[4] or {},
            }
            for r in rows
        ]
        total = rows[0][5] if rows else 0
        source = self._one(
            """
            UPDATE sources
            SET metadata = metadata || jsonb_build_object('rows', %s::jsonb, 'row_count', %s::int),
                updated_at = now()
            WHERE url = %s
            RETURNING id
            """,
            (json.dumps(linked), total, source_url),
        )
        if source:
            self._exec(
                """
                UPDATE chunks
                SET metadata = metadata || jsonb_build_object('csv_rows', %s::jsonb)
                WHERE source_id = %s::uuid
                """,
                (json.dumps(linked), source[0]),
            )

    def mark_rows(self, source_url: str, status: str, *, data_source_id: str | None, reason=None,
                  http_status=None, content_type=None, fetched=False) -> int:
        """
        Set the status of this CSV's pending rows linking to `source_url`, or,
        with data_source_id=None, of every (non-skipped) row in any CSV linking there.
        """
        return self._exec(
            """
            UPDATE csv_row_links
            SET status       = %s,
                reason       = %s,
                http_status  = %s,
                content_type = %s,
                fetched_at   = CASE WHEN %s THEN now() ELSE fetched_at END,
                updated_at   = now()
            WHERE source_url = %s
              AND (
                (%s::uuid IS NOT NULL AND data_source_id = %s::uuid AND status = 'pending')
                OR (%s::uuid IS NULL AND status <> 'skipped')
              )
            """,
            (status, reason, http_status, content_type, fetched, source_url,
             data_source_id, data_source_id, data_source_id),
        )

    def delete_source(self, source_url: str):
        self._exec("DELETE FROM sources WHERE url = %s AND source_type = 'csv_link'::source_type", (source_url,))

    def count_pending(self, data_source_id: str) -> int:
        row = self._one(
            "SELECT count(*) FROM csv_row_links WHERE data_source_id = %s::uuid AND status = 'pending'",
            (data_source_id,),
        )
        return int(row[0])

    def fail_pending(self, data_source_id: str, reason: str):
        self._exec(
            """
            UPDATE csv_row_links SET status = 'failed', reason = %s, updated_at = now()
            WHERE data_source_id = %s::uuid AND status = 'pending'
            """,
            (reason, data_source_id),
        )

    def summary(self, data_source_id: str) -> dict:
        counts = {"pending": 0, "success": 0, "failed": 0, "skipped": 0}
        for status, count in self._all(
            "SELECT status, count(*) FROM csv_row_links WHERE data_source_id = %s::uuid GROUP BY status",
            (data_source_id,),
        ):
            counts[status] = count
        return counts

    def finalize_run(self, run_id: str, summary: dict):
        self._exec(
            """
            UPDATE ingestion_runs
            SET status        = 'completed'::ingestion_status,
                pages_crawled = 1 + %s,
                pages_skipped = %s,
                finished_at   = now(),
                completed_at  = now(),
                metadata      = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid AND status = 'running'::ingestion_status
            """,
            (
                summary.get("success", 0),
                summary.get("failed", 0) + summary.get("skipped", 0),
                json.dumps({"link_phase": "completed", "link_summary": summary}),
                run_id,
            ),
        )

    def delete_unreferenced_sources(self) -> int:
        deleted = delete_unreferenced_link_sources(self.connection)
        deleted += delete_unreferenced_row_sources(self.connection)
        return deleted


# ── Row-resource indexing ─────────────────────────────────────────────────────

def _row_display_title(row: dict, extracted_title: str | None = None) -> str:
    return row.get("title") or extracted_title or f"{row['csv_file']} — row {row['row_number']}"


def _csv_row_metadata(row: dict) -> dict:
    return {
        "csv_data_source_id": row["data_source_id"],
        "csv_file": row["csv_file"],
        "row_key": row["row_key"],
        "row_number": row["row_number"],
        "title": row.get("title"),
        "description": row.get("description"),
        "citation_url": row.get("citation_url"),
        "fetch_url": row.get("normalized_url"),
        "columns": row.get("row_metadata") or {},
    }


def _row_source_metadata(row: dict, extracted_title: str | None, has_fetched_content: bool) -> dict:
    metadata = {
        "csv_row": _csv_row_metadata(row),
        "csv_data_source_id": row["data_source_id"],
        "row_key": row["row_key"],
        "row_number": row["row_number"],
        "description": row.get("description"),
        "fetch_url": row.get("normalized_url"),
        "canonical_source_url": row.get("source_url"),
        "citation_warning": row.get("citation_warning"),
        "extracted_title": extracted_title,
        "has_fetched_content": has_fetched_content,
    }
    if row.get("citation_url"):
        metadata["citation_url"] = row["citation_url"]
    return metadata


def build_row_chunks(row: dict, canonical_chunks: list | None = None) -> list:
    """Build chunk 0 from the CSV row and chunks 1+ from canonical fetched text."""
    canonical_chunks = canonical_chunks or []
    csv_row = _csv_row_metadata(row)
    chunks: list = []
    row_text = (row.get("row_text") or "").strip()
    if row_text:
        metadata = {
            "heading_path": f"CSV row {row['row_number']}",
            "chunk_kind": "csv_row",
            "csv_row": csv_row,
            "citation_url": row.get("citation_url"),
        }
        chunks.append({
            "heading_path": metadata["heading_path"],
            "chunk_index": 0,
            "text": row_text,
            "body": row_text,
            "word_count": len(row_text.split()),
            "content_hash": hashlib.sha256(row_text.encode()).hexdigest()[:16],
            "metadata": metadata,
        })

    description = (row.get("description") or "").strip()
    for canonical in canonical_chunks:
        body = canonical["body"]
        embed_text = canonical["text"]
        if description:
            body = f"{description}\n\n{body}"
            embed_text = f"{description}\n\n{embed_text}"
        canonical_metadata = dict(canonical.get("metadata") or {})
        heading_path = canonical_metadata.get("heading_path") or f"fetched chunk {canonical['chunk_index'] + 1}"
        metadata = {
            **canonical_metadata,
            "heading_path": heading_path,
            "chunk_kind": "csv_row_fetched",
            "csv_row": csv_row,
            "citation_url": row.get("citation_url"),
            "canonical_source_url": row.get("source_url"),
            "canonical_chunk_index": canonical["chunk_index"],
            "canonical_content_key": (
                f"{row.get('source_url')}#{canonical['chunk_index']}:{canonical['content_hash']}"
            ),
        }
        chunks.append({
            "heading_path": heading_path,
            "chunk_index": canonical["chunk_index"] + 1,
            "text": embed_text,
            "body": body,
            "word_count": len(body.split()),
            "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
            "metadata": metadata,
        })
    return chunks


def materialize_rows(store, rows: list, *, canonical_overrides: dict | None = None, write=None) -> dict:
    """Upsert row sources, replace their full chunk sets, and record indexing state."""
    canonical_overrides = canonical_overrides or {}
    canonical_cache: dict = {}
    prepared: list = []
    for row in rows:
        canonical_title, canonical_chunks = None, []
        source_url = row.get("source_url")
        if source_url:
            if source_url in canonical_overrides:
                canonical_title, canonical_chunks = canonical_overrides[source_url]
            else:
                if source_url not in canonical_cache:
                    canonical_cache[source_url] = store.canonical_content(source_url)
                canonical_title, canonical_chunks = canonical_cache[source_url]
        chunks = build_row_chunks(row, canonical_chunks)
        source_id = store.upsert_row_source(
            row,
            name=_row_display_title(row, canonical_title),
            metadata=_row_source_metadata(row, canonical_title, bool(canonical_chunks)),
        )
        prepared.append((row, source_id, chunks, bool(canonical_chunks)))

    if write is None:
        write_chunk_sets(store.connection, [(source_id, chunks) for _, source_id, chunks, _ in prepared])
    else:
        for _, source_id, chunks, _ in prepared:
            write(store.connection, source_id, chunks)

    indexed = 0
    fetched = 0
    for row, source_id, chunks, has_fetched_content in prepared:
        is_indexed = bool(chunks)
        reason = None if is_indexed else "no descriptive row text or fetched content"
        store.mark_row_indexed(
            row["id"],
            source_id,
            indexed=is_indexed,
            fetched_content=has_fetched_content,
            reason=reason,
        )
        indexed += int(is_indexed)
        fetched += int(has_fetched_content)
    return {"processed": len(prepared), "indexed": indexed, "fetched": fetched}


def index_pending_rows(store, data_source_id: str, time_left, write=None) -> dict:
    stats = {"processed": 0, "indexed": 0, "fetched": 0}
    while time_left() > _ROW_INDEX_RESERVE_SECONDS:
        rows = store.pending_index_rows(data_source_id, _ROW_INDEX_BATCH)
        if not rows:
            break
        batch = materialize_rows(store, rows, write=write)
        store.commit()
        for key in stats:
            stats[key] += batch[key]
        if len(rows) < _ROW_INDEX_BATCH:
            break
    return stats


def materialize_source_rows(
    store,
    source_url: str,
    data_source_id: str,
    *,
    canonical_title: str | None,
    canonical_chunks: list,
    time_left,
    http_status=None,
    content_type=None,
    reason=None,
    fetched=False,
    write=None,
) -> int:
    """Drain bounded row pages for one available canonical fetch while time permits."""
    processed = 0
    while time_left() > _ROW_INDEX_RESERVE_SECONDS:
        rows = store.rows_for_source(source_url, data_source_id, _URL_ROW_BATCH)
        if not rows:
            break
        materialize_rows(
            store,
            rows,
            canonical_overrides={source_url: (canonical_title, canonical_chunks)},
            write=write,
        )
        store.mark_row_ids(
            [row["id"] for row in rows],
            "success",
            reason=reason,
            http_status=http_status,
            content_type=content_type,
            fetched=fetched,
        )
        store.commit()
        processed += len(rows)
        if len(rows) < _URL_ROW_BATCH:
            break
    if processed:
        store.refresh_source_rows(source_url)
        store.commit()
    return processed


# ── Canonical fetched-content indexing ────────────────────────────────────────

def _pdf_title(url: str) -> str:
    parts = urlsplit(url)
    name = unquote(parts.path.rstrip("/").rsplit("/", 1)[-1])
    return name or parts.hostname or url


def build_chunks(result, pdf=None) -> tuple[str, list]:
    """(title, chunks) for a fetched HTML page or PDF; `pdf` is the PDF's already-read PdfText."""
    if result.content_type == HTML:
        title, text = extract_html(result.body, result.charset)
        return title, _chunk_markdown(text)
    title = _pdf_title(result.url)
    if pdf is None:
        pdf = extract_pdf(result.body)
    return title, _chunk_document_text(pdf.text, title)


def _fetch(fetcher, url: str, time_left=None):
    """
    Runs on a pool thread and never raises: returns (FetchResult or FetchError,
    PdfText or None). A fetched PDF is also read here, so a slow OCR job
    overlaps other fetches instead of holding up the main thread.
    """
    try:
        result = fetcher.fetch(url)
    except FetchError as e:
        return e, None
    except Exception as e:  # noqa: BLE001
        logger.warning("Unexpected error fetching %s: %s", url, e, exc_info=True)
        return FetchError(f"unexpected error: {e.__class__.__name__}", permanent=False), None
    if result.content_type != PDF:
        return result, None
    try:
        pdf = extract_pdf(result.body, time_left=time_left)
    except Exception as e:  # noqa: BLE001  (handle_outcome reads it again and reports the error)
        logger.warning("Could not read PDF %s: %s", url, e, exc_info=True)
        return result, None
    logger.info("Read PDF %s: %s", url, json.dumps(pdf.summary()))
    return result, pdf


def _record_failure(store, item: dict, error: FetchError, data_source_id: str):
    source_url = item["source_url"]
    if error.permanent:
        # The content behind this URL is gone or not allowed: drop the canonical
        # cache and fetched row chunks everywhere, but preserve standalone row 0.
        store.delete_source(source_url)
        store.drop_fetched_content(source_url)
        store.mark_rows(source_url, "failed", data_source_id=None, reason=error.reason, http_status=error.http_status)
    else:
        reason = error.reason
        if store.source_exists(source_url):
            reason += "; previously indexed content kept"
        store.mark_rows(source_url, "failed", data_source_id=data_source_id, reason=reason,
                        http_status=error.http_status)


def handle_outcome(
    store,
    item: dict,
    outcome,
    *,
    data_source_id: str,
    session_id: str,
    time_left=None,
    write=None,
    pdf=None,
) -> str:
    """
    Index a fetched document (or record why not) and commit. Returns the rows'
    new status. `pdf` is a fetched PDF's text if _fetch already read it.
    """
    time_left = time_left or (lambda: _DEFAULT_LAMBDA_SECONDS)
    row_write = write
    canonical_write = write or write_chunks
    if isinstance(outcome, FetchError):
        _record_failure(store, item, outcome, data_source_id)
        store.commit()
        return "failed"

    try:
        if outcome.content_type == PDF and pdf is None:
            pdf = extract_pdf(outcome.body, time_left=time_left)
        title, chunks = build_chunks(outcome, pdf)
        reason = pdf.empty_reason() if pdf is not None else "no extractable text (empty page)"
    except Exception as e:  # noqa: BLE001  (malformed HTML/PDF)
        logger.warning("Could not extract %s: %s", item["normalized_url"], e, exc_info=True)
        title, chunks, reason = "", [], f"could not extract text: {e.__class__.__name__}"
    if not chunks:
        # A PDF that OCR couldn't read right now (Textract error, out of time)
        # keeps what it indexed before, like a transient fetch error.
        permanent = not (pdf is not None and pdf.retryable)
        error = FetchError(reason, permanent=permanent, http_status=outcome.http_status)
        _record_failure(store, item, error, data_source_id)
        store.commit()
        return "failed"

    source_url = item["source_url"]
    try:
        source_id = store.upsert_link_source(
            source_url,
            name=title or item["normalized_url"],
            metadata={
                "citation_url": item["normalized_url"],
                "final_url": outcome.url,
                "content_type": outcome.content_type,
                "http_status": outcome.http_status,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "fetch_session": session_id,
                "retrieval_hidden": True,
            },
        )
        canonical_write(store.connection, source_id, chunks)
        store.commit()
        materialize_source_rows(
            store,
            source_url,
            data_source_id,
            canonical_title=title,
            canonical_chunks=chunks,
            time_left=time_left,
            http_status=outcome.http_status,
            content_type=outcome.content_type,
            fetched=True,
            write=row_write,
        )
        return "success"
    except Exception as e:  # noqa: BLE001
        store.rollback()
        logger.error("Indexing %s failed: %s", item["normalized_url"], e, exc_info=True)
        store.mark_rows(source_url, "failed", data_source_id=data_source_id,
                        reason=f"indexing failed: {e.__class__.__name__}"[:500],
                        http_status=outcome.http_status, content_type=outcome.content_type)
        store.commit()
        return "failed"


def run_link_phase(store, fetcher, *, data_source_id: str, run_id: str, session_id: str, time_left,
                   concurrency: int = 8, write=None) -> dict:
    """
    Fetch + index this CSV's pending URLs until done or out of time.
    Returns counts plus "aborted" if the run stopped being active mid-way.
    """
    pending = iter(store.pending_urls(data_source_id))
    reserve = fetcher.limits.total_timeout + _EMBED_RESERVE_SECONDS
    if ocr_enabled():
        reserve += _OCR_RESERVE_SECONDS
    stats = {
        "success": 0,
        "failed": 0,
        "reused": 0,
        "rows_processed": 0,
        "rows_indexed": 0,
        "rows_with_fetched_content": 0,
        "aborted": False,
    }

    if not store.run_is_active(run_id):
        stats["aborted"] = True
        return stats

    row_stats = index_pending_rows(store, data_source_id, time_left, write=write)
    stats["rows_processed"] += row_stats["processed"]
    stats["rows_indexed"] += row_stats["indexed"]
    stats["rows_with_fetched_content"] += row_stats["fetched"]
    if not store.run_is_active(run_id):
        stats["aborted"] = True
        return stats
    if store.count_index_pending(data_source_id):
        return stats

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        in_flight: dict = {}

        def fill():
            while not stats["aborted"] and len(in_flight) < concurrency and time_left() > reserve:
                item = next(pending, None)
                if item is None:
                    return
                earlier = store.session_fetch(item["source_url"], session_id)
                if earlier:
                    # Another CSV fetched this URL during the same sync. Copy
                    # its canonical chunks into this bounded set of row sources.
                    title, chunks = store.canonical_content(item["source_url"])
                    materialize_source_rows(
                        store,
                        item["source_url"],
                        data_source_id,
                        canonical_title=title,
                        canonical_chunks=chunks,
                        time_left=time_left,
                        reason="already fetched in this sync",
                        write=write,
                        **earlier,
                    )
                    stats["reused"] += 1
                    continue
                in_flight[pool.submit(_fetch, fetcher, item["normalized_url"], time_left)] = item

        fill()
        while in_flight:
            done, _ = wait(in_flight, return_when=FIRST_COMPLETED)
            for future in done:
                item = in_flight.pop(future)
                if stats["aborted"]:
                    continue
                if not store.run_is_active(run_id):
                    # Deleted or reset while crawling: write nothing more.
                    stats["aborted"] = True
                    continue
                outcome, pdf = future.result()
                status = handle_outcome(
                    store,
                    item,
                    outcome,
                    data_source_id=data_source_id,
                    session_id=session_id,
                    time_left=time_left,
                    write=write,
                    pdf=pdf,
                )
                stats[status] += 1
            fill()

    return stats


# ── Entry point ───────────────────────────────────────────────────────────────

def process_csv_links(event, connection, context=None) -> dict:
    run_id = event["ingestion_run_id"]
    data_source_id = event["data_source_id"]
    session_id = event.get("sync_session_id") or run_id
    continuation = int(event.get("continuation") or 0)
    store = LinkStore(connection)

    if not store.run_is_active(run_id):
        return {"skipped": True, "reason": "ingestion run is no longer crawling links"}

    started = time.monotonic()
    if context is not None and hasattr(context, "get_remaining_time_in_millis"):
        time_left = lambda: context.get_remaining_time_in_millis() / 1000  # noqa: E731
    else:
        time_left = lambda: _DEFAULT_LAMBDA_SECONDS - (time.monotonic() - started)  # noqa: E731

    try:
        stats = run_link_phase(
            store,
            LinkFetcher(FetchLimits.from_env()),
            data_source_id=data_source_id,
            run_id=run_id,
            session_id=session_id,
            time_left=time_left,
            concurrency=_int_env("LINK_CONCURRENCY", 8),
        )
    except Exception as e:  # noqa: BLE001
        store.rollback()
        logger.error("Link phase for run %s failed: %s", run_id, e, exc_info=True)
        stats = {"error": str(e)[:500]}

    if stats.get("aborted"):
        store.delete_unreferenced_sources()
        store.commit()
        return {"aborted": True, **stats}

    remaining_fetch = store.count_pending(data_source_id)
    remaining_index = store.count_index_pending(data_source_id)
    remaining = remaining_fetch + remaining_index
    if remaining:
        if continuation < _int_env("LINK_MAX_CONTINUATIONS", 20):
            try:
                invoke_link_worker(ingestion_run_id=run_id, data_source_id=data_source_id,
                                   sync_session_id=session_id, continuation=continuation + 1,
                                   actor=actor_from_event(event))
                logger.info(
                    "Link phase for run %s continues: %d fetch row(s), %d index row(s) pending",
                    run_id,
                    remaining_fetch,
                    remaining_index,
                )
                return {
                    "continued": True,
                    "remaining": remaining,
                    "remaining_fetch": remaining_fetch,
                    "remaining_index": remaining_index,
                    **stats,
                }
            except Exception as e:  # noqa: BLE001
                logger.error("Could not continue link phase for run %s: %s", run_id, e, exc_info=True)
                store.fail_pending(data_source_id, "link crawl could not continue")
                store.fail_index_pending(data_source_id, "row indexing could not continue")
        else:
            store.fail_pending(data_source_id, "link crawl ran out of time before reaching this URL")
            store.fail_index_pending(data_source_id, "row indexing ran out of time")

    summary = store.summary(data_source_id)
    store.finalize_run(run_id, summary)
    store.delete_unreferenced_sources()
    store.commit()
    logger.info("Link phase for run %s completed: %s", run_id, summary)
    return {"completed": True, "summary": summary, **stats}
