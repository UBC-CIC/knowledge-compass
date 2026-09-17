"""
process_document_batch.py

pgvector ingestion path for CSV/Markdown documents (the counterpart to
process_crawler_batch.py, which only handles website/video).

API Gateway enforces a hard 29s integration timeout, but chunking + embedding
a document can take much longer than that, so this module splits into two
halves:

- trigger_document_batch(): called synchronously from start_ingestion_job.py
  (inside the API-Gateway-fronted request). It only marks the queued
  csv/markdown/json runs 'running' and fires an asynchronous ("Event")
  self-invocation of this same Lambda — both fast, well under 29s.
- process_document_batch(): the actual worker. It runs OUTSIDE the API
  Gateway request lifecycle (invoked via the "task": "process_document_batch"
  branch in main.py), so it can take as long as the Lambda's configured
  timeout allows.

State machine reused unchanged: stage_data_sources -> 'pending';
start_ingestion_job promotes -> 'queued'; trigger_document_batch marks ->
'running'; process_document_batch marks -> 'completed' | 'failed'.

CSV/Markdown files have no enforced content schema (see
Docs/KNOWLEDGE_BASE_DOCUMENTATION.md) — they are chunked as plain text:
- Markdown: split into sections by heading (#/##/###), then into ~650-word
  chunks with sentence-boundary overlap (mirrors the website crawler).
- CSV: parsed with csv.DictReader (schema-agnostic), rows rendered as
  "column: value" lines and grouped into ~650-word chunks.

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

import boto3

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
_MAX_WORDS_PER_CHUNK = 650
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")

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


def _chunk_csv(raw_bytes: bytes, max_words: int = _MAX_WORDS_PER_CHUNK) -> list:
    text = raw_bytes.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = reader.fieldnames or []

    chunks: list = []
    idx = 0
    buf_rows: list = []
    buf_words = 0
    row_start = 1
    row_num = 0

    def render_row(row: dict) -> str:
        return "\n".join(
            f"{k}: {(row.get(k) or '').strip()}" for k in fieldnames if (row.get(k) or "").strip()
        )

    def emit(row_end):
        nonlocal idx
        body = "\n\n".join(buf_rows)
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
        if buf_words + rendered_words > max_words and buf_rows:
            emit(row_num - 1)
            buf_rows, buf_words, row_start = [], 0, row_num
        buf_rows.append(rendered)
        buf_words += rendered_words

    if buf_rows:
        emit(row_num)

    return chunks


# ── Embeddings ────────────────────────────────────────────────────────────────

def _embed_texts(texts: list) -> list:
    """Cohere embed-english-v3 via Bedrock, batched at 96 texts/call (API limit)."""
    texts = [t[:2048].rsplit(" ", 1)[0] if len(t) > 2048 else t for t in texts]
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
    """Latest 'queued' run per data source, for csv/markdown/json types."""
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
              AND ds.type = ANY(ARRAY['csv', 'markdown', 'json']::data_source_type[])
            ORDER BY ds.created_at ASC, ds.id ASC
            """
        )
        return [
            {"ingestion_run_id": str(r[0]), "data_source_id": str(r[1]), "name": r[2], "type": r[3], "metadata": r[4] or {}}
            for r in cursor.fetchall()
        ]


def _running_document_runs(connection) -> list:
    """Runs this module marked 'running' that still need to be finalized."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT ir.id, ir.data_source_id, ds.name, ds.type, ds.metadata
            FROM ingestion_runs ir
            JOIN data_sources ds ON ds.id = ir.data_source_id
            WHERE ir.status = 'running'::ingestion_status
              AND ds.type = ANY(ARRAY['csv', 'markdown', 'json']::data_source_type[])
              AND ir.metadata->>'backend' = 'pgvector_document'
            ORDER BY ds.created_at ASC, ds.id ASC
            """
        )
        return [
            {"ingestion_run_id": str(r[0]), "data_source_id": str(r[1]), "name": r[2], "type": r[3], "metadata": r[4] or {}}
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


def _finish_run(connection, run_id: str, status: str, *, chunks_upserted=0, chunks_deleted=0, error_message=None):
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
                completed_at = now()
            WHERE id = %s::uuid
            """,
            (status, chunks_upserted, chunks_deleted, error_message, run_id),
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


def _existing_chunk_hashes(connection, source_id: str) -> dict:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT chunk_index, content_hash FROM chunks WHERE source_id = %s::uuid",
            (source_id,),
        )
        return {row[0]: row[1] for row in cursor.fetchall()}


def _upsert_chunk(connection, source_id: str, chunk: dict, embedding: list):
    embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"
    metadata = json.dumps({"heading_path": chunk.get("heading_path")})
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


def process_document_batch(event, connection) -> dict:
    """
    Worker: chunk + embed every csv/markdown run this module marked 'running',
    and finalize any paired json (metadata-sidecar) runs. Invoked asynchronously
    (InvocationType="Event"), so it is not bound by the API Gateway timeout.
    """
    runs = _running_document_runs(connection)
    if not runs:
        return {"processed": 0, "reason": "no running document runs found"}

    completed, failed = [], []

    for run in runs:
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

        try:
            bucket = meta.get("s3_bucket")
            key = meta.get("s3_key")
            if not bucket or not key:
                raise RuntimeError("Missing s3_bucket/s3_key on data source metadata")

            raw_bytes = s3_client.get_object(Bucket=bucket, Key=key)["Body"].read()

            if ds_type == "markdown":
                chunks = _chunk_markdown(raw_bytes.decode("utf-8", errors="replace"))
            else:  # csv
                chunks = _chunk_csv(raw_bytes)

            companion_metadata = _load_companion_metadata(meta)
            source_url = f"s3://{bucket}/{key}"
            source_id = _upsert_source(
                connection,
                url=source_url,
                name=run["name"],
                metadata={"document_metadata": companion_metadata} if companion_metadata else {},
            )

            existing_hashes = _existing_chunk_hashes(connection, source_id)
            to_embed = [c for c in chunks if existing_hashes.get(c["chunk_index"]) != c["content_hash"]]

            if to_embed:
                embeddings = _embed_texts([c["text"] for c in to_embed])
                for chunk, embedding in zip(to_embed, embeddings):
                    _upsert_chunk(connection, source_id, chunk, embedding)

            deleted = _delete_stale_chunks(connection, source_id, [c["chunk_index"] for c in chunks])

            _finish_run(connection, run_id, "completed", chunks_upserted=len(to_embed), chunks_deleted=deleted)
            connection.commit()
            completed.append(run_id)
            logger.info(
                "Document run %s completed: %d chunk(s) embedded, %d deleted", run_id, len(to_embed), deleted
            )

        except Exception as e:  # noqa: BLE001
            connection.rollback()
            logger.error("Document ingestion failed for run %s: %s", run_id, e, exc_info=True)
            try:
                _finish_run(connection, run_id, "failed", error_message=str(e)[:1000])
                connection.commit()
            except Exception:  # noqa: BLE001
                connection.rollback()
            failed.append(run_id)

    return {"processed": len(runs), "completed": completed, "failed": failed}
