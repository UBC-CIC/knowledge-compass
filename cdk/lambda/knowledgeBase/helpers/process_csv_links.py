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
  re-embeds nothing. The linking rows' other columns are attached to the
  source (metadata.rows) and every chunk (metadata.csv_rows);
- a failed fetch only fails its rows. A permanent failure (dead link,
  blocked, disallowed, unsupported) removes previously indexed content for
  that URL; a transient one (timeout, 5xx) keeps it;
- no new URL is started once less than one fetch + embedding margin of
  Lambda time is left; the worker then re-invokes itself for the rest (up
  to LINK_MAX_CONTINUATIONS times) before finalizing the run.
"""

import json
import logging
import os
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timezone
from urllib.parse import unquote, urlsplit

from helpers.csv_links import delete_unreferenced_link_sources, invoke_link_worker
from helpers.html_extract import extract_html
from helpers.link_fetcher import HTML, FetchError, FetchLimits, LinkFetcher
from helpers.process_document_batch import (
    _chunk_document_text,
    _chunk_markdown,
    _extract_pdf_text,
    write_chunks,
)

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Time kept free for embedding + writing the last in-flight pages.
_EMBED_RESERVE_SECONDS = 60
_MAX_ROWS_IN_METADATA = 20
_DEFAULT_LAMBDA_SECONDS = 600


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
            """,
            (source_url, session_id),
        )
        if not row:
            return None
        return {"http_status": int(row[0]) if row[0] else None, "content_type": row[1]}

    def source_exists(self, source_url: str) -> bool:
        return self._one("SELECT 1 FROM sources WHERE url = %s", (source_url,)) is not None

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
        return delete_unreferenced_link_sources(self.connection)


# ── Indexing ──────────────────────────────────────────────────────────────────

def _pdf_title(url: str) -> str:
    parts = urlsplit(url)
    name = unquote(parts.path.rstrip("/").rsplit("/", 1)[-1])
    return name or parts.hostname or url


def build_chunks(result) -> tuple[str, list]:
    """(title, chunks) for a fetched HTML page or PDF."""
    if result.content_type == HTML:
        title, text = extract_html(result.body, result.charset)
        return title, _chunk_markdown(text)
    title = _pdf_title(result.url)
    return title, _chunk_document_text(_extract_pdf_text(result.body), title)


def _fetch(fetcher, url: str):
    """Runs on a pool thread: never raises, returns a FetchResult or FetchError."""
    try:
        return fetcher.fetch(url)
    except FetchError as e:
        return e
    except Exception as e:  # noqa: BLE001
        logger.warning("Unexpected error fetching %s: %s", url, e, exc_info=True)
        return FetchError(f"unexpected error: {e.__class__.__name__}", permanent=False)


def _record_failure(store, item: dict, error: FetchError, data_source_id: str):
    source_url = item["source_url"]
    if error.permanent:
        # The content behind this URL is gone or not allowed: drop it for every CSV linking here.
        store.delete_source(source_url)
        store.mark_rows(source_url, "failed", data_source_id=None, reason=error.reason, http_status=error.http_status)
    else:
        reason = error.reason
        if store.source_exists(source_url):
            reason += "; previously indexed content kept"
        store.mark_rows(source_url, "failed", data_source_id=data_source_id, reason=reason,
                        http_status=error.http_status)


def handle_outcome(store, item: dict, outcome, *, data_source_id: str, session_id: str, write=None) -> str:
    """Index a fetched document (or record why not) and commit. Returns the rows' new status."""
    write = write or write_chunks
    if isinstance(outcome, FetchError):
        _record_failure(store, item, outcome, data_source_id)
        store.commit()
        return "failed"

    try:
        title, chunks = build_chunks(outcome)
        reason = "no extractable text (empty page, or a scanned/image-only PDF)"
    except Exception as e:  # noqa: BLE001  (malformed HTML/PDF)
        logger.warning("Could not extract %s: %s", item["normalized_url"], e, exc_info=True)
        title, chunks, reason = "", [], f"could not extract text: {e.__class__.__name__}"
    if not chunks:
        error = FetchError(reason, permanent=True, http_status=outcome.http_status)
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
            },
        )
        write(store.connection, source_id, chunks)
        store.mark_rows(source_url, "success", data_source_id=data_source_id,
                        http_status=outcome.http_status, content_type=outcome.content_type, fetched=True)
        store.refresh_source_rows(source_url)
        store.commit()
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
    stats = {"success": 0, "failed": 0, "reused": 0, "aborted": False}

    with ThreadPoolExecutor(max_workers=max(1, concurrency)) as pool:
        in_flight: dict = {}

        def fill():
            while not stats["aborted"] and len(in_flight) < concurrency and time_left() > reserve:
                item = next(pending, None)
                if item is None:
                    return
                earlier = store.session_fetch(item["source_url"], session_id)
                if earlier:
                    # Another CSV fetched this URL during the same sync: reuse it.
                    store.mark_rows(item["source_url"], "success", data_source_id=data_source_id,
                                    reason="already fetched in this sync", **earlier)
                    store.refresh_source_rows(item["source_url"])
                    store.commit()
                    stats["reused"] += 1
                    continue
                in_flight[pool.submit(_fetch, fetcher, item["normalized_url"])] = item

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
                status = handle_outcome(store, item, future.result(), data_source_id=data_source_id,
                                        session_id=session_id, write=write)
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

    remaining = store.count_pending(data_source_id)
    if remaining:
        if continuation < _int_env("LINK_MAX_CONTINUATIONS", 20):
            try:
                invoke_link_worker(ingestion_run_id=run_id, data_source_id=data_source_id,
                                   sync_session_id=session_id, continuation=continuation + 1)
                logger.info("Link phase for run %s continues: %d row(s) pending", run_id, remaining)
                return {"continued": True, "remaining": remaining, **stats}
            except Exception as e:  # noqa: BLE001
                logger.error("Could not continue link phase for run %s: %s", run_id, e, exc_info=True)
                store.fail_pending(data_source_id, "link crawl could not continue")
        else:
            store.fail_pending(data_source_id, "link crawl ran out of time before reaching this URL")

    summary = store.summary(data_source_id)
    store.finalize_run(run_id, summary)
    store.delete_unreferenced_sources()
    store.commit()
    logger.info("Link phase for run %s completed: %s", run_id, summary)
    return {"completed": True, "summary": summary, **stats}
