"""
csv_links.py

Links from a CSV column to web pages / PDFs that are fetched and indexed
alongside the CSV's rows.

Opt-in per CSV upload: staging with `url_column` (and optionally
`row_id_column`) stores them in data_sources.metadata. Without url_column
nothing here runs and the CSV is ingested exactly as before; staging only
returns `suggested_url_column` (a column where >80% of values are http(s)
URLs) as a hint.

Flow, per CSV ingestion run (process_document_batch.py):
1. the CSV's own rows are chunked + embedded as before, and committed;
2. start_link_phase() reconciles csv_row_links with the CSV (see
   plan_link_rows): rows gone from the CSV are removed, others are (re)set to
   'pending', or 'failed'/'skipped' when their URL is invalid or over the
   per-CSV cap. csv_link sources no row references any more are deleted;
3. the run stays 'running' and an async self-invocation
   (process_csv_links.py) fetches each pending URL once, indexes it, and
   finalizes the run with a link summary.

Identity:
- row_key: the row_id_column value if configured, otherwise a hash of the
  whole row, so an edited row replaces the old one instead of duplicating it.
- Fetched content is one `sources` row per normalized URL, at
  'csvlink://<normalized url>' (source_type 'csv_link'), shared by every row
  in any CSV that links there. Retrieval cites the real URL (citation_url).
"""

import csv
import hashlib
import io
import json
import logging
import os

import boto3

from helpers.cors import get_cors_headers
from helpers.url_safety import InvalidURL, normalize_url

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
LAMBDA_FUNCTION_NAME = os.environ.get("LAMBDA_FUNCTION_NAME", "")

LINK_SOURCE_PREFIX = "csvlink://"
URL_COLUMN_THRESHOLD = 0.8
_SAMPLE_BYTES = 256 * 1024
_SAMPLE_ROWS = 200
_MAX_ROW_ID_LENGTH = 100
_MAX_METADATA_VALUE_CHARS = 1000

s3_client = boto3.client("s3", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)


def max_urls_per_csv() -> int:
    try:
        return max(0, int(os.environ.get("LINK_MAX_URLS_PER_CSV", "500")))
    except ValueError:
        return 500


def link_source_url(normalized_url: str) -> str:
    return f"{LINK_SOURCE_PREFIX}{normalized_url}"


def _decode(raw_bytes: bytes) -> str:
    return raw_bytes.decode("utf-8-sig", errors="replace")


# ── Column inspection (staging) ───────────────────────────────────────────────

def _looks_like_url(value: str) -> bool:
    try:
        normalize_url(value)
        return True
    except InvalidURL:
        return False


def detect_url_columns(text: str, threshold: float = URL_COLUMN_THRESHOLD, sample_rows: int = _SAMPLE_ROWS) -> list:
    """Columns where more than `threshold` of the non-empty sampled values are http(s) URLs, best first."""
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = reader.fieldnames or []
    seen = {name: 0 for name in fieldnames}
    urls = {name: 0 for name in fieldnames}
    try:
        for i, row in enumerate(reader):
            if i >= sample_rows:
                break
            for name in fieldnames:
                value = (row.get(name) or "").strip()
                if value:
                    seen[name] += 1
                    urls[name] += _looks_like_url(value)
    except csv.Error:
        pass  # a truncated sample may end mid-field
    ratios = {name: urls[name] / seen[name] for name in fieldnames if seen[name]}
    return sorted((n for n, r in ratios.items() if r > threshold), key=lambda n: -ratios[n])


def resolve_column(fieldnames: list, requested: str | None) -> str | None:
    """The header matching `requested` exactly, else case-insensitively; None if absent."""
    if not requested:
        return None
    if requested in fieldnames:
        return requested
    wanted = requested.strip().lower()
    return next((f for f in fieldnames if (f or "").strip().lower() == wanted), None)


def inspect_uploaded_csv(bucket: str, key: str) -> dict:
    """Header and URL-column suggestion from the first 256 KiB of an uploaded CSV."""
    obj = s3_client.get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{_SAMPLE_BYTES - 1}")
    raw = obj["Body"].read()
    text = _decode(raw)
    if len(raw) >= _SAMPLE_BYTES and "\n" in text:
        text = text[: text.rfind("\n")]  # drop the partial last line
    fieldnames = next(csv.reader(io.StringIO(text)), [])
    suggested = detect_url_columns(text)
    return {"columns": fieldnames, "suggested_url_column": suggested[0] if suggested else None}


# ── Planning (pure) ───────────────────────────────────────────────────────────

def _row_key(row: dict, fieldnames: list, row_id_column: str | None) -> str:
    if row_id_column:
        value = (row.get(row_id_column) or "").strip()
        if value:
            if len(value) <= _MAX_ROW_ID_LENGTH:
                return f"id:{value}"
            return f"id#{hashlib.sha256(value.encode()).hexdigest()[:40]}"
    rendered = "\x1f".join(f"{name}={(row.get(name) or '').strip()}" for name in fieldnames)
    return f"h:{hashlib.sha256(rendered.encode()).hexdigest()[:40]}"


def plan_link_rows(
    raw_bytes: bytes,
    url_column: str,
    row_id_column: str | None = None,
    max_urls: int | None = None,
) -> dict:
    """
    One entry per CSV row with a non-empty url_column value:
    {row_key, row_number, raw_url, normalized_url, source_url, row_metadata,
    status, reason}. status is 'pending' (to fetch), 'failed' (invalid URL) or
    'skipped' (its URL would exceed max_urls distinct URLs for this CSV; rows
    repeating an already-accepted URL are never skipped).

    Returns {"rows", "url_column", "row_id_column", "error"}; error is set
    (and rows empty) when url_column is not a column of the CSV.
    """
    max_urls = max_urls_per_csv() if max_urls is None else max_urls
    reader = csv.DictReader(io.StringIO(_decode(raw_bytes)))
    fieldnames = reader.fieldnames or []

    resolved_url_column = resolve_column(fieldnames, url_column)
    if not resolved_url_column:
        return {"rows": [], "url_column": url_column, "row_id_column": row_id_column,
                "error": f"url_column '{url_column}' is not a column of this CSV"}
    resolved_id_column = resolve_column(fieldnames, row_id_column)

    rows: list = []
    key_counts: dict = {}
    accepted_urls: set = set()
    for row_number, row in enumerate(reader, start=1):
        raw_url = (row.get(resolved_url_column) or "").strip()
        if not raw_url:
            continue

        key = _row_key(row, fieldnames, resolved_id_column)
        key_counts[key] = key_counts.get(key, 0) + 1
        if key_counts[key] > 1:  # duplicate ids / identical rows stay distinct rows
            key = f"{key}#{key_counts[key]}"

        entry = {
            "row_key": key,
            "row_number": row_number,
            "raw_url": raw_url,
            "normalized_url": None,
            "source_url": None,
            "row_metadata": {
                name: (row.get(name) or "").strip()[:_MAX_METADATA_VALUE_CHARS]
                for name in fieldnames
                if name and name != resolved_url_column and (row.get(name) or "").strip()
            },
            "status": "pending",
            "reason": None,
        }
        try:
            normalized = normalize_url(raw_url)
        except InvalidURL as e:
            entry.update(status="failed", reason=f"invalid URL: {e}")
            rows.append(entry)
            continue

        if normalized not in accepted_urls and len(accepted_urls) >= max_urls:
            entry.update(normalized_url=normalized, status="skipped",
                         reason=f"url_cap_exceeded: only the first {max_urls} distinct URLs of a CSV are crawled")
            rows.append(entry)
            continue

        accepted_urls.add(normalized)
        entry.update(normalized_url=normalized, source_url=link_source_url(normalized))
        rows.append(entry)

    return {"rows": rows, "url_column": resolved_url_column, "row_id_column": resolved_id_column, "error": None}


def summarize(rows: list) -> dict:
    summary = {"pending": 0, "success": 0, "failed": 0, "skipped": 0}
    for row in rows:
        summary[row["status"]] = summary.get(row["status"], 0) + 1
    return summary


# ── DB ────────────────────────────────────────────────────────────────────────

def delete_unreferenced_link_sources(connection) -> int:
    """Delete csv_link sources (chunks cascade) that no CSV row links to any more."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            DELETE FROM sources s
            WHERE s.source_type = 'csv_link'::source_type
              AND NOT EXISTS (SELECT 1 FROM csv_row_links l WHERE l.source_url = s.url)
            """
        )
        return cursor.rowcount


def clear_link_rows(connection, data_source_id: str) -> int:
    """Remove every link row of a CSV (e.g. url_column was unset) and content only it used."""
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM csv_row_links WHERE data_source_id = %s::uuid", (data_source_id,))
        removed = cursor.rowcount
    if removed:
        delete_unreferenced_link_sources(connection)
    return removed


def reconcile_link_rows(connection, data_source_id: str, rows: list) -> int:
    """
    Make csv_row_links for this CSV match `rows` (from plan_link_rows): delete
    rows no longer in the CSV, upsert the rest with their new status. Returns
    how many csv_link sources became unreferenced and were deleted.
    """
    from psycopg2.extras import execute_values  # psycopg2 comes from the Lambda layer

    keys = [r["row_key"] for r in rows]
    with connection.cursor() as cursor:
        cursor.execute(
            "DELETE FROM csv_row_links WHERE data_source_id = %s::uuid AND row_key <> ALL(%s::text[])",
            (data_source_id, keys),
        )
        if rows:
            execute_values(
                cursor,
                """
                INSERT INTO csv_row_links (
                  data_source_id, row_key, row_number, raw_url, normalized_url,
                  source_url, row_metadata, status, reason
                )
                VALUES %s
                ON CONFLICT (data_source_id, row_key) DO UPDATE SET
                  row_number     = EXCLUDED.row_number,
                  raw_url        = EXCLUDED.raw_url,
                  normalized_url = EXCLUDED.normalized_url,
                  source_url     = EXCLUDED.source_url,
                  row_metadata   = EXCLUDED.row_metadata,
                  status         = EXCLUDED.status,
                  reason         = EXCLUDED.reason,
                  http_status    = NULL,
                  content_type   = NULL,
                  updated_at     = now()
                """,
                [
                    (
                        data_source_id, r["row_key"], r["row_number"], r["raw_url"], r["normalized_url"],
                        r["source_url"], json.dumps(r["row_metadata"]), r["status"], r["reason"],
                    )
                    for r in rows
                ],
                template="(%s::uuid, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)",
                page_size=500,
            )
    return delete_unreferenced_link_sources(connection)


def _set_run_link_metadata(connection, run_id: str, *, chunks_upserted=None, chunks_deleted=None, metadata: dict):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET chunks_upserted = COALESCE(%s, chunks_upserted),
                chunks_deleted  = COALESCE(%s, chunks_deleted),
                metadata        = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid
            """,
            (chunks_upserted, chunks_deleted, json.dumps(metadata), run_id),
        )


def _fail_pending_rows(connection, data_source_id: str, reason: str):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE csv_row_links
            SET status = 'failed', reason = %s, updated_at = now()
            WHERE data_source_id = %s::uuid AND status = 'pending'
            """,
            (reason, data_source_id),
        )


def invoke_link_worker(*, ingestion_run_id: str, data_source_id: str, sync_session_id: str, continuation: int):
    """Fire the async process_csv_links worker (self-invocation, like process_document_batch)."""
    lambda_client.invoke(
        FunctionName=LAMBDA_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({
            "task": "process_csv_links",
            "ingestion_run_id": ingestion_run_id,
            "data_source_id": data_source_id,
            "sync_session_id": sync_session_id,
            "continuation": continuation,
        }).encode("utf-8"),
    )


def start_link_phase(connection, *, run: dict, raw_bytes: bytes, chunks_upserted: int, chunks_deleted: int) -> dict:
    """
    Called by process_document_batch after a CSV's own chunks are committed.

    Returns {"deferred": bool, "metadata": dict}. When deferred, the run is
    left 'running' for process_csv_links to finalize and the caller must not
    finish it; otherwise the caller finishes it and merges `metadata` into it.
    """
    meta = run["metadata"]
    data_source_id = run["data_source_id"]
    url_column = meta.get("url_column")

    if not url_column:
        clear_link_rows(connection, data_source_id)
        connection.commit()
        return {"deferred": False, "metadata": {}}

    plan = plan_link_rows(raw_bytes, url_column, meta.get("row_id_column"))
    if plan["error"]:
        clear_link_rows(connection, data_source_id)
        connection.commit()
        return {"deferred": False, "metadata": {"link_error": plan["error"]}}

    reconcile_link_rows(connection, data_source_id, plan["rows"])
    summary = summarize(plan["rows"])
    if not summary["pending"]:
        connection.commit()
        return {"deferred": False, "metadata": {"link_summary": summary}}

    if not LAMBDA_FUNCTION_NAME:
        _fail_pending_rows(connection, data_source_id, "link crawling is not configured (missing LAMBDA_FUNCTION_NAME)")
        connection.commit()
        return {"deferred": False, "metadata": {"link_error": "link crawling is not configured"}}

    _set_run_link_metadata(
        connection,
        run["ingestion_run_id"],
        chunks_upserted=chunks_upserted,
        chunks_deleted=chunks_deleted,
        metadata={"link_phase": "running", "link_summary": summary},
    )
    connection.commit()

    try:
        invoke_link_worker(
            ingestion_run_id=run["ingestion_run_id"],
            data_source_id=data_source_id,
            sync_session_id=(run.get("run_metadata") or {}).get("sync_session_id") or run["ingestion_run_id"],
            continuation=0,
        )
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to start link crawl for run %s: %s", run["ingestion_run_id"], e, exc_info=True)
        _fail_pending_rows(connection, data_source_id, "link crawl could not be started")
        _set_run_link_metadata(connection, run["ingestion_run_id"], metadata={"link_phase": "failed_to_start"})
        connection.commit()
        return {"deferred": False, "metadata": {"link_error": f"link crawl could not be started: {e}"[:500]}}

    return {"deferred": True, "metadata": {}}


# ── API: GET /admin/data_sources/{id}/links ───────────────────────────────────

def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body, default=str),
    }


def get_data_source_links(event, connection, data_source_id: str):
    """Per-row link crawl status of a CSV data source (filter with ?status=, page with ?limit=&offset=)."""
    params = event.get("queryStringParameters") or {}
    status = params.get("status")
    if status and status not in ("pending", "success", "failed", "skipped"):
        return _response(event, 400, {"error": "status must be one of: pending, success, failed, skipped"})
    try:
        limit = min(max(int(params.get("limit", 200)), 1), 1000)
        offset = max(int(params.get("offset", 0)), 0)
    except ValueError:
        return _response(event, 400, {"error": "limit and offset must be integers"})

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT type, metadata FROM data_sources WHERE id = %s::uuid",
            (data_source_id,),
        )
        ds = cursor.fetchone()
        if not ds:
            return _response(event, 404, {"error": "Data source not found"})
        if ds[0] != "csv":
            return _response(event, 400, {"error": "Only CSV data sources have crawled links"})

        cursor.execute(
            "SELECT status, count(*) FROM csv_row_links WHERE data_source_id = %s::uuid GROUP BY status",
            (data_source_id,),
        )
        summary = {"pending": 0, "success": 0, "failed": 0, "skipped": 0}
        summary.update({row[0]: row[1] for row in cursor.fetchall()})

        cursor.execute(
            """
            SELECT row_key, row_number, raw_url, normalized_url, status, reason,
                   http_status, content_type, fetched_at, row_metadata
            FROM csv_row_links
            WHERE data_source_id = %s::uuid
              AND (%s::text IS NULL OR status = %s::text)
            ORDER BY row_number, row_key
            LIMIT %s OFFSET %s
            """,
            (data_source_id, status, status, limit, offset),
        )
        columns = ["row_key", "row_number", "url", "normalized_url", "status", "reason",
                   "http_status", "content_type", "fetched_at", "row_metadata"]
        links = [dict(zip(columns, row)) for row in cursor.fetchall()]

    meta = ds[1] or {}
    return _response(event, 200, {
        "data_source_id": data_source_id,
        "url_column": meta.get("url_column"),
        "row_id_column": meta.get("row_id_column"),
        "summary": summary,
        "total": sum(summary.values()),
        "limit": limit,
        "offset": offset,
        "links": links,
    })
