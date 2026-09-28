"""
process_document_batch.py

pgvector ingestion path for CSV/Markdown/single-document uploads (the
counterpart to process_crawler_batch.py, which only handles website/video).

API Gateway enforces a hard 29s integration timeout, but chunking + embedding
a document can take much longer than that, so this module splits into two
halves:

- trigger_document_batch(): called synchronously from start_ingestion_job.py
  (inside the API-Gateway-fronted request). It only marks the queued
  csv/markdown/json/document runs 'running' and fires an asynchronous
  ("Event") self-invocation of this same Lambda — both fast, well under 29s.
- trigger_uploaded_document(): the single-document counterpart, called
  synchronously from stage_data_sources.py right after a document is staged,
  so embedding starts immediately without an admin having to click Sync
  (mirrors how video auto-starts transcription).
- process_document_batch(): the actual worker. It runs OUTSIDE the API
  Gateway request lifecycle (invoked via the "task": "process_document_batch"
  branch in main.py), so it can take as long as the Lambda's configured
  timeout allows. It doesn't start a run with under
  _MIN_SECONDS_TO_START_RUN left: the remaining runs (and a PDF whose
  Textract job is still running, which pdf_text.py picks up again by content
  hash) are handed to a fresh invocation, up to _MAX_CONTINUATIONS times.

State machine reused unchanged: stage_data_sources -> 'pending';
start_ingestion_job / trigger_uploaded_document promote/mark -> 'running'
(via 'queued' for the multi-file sync path); process_document_batch marks ->
'completed' | 'failed'.

CSV/Markdown files have no enforced content schema (see
Docs/KNOWLEDGE_BASE_DOCUMENTATION.md) — they are chunked as plain text:
- Markdown: split into sections by heading (#/##/###), then into ~300-word
  chunks with sentence-boundary overlap (mirrors the website crawler).
- CSV: parsed with csv.DictReader (schema-agnostic), rows rendered as
  "column: value" lines and grouped into ~175-word chunks of whole rows,
  with content-defined boundaries (see _chunk_csv) so editing, adding or
  removing a row only changes the chunk(s) around it.

A CSV staged with a url_column also has the pages/PDFs its rows link to
fetched and indexed (see csv_links.py / process_csv_links.py): after its own
chunks are committed the run is handed to that link phase, which finalizes
it. Without url_column the CSV path is unchanged.

Re-ingesting a source re-embeds only chunks whose text is new to it: a chunk
already stored at any index (e.g. shifted by an inserted row) is moved with
its stored embedding instead of being sent to Bedrock again.
- Document (PDF/DOCX/TXT): text is extracted (Amazon Textract with a pypdf
  fallback, see pdf_text.py / python-docx / plain decode) and split into
  ~300-word chunks with sentence-boundary overlap, same as markdown but with
  no heading structure to key off of.

The paired `{file}.metadata.json` sidecar (Bedrock KB convention) has no
content of its own to embed; its own data_sources row is marked 'completed'
immediately. Its content is instead read (best-effort) and attached to the
primary document's `sources.metadata` so it isn't silently discarded now
that Bedrock is no longer the one reading it.
"""

import csv
import hashlib
import io
import json
import logging
import os
import re
import time

import boto3
from docx import Document as DocxDocument

from helpers.csv_links import start_link_phase
from helpers.pdf_text import TextractPending, extract_pdf
from helpers.upload_identity import source_url_for

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
EMBED_MODEL_ID = "cohere.embed-english-v3"
EMBED_BATCH_SIZE = 96
# Same shared execution role as textGen already grants bedrock:InvokeModel /
# s3:GetObject-PutObject-DeleteObject on the ingest bucket; only the
# self-invoke permission below is new.
LAMBDA_FUNCTION_NAME = os.environ.get("LAMBDA_FUNCTION_NAME", "")

_MIN_CHUNK_WORDS = 20
# ~300 words of written text (~6 chars/word) plus the chunk label stays under
# the 2048-char Cohere input cap in _embed_texts, so the whole chunk is embedded.
_MAX_WORDS_PER_CHUNK = 300
# CSV row groups: at least this many words, then each row closes the group with
# probability ~ its words / _CSV_AVG_EXTRA_WORDS (~175 words on average). With
# these values a single-row edit/insert/delete changes 1-2 chunks ~85% of the
# time; the tail comes from forced cuts at _MAX_WORDS_PER_CHUNK re-balancing
# the next group or two.
_CSV_MIN_GROUP_WORDS = 100
_CSV_AVG_EXTRA_WORDS = 100
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")

# A run isn't started with less time than this left in the invocation (enough
# for a short OCR wait plus pdf_text.RESERVE_SECONDS of chunking/embedding);
# the rest continue in a fresh invocation, at most _MAX_CONTINUATIONS times.
_MIN_SECONDS_TO_START_RUN = 120
_MAX_CONTINUATIONS = 10
_DEFAULT_LAMBDA_SECONDS = 600

s3_client = boto3.client("s3", region_name=REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)


# ── Chunking ──────────────────────────────────────────────────────────────────

def _split_long(text: str, max_words: int, overlap_sentences: int = 2) -> list:
    if len(text.split()) <= max_words:
        return [(text, "")]

    sentences = re.split(r"(?<=[.!?])\s+", text)
    parts: list = []
    buf_sents: list = []
    part_n = 1

    for sent in sentences:
        buf_words = sum(len(s.split()) for s in buf_sents)
        if buf_words + len(sent.split()) > max_words and buf_sents:
            parts.append((" ".join(buf_sents), f" [part {part_n}]"))
            part_n += 1
            buf_sents = buf_sents[-overlap_sentences:] + [sent]
        else:
            buf_sents.append(sent)

    if buf_sents:
        parts.append((" ".join(buf_sents), f" [part {part_n}]" if parts else ""))
    return parts


def _parse_markdown_sections(text: str) -> list:
    heading_stack: list = []
    sections: list = []
    current_lines: list = []

    def flush():
        body = "\n".join(l for l in current_lines if l.strip())
        if body and len(body.split()) >= _MIN_CHUNK_WORDS:
            sections.append((" > ".join(heading_stack), body))

    for line in text.splitlines():
        m = _HEADING_RE.match(line.strip())
        if m:
            flush()
            current_lines = []
            level = len(m.group(1))
            title = m.group(2).strip()
            heading_stack = (heading_stack[: level - 1] + [title]) if title else heading_stack[: level - 1]
        else:
            current_lines.append(line)
    flush()

    if sections:
        return sections
    return [("", text)] if text.strip() else []


def _chunk_markdown(text: str, max_words: int = _MAX_WORDS_PER_CHUNK) -> list:
    chunks = []
    idx = 0
    for heading_path, body in _parse_markdown_sections(text):
        for sub_body, part_suffix in _split_long(body, max_words, overlap_sentences=2):
            if len(sub_body.split()) < _MIN_CHUNK_WORDS:
                continue
            label = f"{heading_path}{part_suffix}" if heading_path else f"(intro){part_suffix}"
            embed_text = f"{label}\n\n{sub_body}" if heading_path else sub_body
            chunks.append({
                "heading_path": label,
                "chunk_index": idx,
                "text": embed_text,
                "body": sub_body,
                "word_count": len(sub_body.split()),
                "content_hash": hashlib.sha256(sub_body.strip().encode()).hexdigest()[:16],
            })
            idx += 1
    return chunks


def _row_ends_group(rendered: str, rendered_words: int) -> bool:
    """
    Whether a CSV row closes its chunk, decided by the row's own content only:
    a hash-derived draw in [0, 1) against the row's share of
    _CSV_AVG_EXTRA_WORDS. Boundaries therefore stay put when unrelated rows are
    edited, inserted or deleted (content-defined chunking), so a one-row edit
    re-embeds about one chunk instead of every chunk after it.
    """
    draw = int(hashlib.sha256(rendered.encode()).hexdigest()[:8], 16) / 0x100000000
    return draw < rendered_words / _CSV_AVG_EXTRA_WORDS


def _chunk_csv(raw_bytes: bytes, max_words: int = _MAX_WORDS_PER_CHUNK) -> list:
    """
    Group whole rows into chunks of ~175 words (never splitting a row), with
    boundaries chosen by _row_ends_group once a group has
    _CSV_MIN_GROUP_WORDS, or forced before a row that would pass max_words.
    """
    text = raw_bytes.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = reader.fieldnames or []

    chunks: list = []
    idx = 0
    buf_rows: list = []
    buf_words = 0
    row_start = 1
    row_end = 0
    row_num = 0

    def render_row(row: dict) -> str:
        return "\n".join(
            f"{k}: {(row.get(k) or '').strip()}" for k in fieldnames if (row.get(k) or "").strip()
        )

    def emit():
        nonlocal idx, buf_rows, buf_words
        body = "\n\n".join(buf_rows)
        buf_rows, buf_words = [], 0
        if not body.strip():
            return
        chunks.append({
            "heading_path": f"rows {row_start}-{row_end}",
            "chunk_index": idx,
            "text": body,
            "body": body,
            "word_count": len(body.split()),
            "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
        })
        idx += 1

    for row in reader:
        row_num += 1
        rendered = render_row(row)
        if not rendered:
            continue
        rendered_words = len(rendered.split())
        if buf_rows and buf_words + rendered_words > max_words:
            emit()
        if not buf_rows:
            row_start = row_num
        buf_rows.append(rendered)
        buf_words += rendered_words
        row_end = row_num
        if buf_words >= _CSV_MIN_GROUP_WORDS and _row_ends_group(rendered, rendered_words):
            emit()

    if buf_rows:
        emit()

    return chunks


def _is_pdf(file_name: str) -> bool:
    return (file_name or "").lower().endswith(".pdf")


def _extract_docx_text(raw_bytes: bytes) -> str:
    doc = DocxDocument(io.BytesIO(raw_bytes))
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


def _extract_txt_text(raw_bytes: bytes) -> str:
    return raw_bytes.decode("utf-8", errors="replace")


def _extract_document_text(file_name: str, raw_bytes: bytes) -> str:
    """Text of a DOCX/TXT (or, without S3/time context, a PDF) document."""
    lower_name = (file_name or "").lower()
    if lower_name.endswith(".pdf"):
        return extract_pdf(raw_bytes).text
    if lower_name.endswith(".docx"):
        return _extract_docx_text(raw_bytes)
    if lower_name.endswith(".txt"):
        return _extract_txt_text(raw_bytes)
    raise RuntimeError(f"Unsupported document file type: {file_name}")


def _chunk_document_text(text: str, doc_name: str, max_words: int = _MAX_WORDS_PER_CHUNK) -> list:
    chunks = []
    idx = 0
    for body, part_suffix in _split_long(text, max_words, overlap_sentences=2):
        if len(body.split()) < _MIN_CHUNK_WORDS:
            continue
        label = f"{doc_name}{part_suffix}"
        chunks.append({
            "heading_path": label,
            "chunk_index": idx,
            "text": f"{label}\n\n{body}",
            "body": body,
            "word_count": len(body.split()),
            "content_hash": hashlib.sha256(body.strip().encode()).hexdigest()[:16],
        })
        idx += 1
    return chunks


# ── Embeddings ────────────────────────────────────────────────────────────────

def _embedding_input(text: str) -> str:
    """The exact text sent to Cohere, used as the embedding reuse key."""
    if len(text) <= 2048:
        return text
    return text[:2048].rsplit(" ", 1)[0]


def _embed_texts(texts: list) -> list:
    """Cohere embed-english-v3 via Bedrock, batched at 96 texts/call (API limit)."""
    texts = [_embedding_input(text) for text in texts]
    embeddings: list = []
    for i in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[i : i + EMBED_BATCH_SIZE]
        response = bedrock_runtime.invoke_model(
            modelId=EMBED_MODEL_ID,
            body=json.dumps({"texts": batch, "input_type": "search_document", "truncate": "END"}),
            contentType="application/json",
            accept="application/json",
        )
        result = json.loads(response["body"].read())
        embeddings.extend(result["embeddings"])
    return embeddings


# ── DB helpers ────────────────────────────────────────────────────────────────

def _latest_queued_document_runs(connection) -> list:
    """Latest 'queued' run per data source, for csv/markdown/json/document types."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            SELECT lr.id, lr.data_source_id, ds.name, ds.type, ds.metadata
            FROM latest_runs lr
            JOIN data_sources ds ON ds.id = lr.data_source_id
            WHERE lr.rn = 1
              AND lr.status = 'queued'::ingestion_status
              AND ds.type = ANY(ARRAY['csv', 'markdown', 'json', 'document']::data_source_type[])
            ORDER BY ds.created_at ASC, ds.id ASC
            """
        )
        return [
            {"ingestion_run_id": str(r[0]), "data_source_id": str(r[1]), "name": r[2], "type": r[3], "metadata": r[4] or {}}
            for r in cursor.fetchall()
        ]


def _running_document_runs(connection) -> list:
    """
    Runs this module marked 'running' that still need to be finalized. CSV
    runs whose link crawl is in progress belong to process_csv_links.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT ir.id, ir.data_source_id, ds.name, ds.type, ds.metadata, ir.metadata
            FROM ingestion_runs ir
            JOIN data_sources ds ON ds.id = ir.data_source_id
            WHERE ir.status = 'running'::ingestion_status
              AND ds.type = ANY(ARRAY['csv', 'markdown', 'json', 'document']::data_source_type[])
              AND ir.metadata->>'backend' = 'pgvector_document'
              AND COALESCE(ir.metadata->>'link_phase', '') <> 'running'
            ORDER BY ds.created_at ASC, ds.id ASC
            """
        )
        return [
            {
                "ingestion_run_id": str(r[0]),
                "data_source_id": str(r[1]),
                "name": r[2],
                "type": r[3],
                "metadata": r[4] or {},
                "run_metadata": r[5] or {},
            }
            for r in cursor.fetchall()
        ]


def _mark_runs_running(connection, run_ids: list, sync_session_id: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET status = 'running'::ingestion_status,
                started_at = now(),
                metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = ANY(%s::uuid[])
            """,
            (json.dumps({"backend": "pgvector_document", "sync_session_id": sync_session_id}), run_ids),
        )


def _finish_run(connection, run_id: str, status: str, *, chunks_upserted=0, chunks_deleted=0, error_message=None,
                metadata: dict | None = None):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET status = %s::ingestion_status,
                chunks_upserted = %s,
                chunks_deleted = %s,
                pages_crawled = 1,
                error_message = %s,
                finished_at = now(),
                completed_at = now(),
                metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid
            """,
            (status, chunks_upserted, chunks_deleted, error_message, json.dumps(metadata or {}), run_id),
        )


def _fail_runs(connection, run_ids: list, error_message: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET status = 'failed'::ingestion_status,
                error_message = %s,
                completed_at = now(),
                finished_at = now()
            WHERE id = ANY(%s::uuid[])
            """,
            (error_message[:1000], run_ids),
        )


def _upsert_source(connection, *, url: str, name: str, metadata: dict | None = None) -> str:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO sources (name, url, source_type, metadata)
            VALUES (%s, %s, 'document', %s::jsonb)
            ON CONFLICT (url) DO UPDATE SET
              name        = EXCLUDED.name,
              source_type = EXCLUDED.source_type,
              metadata    = EXCLUDED.metadata,
              updated_at  = now()
            RETURNING id
            """,
            (name, url, json.dumps(metadata or {})),
        )
        return str(cursor.fetchone()[0])


def _chunk_metadata(chunk: dict) -> dict:
    """Canonical metadata persisted with a chunk and compared on re-ingest."""
    metadata = dict(chunk.get("metadata") or {})
    if chunk.get("heading_path") is not None:
        metadata.setdefault("heading_path", chunk.get("heading_path"))
    return metadata


def _metadata_state(metadata: dict | None) -> str:
    return json.dumps(metadata or {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _chunk_state(chunk: dict) -> tuple:
    """What must match a stored chunk for it to be left untouched."""
    return (chunk["content_hash"], _embed_text_md5(chunk), _metadata_state(_chunk_metadata(chunk)))


def _embed_text_md5(chunk: dict) -> str:
    # Same digest as Postgres md5(embed_text), which is stored as chunk["text"].
    return hashlib.md5(chunk["text"].encode()).hexdigest()


def _existing_chunk_states(connection, source_id: str) -> dict:
    """chunk_index -> _chunk_state of what is stored there."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT chunk_index, content_hash, md5(embed_text), metadata
            FROM chunks
            WHERE source_id = %s::uuid
            """,
            (source_id,),
        )
        return {row[0]: (row[1], row[2], _metadata_state(row[3])) for row in cursor.fetchall()}


def _reusable_embeddings(connection, source_id: str, chunks: list) -> dict:
    """
    Stored embeddings (as pgvector text) for chunk texts this source already
    holds at ANY index, keyed by (content_hash, md5(embed_text)). A row inserted
    or deleted shifts every later chunk_index; this lets those shifted chunks
    keep their embedding instead of being re-embedded. Read before any writes,
    since the upserts below overwrite chunks by index.
    """
    hashes = sorted({c["content_hash"] for c in chunks})
    if not hashes:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DISTINCT ON (content_hash, md5(embed_text))
                   content_hash, md5(embed_text), embedding::text
            FROM chunks
            WHERE source_id = %s::uuid
              AND content_hash = ANY(%s)
              AND embedding IS NOT NULL
            """,
            (source_id, hashes),
        )
        return {(row[0], row[1]): row[2] for row in cursor.fetchall()}


def _globally_reusable_embeddings(connection, chunks: list) -> dict:
    """Reuse exact embed_text vectors already present anywhere in this corpus."""
    hashes = sorted({chunk["content_hash"] for chunk in chunks})
    if not hashes:
        return {}
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT DISTINCT ON (content_hash, md5(embed_text))
                   content_hash, md5(embed_text), embedding::text
            FROM chunks
            WHERE content_hash = ANY(%s)
              AND embedding IS NOT NULL
            """,
            (hashes,),
        )
        return {(row[0], row[1]): row[2] for row in cursor.fetchall()}


def _upsert_chunk(connection, source_id: str, chunk: dict, embedding):
    """`embedding` is a float list (fresh) or pgvector text (reused)."""
    embedding_str = embedding if isinstance(embedding, str) else "[" + ",".join(str(x) for x in embedding) + "]"
    metadata = json.dumps(_chunk_metadata(chunk), sort_keys=True, ensure_ascii=False)
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO chunks (
              source_id, chunk_index, body, embed_text,
              word_count, content_hash, embedding, metadata, updated_at
            )
            VALUES (%s::uuid, %s, %s, %s, %s, %s, %s::vector, %s::jsonb, now())
            ON CONFLICT (source_id, chunk_index) DO UPDATE SET
              body         = EXCLUDED.body,
              embed_text   = EXCLUDED.embed_text,
              word_count   = EXCLUDED.word_count,
              content_hash = EXCLUDED.content_hash,
              embedding    = EXCLUDED.embedding,
              metadata     = EXCLUDED.metadata,
              updated_at   = now()
            """,
            (
                source_id,
                chunk["chunk_index"],
                chunk["body"],
                chunk["text"],
                chunk["word_count"],
                chunk["content_hash"],
                embedding_str,
                metadata,
            ),
        )


def _delete_stale_chunks(connection, source_id: str, current_indices: list) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM chunks WHERE source_id = %s::uuid AND chunk_index != ALL(%s)",
            (source_id, current_indices),
        )
        return cursor.rowcount


def write_chunk_sets(connection, chunk_sets: list[tuple[str, list]]) -> dict:
    """
    Store complete chunk sets for multiple sources in one embedding batch.

    Existing vectors are reused within each source whenever the effective
    embedded text is unchanged, including metadata-only updates. New embedding
    inputs are deduplicated across the supplied sources before Cohere is called.
    """
    changed_by_source: dict[str, list] = {}
    reusable_by_source: dict[str, dict] = {}
    all_changed: list = []

    for source_id, chunks in chunk_sets:
        existing_states = _existing_chunk_states(connection, source_id)
        changed = [chunk for chunk in chunks if existing_states.get(chunk["chunk_index"]) != _chunk_state(chunk)]
        reusable = _reusable_embeddings(connection, source_id, changed)
        changed_by_source[source_id] = changed
        reusable_by_source[source_id] = reusable
        all_changed.extend(changed)

    globally_reusable = _globally_reusable_embeddings(connection, all_changed)
    fresh_inputs: dict[str, None] = {}
    for source_id, _ in chunk_sets:
        reusable = reusable_by_source[source_id]
        for chunk in changed_by_source[source_id]:
            reuse_key = (chunk["content_hash"], _embed_text_md5(chunk))
            if reuse_key not in reusable and reuse_key not in globally_reusable:
                fresh_inputs.setdefault(_embedding_input(chunk["text"]), None)

    unique_inputs = list(fresh_inputs)
    fresh_embeddings = dict(zip(unique_inputs, _embed_texts(unique_inputs))) if unique_inputs else {}

    written = 0
    deleted = 0
    for source_id, chunks in chunk_sets:
        reusable = reusable_by_source[source_id]
        for chunk in changed_by_source[source_id]:
            reuse_key = (chunk["content_hash"], _embed_text_md5(chunk))
            embedding = reusable.get(reuse_key)
            if embedding is None:
                embedding = globally_reusable.get(reuse_key)
            if embedding is None:
                embedding = fresh_embeddings[_embedding_input(chunk["text"])]
            _upsert_chunk(connection, source_id, chunk, embedding)
            written += 1
        deleted += _delete_stale_chunks(connection, source_id, [chunk["chunk_index"] for chunk in chunks])

    return {"written": written, "embedded": len(unique_inputs), "deleted": deleted}


def write_chunks(connection, source_id: str, chunks: list) -> dict:
    """Store one source's complete chunk set using the batched writer."""
    return write_chunk_sets(connection, [(source_id, chunks)])


def _start_link_phase(connection, run: dict, raw_bytes: bytes, counts: dict) -> dict:
    """Links never fail the CSV run: a link-phase error is recorded on the run instead."""
    try:
        return start_link_phase(
            connection,
            run=run,
            raw_bytes=raw_bytes,
            chunks_upserted=counts["written"],
            chunks_deleted=counts["deleted"],
        )
    except Exception as e:  # noqa: BLE001
        connection.rollback()
        logger.error("Link phase failed for run %s: %s", run["ingestion_run_id"], e, exc_info=True)
        return {"deferred": False, "metadata": {"link_error": f"link crawl failed: {e}"[:500]}}


def _load_companion_metadata(meta: dict) -> dict:
    """Best-effort read of the paired {file}.metadata.json sidecar's content."""
    bucket = meta.get("companion_s3_bucket")
    key = meta.get("companion_s3_key")
    if not bucket or not key:
        return {}
    try:
        raw = s3_client.get_object(Bucket=bucket, Key=key)["Body"].read()
        return json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not read companion metadata s3://%s/%s: %s", bucket, key, e)
        return {}


# ── Entry points ──────────────────────────────────────────────────────────────

def trigger_document_batch(event, connection, sync_session_id: str) -> dict:
    """
    Mark queued csv/markdown/json runs 'running' and fire an async worker
    invocation. Must stay fast: this runs inside the API-Gateway-fronted
    /admin/data_sources/sync request, which has a 29s hard timeout.
    """
    queued = _latest_queued_document_runs(connection)
    if not queued:
        return {"started": False, "reason": "no queued csv/markdown/json sources"}

    if not LAMBDA_FUNCTION_NAME:
        logger.error("LAMBDA_FUNCTION_NAME not set; cannot start document ingestion")
        return {"started": False, "reason": "document ingestion is not configured (missing LAMBDA_FUNCTION_NAME)"}

    run_ids = [q["ingestion_run_id"] for q in queued]
    _mark_runs_running(connection, run_ids, sync_session_id)
    connection.commit()

    try:
        lambda_client.invoke(
            FunctionName=LAMBDA_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({"task": "process_document_batch", "sync_session_id": sync_session_id}).encode("utf-8"),
        )
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to invoke document batch worker: %s", e, exc_info=True)
        _fail_runs(connection, run_ids, f"Failed to start document ingestion: {e}")
        connection.commit()
        return {"started": False, "reason": "failed to invoke document batch worker"}

    return {"started": True, "queued_count": len(queued), "run_ids": run_ids, "sync_session_id": sync_session_id}


def trigger_uploaded_document(connection, ingestion_run_id: str) -> dict:
    """
    Immediately mark a single freshly-staged document ingestion_runs row
    'running' and fire the async chunk+embed worker, so a single-document
    upload starts embedding right away instead of waiting for an admin to
    click Sync (mirrors how video auto-starts transcription).
    """
    if not LAMBDA_FUNCTION_NAME:
        logger.error("LAMBDA_FUNCTION_NAME not set; cannot start document ingestion")
        return {"started": False, "reason": "document ingestion is not configured (missing LAMBDA_FUNCTION_NAME)"}

    _mark_runs_running(connection, [ingestion_run_id], sync_session_id="single_upload")
    connection.commit()

    try:
        lambda_client.invoke(
            FunctionName=LAMBDA_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({"task": "process_document_batch"}).encode("utf-8"),
        )
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to invoke document batch worker: %s", e, exc_info=True)
        _fail_runs(connection, [ingestion_run_id], f"Failed to start document ingestion: {e}")
        connection.commit()
        return {"started": False, "reason": "failed to invoke document batch worker"}

    return {"started": True, "run_id": ingestion_run_id}


def _time_left(context):
    """Seconds this invocation has left, from the Lambda context when there is one."""
    if context is not None and hasattr(context, "get_remaining_time_in_millis"):
        return lambda: context.get_remaining_time_in_millis() / 1000
    started = time.monotonic()
    return lambda: _DEFAULT_LAMBDA_SECONDS - (time.monotonic() - started)


def _read_pdf(run: dict, raw_bytes: bytes, *, time_left, can_continue: bool):
    """
    A document run's PDF text. Textract reads the upload in place; when this
    invocation could hand the run on, OCR that outlives it raises
    TextractPending instead of settling for the embedded text.
    """
    meta = run["metadata"]
    return extract_pdf(
        raw_bytes,
        s3_object={"Bucket": meta["s3_bucket"], "Name": meta["s3_key"]},
        time_left=time_left,
        allow_pending=can_continue,
    )


def _no_text_error(pdf) -> str:
    if pdf is None:
        return "No extractable text found in this document."
    message = f"Could not index this PDF: {pdf.empty_reason()}."
    if pdf.retryable:
        message += " Retry this source to try again."
    return message


def _continue_later(connection, runs: list, continuation: int) -> list:
    """
    Hand runs this invocation had no time for to a fresh one. Returns the ids
    of runs failed instead (continuation limit reached, or the invoke failed).
    """
    run_ids = [run["ingestion_run_id"] for run in runs]
    if continuation < _MAX_CONTINUATIONS and LAMBDA_FUNCTION_NAME:
        try:
            lambda_client.invoke(
                FunctionName=LAMBDA_FUNCTION_NAME,
                InvocationType="Event",
                Payload=json.dumps({"task": "process_document_batch", "continuation": continuation + 1}).encode("utf-8"),
            )
            logger.info("Document worker continues in a new invocation: %d run(s) left", len(run_ids))
            return []
        except Exception as e:  # noqa: BLE001
            logger.error("Could not continue document ingestion: %s", e, exc_info=True)
    _fail_runs(connection, run_ids, "Document ingestion ran out of time before finishing this source. Retry it.")
    connection.commit()
    return run_ids


def process_document_batch(event, connection, context=None) -> dict:
    """
    Worker: chunk + embed every csv/markdown/document run this module marked
    'running', and finalize any paired json (metadata-sidecar) runs. Invoked
    asynchronously (InvocationType="Event"), so it is not bound by the API
    Gateway timeout; event["continuation"] counts self-continuations.
    """
    runs = _running_document_runs(connection)
    if not runs:
        return {"processed": 0, "reason": "no running document runs found"}

    continuation = int((event or {}).get("continuation") or 0)
    can_continue = continuation < _MAX_CONTINUATIONS
    time_left = _time_left(context)
    completed, failed, deferred = [], [], []

    for index, run in enumerate(runs):
        if time_left() < _MIN_SECONDS_TO_START_RUN:
            deferred = runs[index:]
            break

        run_id = run["ingestion_run_id"]
        ds_type = run["type"]
        meta = run["metadata"]

        if ds_type == "json":
            # Metadata sidecar: no content of its own to embed.
            try:
                _finish_run(connection, run_id, "completed")
                connection.commit()
                completed.append(run_id)
            except Exception as e:  # noqa: BLE001
                connection.rollback()
                logger.error("Failed to finalize metadata sidecar run %s: %s", run_id, e, exc_info=True)
                failed.append(run_id)
            continue

        run_metadata = {}
        try:
            bucket = meta.get("s3_bucket")
            key = meta.get("s3_key")
            if not bucket or not key:
                raise RuntimeError("Missing s3_bucket/s3_key on data source metadata")

            raw_bytes = s3_client.get_object(Bucket=bucket, Key=key)["Body"].read()

            if ds_type == "markdown":
                chunks = _chunk_markdown(raw_bytes.decode("utf-8", errors="replace"))
            elif ds_type == "document":
                file_name = meta.get("document_file_name") or run["name"]
                pdf = None
                if _is_pdf(file_name):
                    pdf = _read_pdf(run, raw_bytes, time_left=time_left, can_continue=can_continue)
                    run_metadata["pdf_extraction"] = pdf.summary()
                    logger.info("Document run %s: PDF read %s", run_id, json.dumps(pdf.summary()))
                    text = pdf.text
                else:
                    text = _extract_document_text(file_name, raw_bytes)
                chunks = _chunk_document_text(text, run["name"])
                if not chunks:
                    raise RuntimeError(_no_text_error(pdf))
            else:  # csv
                chunks = _chunk_csv(raw_bytes)

            # Stable across re-uploads of the same file (see upload_identity.py),
            # so the content_hash check below only re-embeds changed chunks.
            source_url = source_url_for(ds_type, meta)
            if ds_type == "document":
                source_metadata = {"document_file_name": meta.get("document_file_name")}
                # The optional public link is display-only (retrieval shows it
                # as the citation); it never keys where the chunks are stored.
                citation_url = (meta.get("document_url") or "").strip()
                if citation_url:
                    source_metadata["citation_url"] = citation_url
            else:
                companion_metadata = _load_companion_metadata(meta)
                source_metadata = {"document_metadata": companion_metadata} if companion_metadata else {}

            source_id = _upsert_source(
                connection,
                url=source_url,
                name=run["name"],
                metadata=source_metadata,
            )

            counts = write_chunks(connection, source_id, chunks)
            logger.info(
                "Document run %s: %d chunk(s) written (%d embedded, %d reused), %d deleted",
                run_id, counts["written"], counts["embedded"], counts["written"] - counts["embedded"], counts["deleted"],
            )

            if ds_type == "csv":
                # The CSV's own rows stay indexed whatever happens to its links.
                connection.commit()
                link = _start_link_phase(connection, run, raw_bytes, counts)
                if link["deferred"]:
                    completed.append(run_id)
                    logger.info("Document run %s: link crawl started; it will finalize the run", run_id)
                    continue
                run_metadata.update(link["metadata"])

            _finish_run(
                connection, run_id, "completed",
                chunks_upserted=counts["written"], chunks_deleted=counts["deleted"], metadata=run_metadata,
            )
            connection.commit()
            completed.append(run_id)

        except TextractPending as pending:
            # Out of time with OCR still running. Nothing was written for this
            # run yet; the next invocation finds the same job by content hash.
            connection.rollback()
            logger.info("Document run %s: Textract job %s still running; continuing later", run_id, pending.job_id)
            deferred = runs[index:]
            break

        except Exception as e:  # noqa: BLE001
            connection.rollback()
            logger.error("Document ingestion failed for run %s: %s", run_id, e, exc_info=True)
            try:
                _finish_run(connection, run_id, "failed", error_message=str(e)[:1000], metadata=run_metadata)
                connection.commit()
            except Exception:  # noqa: BLE001
                connection.rollback()
            failed.append(run_id)

    if deferred:
        failed.extend(_continue_later(connection, deferred, continuation))
    return {
        "processed": len(runs) - len(deferred),
        "completed": completed,
        "failed": failed,
        "deferred": [run["ingestion_run_id"] for run in deferred],
    }
