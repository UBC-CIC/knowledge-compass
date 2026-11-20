"""
Stable identity for uploaded (csv/markdown/document/video) data sources.

Every upload lands at a fresh timestamped S3 key, so the S3 key cannot tell
"the same file uploaded again" apart from a new file. Each staged upload
therefore carries, in data_sources.metadata:

- source_key:   `upload://{type}/{normalized file name}`. Staging looks up the
                existing data_sources row by this key, so a re-upload replaces
                that row instead of inserting a duplicate.
- source_url:   the `sources.url` its chunks are stored under. For csv,
                markdown and documents this is always source_key, never the
                optional document_url: a link can be blank, change, or be shared
                by two documents, none of which may move or merge their chunks.
                (A document's link is display-only, in sources.metadata
                citation_url.) Videos use their required public video_url.
                It stays the same across re-uploads, so ON CONFLICT (url) reuses
                the same sources row and the per-chunk content_hash check only
                re-embeds chunks that actually changed. That url is also used by
                crawled pages, so every helper below matches source_type as well
                and never renames, retitles, or deletes a web row.
- content_etag: the S3 ETag of the uploaded object (its MD5, since presigned
                PUTs are single-part). A byte-identical re-upload is skipped
                before any Transcribe or embedding cost is incurred.

Rows staged before this existed have no source_key/source_url; they are
matched by file name and their `sources.url` is derived the old way
(legacy_source_url), then migrated to the stable url on their first replace.
"""

import json
import logging
import os
import re

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]

s3_client = boto3.client("s3", region_name=REGION)

# Column holding the original file name on rows staged before source_key existed.
_LEGACY_FILE_NAME_EXPR = {
    "csv": "ds.name",
    "markdown": "ds.name",
    "document": "ds.metadata->>'document_file_name'",
    "video": "ds.metadata->>'video_file_name'",
}


def sanitize_file_name(file_name: str) -> str:
    base = os.path.basename(file_name).strip()
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^\w.\-]+", "_", stem, flags=re.UNICODE)
    stem = re.sub(r"_+", "_", stem).strip("._") or "upload"
    ext = re.sub(r"[^\w.]", "", ext.lower())
    return f"{stem}{ext}"[:180]


def upload_source_key(data_source_type: str, file_name: str) -> str:
    return f"upload://{data_source_type}/{sanitize_file_name(file_name).lower()}"


def legacy_source_url(data_source_type: str, metadata: dict) -> str | None:
    """
    The sources.url used for rows staged before source_url was stored
    (migration 014 gives every link-keyed document row a source_url).
    """
    if data_source_type == "video":
        return (metadata.get("video_url") or "").strip() or None
    if data_source_type == "document":
        document_url = (metadata.get("document_url") or "").strip()
        if document_url:
            return document_url
    bucket = metadata.get("s3_bucket")
    key = metadata.get("s3_key")
    if not bucket or not key:
        return None
    return f"s3://{bucket}/{key}"


def source_url_for(data_source_type: str, metadata: dict) -> str | None:
    """The sources.url a data source's chunks are stored under."""
    return metadata.get("source_url") or legacy_source_url(data_source_type, metadata)


def parse_s3_uri(uri: str | None) -> tuple[str, str] | None:
    if not uri or not uri.startswith("s3://"):
        return None
    bucket, _, key = uri[len("s3://"):].partition("/")
    return (bucket, key) if bucket and key else None


# Every key the presigned-URL helpers issue starts with this prefix
# (generate_presigned_url*.py _infer_upload_prefix).
UPLOAD_KEY_PREFIX = "uploads/"


def ingest_bucket() -> str | None:
    return os.environ.get("KNOWLEDGE_BASE_BUCKET_NAME") or None


def _transcript_key_prefix() -> str:
    return os.environ.get("TRANSCRIBE_OUTPUT_PREFIX", "transcripts").rstrip("/") + "/"


def is_issued_upload(bucket, key) -> bool:
    """
    True if (bucket, key) is where a presigned upload URL could have put the
    object: the ingest bucket, under uploads/. The client names the location
    when staging, so this is checked before the object is read, transcribed,
    stored in metadata, or later deleted. Fails closed if the bucket is unset.
    """
    expected = ingest_bucket()
    return (
        bool(expected)
        and isinstance(bucket, str)
        and isinstance(key, str)
        and bucket == expected
        and key.startswith(UPLOAD_KEY_PREFIX)
        and len(key) > len(UPLOAD_KEY_PREFIX)
    )


def _is_deletable(bucket, key) -> bool:
    """Uploads and Transcribe output in the ingest bucket; nothing else is ever deleted."""
    if is_issued_upload(bucket, key):
        return True
    expected = ingest_bucket()
    prefix = _transcript_key_prefix()
    return (
        bool(expected)
        and bucket == expected
        and isinstance(key, str)
        and key.startswith(prefix)
        and len(key) > len(prefix)
    )


def head_etag(bucket: str, key: str) -> str:
    """ETag of an uploaded object; raises if the object does not exist."""
    return s3_client.head_object(Bucket=bucket, Key=key)["ETag"].strip('"')


def stored_etag(metadata: dict, *, etag_field: str, bucket_field: str, key_field: str) -> str | None:
    """
    The recorded ETag of a data source's current object, falling back to a
    HEAD of the object itself for legacy rows that never recorded one.
    """
    if metadata.get(etag_field):
        return metadata[etag_field]
    bucket = metadata.get(bucket_field)
    key = metadata.get(key_field)
    if not bucket or not key:
        return None
    try:
        return head_etag(bucket, key)
    except Exception:  # noqa: BLE001
        return None


def find_existing_upload(connection, *, data_source_type: str, source_key: str, file_name: str) -> dict | None:
    """
    The data_sources row a new upload should replace: the row with the same
    source_key, or else (legacy rows) the most recent row of the same type
    with the same original file name.

    Any other rows with the same identity (duplicates staged before uploads
    had a stable identity) are returned under "duplicates"; they are
    superseded by the replace (see data_source_cleanup.supersede_duplicates).
    """
    legacy_expr = _LEGACY_FILE_NAME_EXPR[data_source_type]
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            SELECT ds.id, ds.name, ds.metadata, lr.id, lr.status
            FROM data_sources ds
            LEFT JOIN LATERAL (
                SELECT ir.id, ir.status
                FROM ingestion_runs ir
                WHERE ir.data_source_id = ds.id
                ORDER BY ir.created_at DESC, ir.id DESC
                LIMIT 1
            ) lr ON true
            WHERE ds.type = %s::data_source_type
              AND (
                ds.metadata->>'source_key' = %s
                OR (ds.metadata->>'source_key' IS NULL AND lower({legacy_expr}) = lower(%s))
              )
            ORDER BY (ds.metadata->>'source_key' IS NOT NULL) DESC, ds.created_at DESC, ds.id DESC
            """,
            (data_source_type, source_key, file_name),
        )
        rows = cursor.fetchall()
    if not rows:
        return None
    matches = [
        {
            "id": str(row[0]),
            "type": data_source_type,
            "name": row[1],
            "metadata": row[2] or {},
            "latest_run_id": str(row[3]) if row[3] else None,
            "latest_run_status": row[4],
        }
        for row in rows
    ]
    return {**matches[0], "duplicates": matches[1:]}


def is_ingestion_in_flight(existing: dict) -> bool:
    """
    True while a run is queued/running (or a video is still transcribing) for
    the row or any of its duplicates.
    """
    for row in [existing, *existing.get("duplicates", [])]:
        if row["latest_run_status"] in ("queued", "running"):
            return True
        if row["metadata"].get("transcribe_status") == "IN_PROGRESS":
            return True
    return False


# Uploaded corpus rows only. Crawled pages share sources.url and must never
# be renamed, retitled, re-cited, or deleted by an upload helper.
UPLOAD_SOURCE_TYPE_SQL = "source_type = ANY(ARRAY['document', 'video']::source_type[])"

# SQL for the sources.url a data_sources row `ds` maps to; must match
# source_url_for / legacy_source_url above.
DATA_SOURCE_URL_SQL = """
    COALESCE(
      ds.metadata->>'source_url',
      CASE
        WHEN ds.type = 'video'::data_source_type
          THEN NULLIF(btrim(ds.metadata->>'video_url'), '')
        WHEN ds.type = 'document'::data_source_type
         AND COALESCE(btrim(ds.metadata->>'document_url'), '') <> ''
          THEN btrim(ds.metadata->>'document_url')
        ELSE 's3://' || (ds.metadata->>'s3_bucket') || '/' || (ds.metadata->>'s3_key')
      END
    )
"""


def delete_unreferenced_source(connection, *, url: str | None) -> bool:
    """
    Delete an upload's `sources` row (its chunks cascade) unless a remaining
    csv/markdown/document/video data source still maps to that url, so a
    link shared by two data sources is not removed from under the other one.
    Crawled web pages are never touched.
    """
    if not url:
        return False
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            DELETE FROM sources s
            WHERE s.url = %s
              AND s.{UPLOAD_SOURCE_TYPE_SQL}
              AND NOT EXISTS (
                SELECT 1
                FROM data_sources ds
                WHERE ds.type = ANY(ARRAY['csv', 'markdown', 'document', 'video']::data_source_type[])
                  AND {DATA_SOURCE_URL_SQL} = s.url
              )
            """,
            (url,),
        )
        return cursor.rowcount > 0


def rename_source_url(connection, *, old_url: str | None, new_url: str | None):
    """
    Move an existing `sources` row (and so its chunks and content hashes) to a
    data source's new stable url, so a replace re-embeds only changed chunks
    instead of starting from an empty source.

    Call after the data source's metadata already points at new_url. If
    new_url already has a sources row, the old one is superseded and removed
    unless another data source still maps to it. A crawled page is never the
    row that moves: the update matches document and video rows only.
    """
    if not old_url or not new_url or old_url == new_url:
        return
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            UPDATE sources
            SET url = %s, updated_at = now()
            WHERE url = %s
              AND {UPLOAD_SOURCE_TYPE_SQL}
              AND NOT EXISTS (SELECT 1 FROM sources WHERE url = %s)
            """,
            (new_url, old_url, new_url),
        )
        renamed = cursor.rowcount > 0
    if not renamed:
        delete_unreferenced_source(connection, url=old_url)


def rename_source(connection, *, url: str | None, name: str):
    if not url:
        return
    with connection.cursor() as cursor:
        cursor.execute(
            f"""
            UPDATE sources
            SET name = %s, updated_at = now()
            WHERE url = %s
              AND {UPLOAD_SOURCE_TYPE_SQL}
            """,
            (name, url),
        )


def set_citation_url(connection, *, url: str | None, citation_url: str | None):
    """Set (or clear) the public link retrieval shows for an uploaded document's source."""
    if not url:
        return
    with connection.cursor() as cursor:
        if citation_url:
            cursor.execute(
                f"""
                UPDATE sources
                SET metadata = metadata || jsonb_build_object('citation_url', %s::text), updated_at = now()
                WHERE url = %s
                  AND {UPLOAD_SOURCE_TYPE_SQL}
                """,
                (citation_url, url),
            )
        else:
            cursor.execute(
                f"""
                UPDATE sources
                SET metadata = metadata - 'citation_url', updated_at = now()
                WHERE url = %s
                  AND {UPLOAD_SOURCE_TYPE_SQL}
                """,
                (url,),
            )


def ensure_pending_run(connection, *, data_source_id: str, metadata: dict) -> str:
    """Reuse the data source's latest run if it is still 'pending', otherwise add one."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, status
            FROM ingestion_runs
            WHERE data_source_id = %s::uuid
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """,
            (data_source_id,),
        )
        row = cursor.fetchone()
        if row and row[1] == "pending":
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE id = %s::uuid
                """,
                (json.dumps(metadata), row[0]),
            )
            return str(row[0])

        cursor.execute(
            """
            INSERT INTO ingestion_runs (data_source_id, status, error_message, metadata)
            VALUES (%s::uuid, 'pending'::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (data_source_id, json.dumps(metadata)),
        )
        return str(cursor.fetchone()[0])


def update_data_source(connection, *, data_source_id: str, name: str, metadata: dict):
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE data_sources
            SET name = %s, metadata = %s::jsonb
            WHERE id = %s::uuid
            """,
            (name, json.dumps(metadata), data_source_id),
        )


def delete_s3_objects(objects: list[tuple[str, str]]) -> list[str]:
    """
    Best-effort delete of superseded or discarded uploads. Call after commit.
    Returns the keys that could not be deleted.

    Locations come from data_sources.metadata, which older rows filled from
    the request body, so anything outside the ingest bucket's upload and
    transcript prefixes is refused rather than deleted.
    """
    failed = []
    for bucket, key in objects:
        if not bucket or not key:
            continue
        if not _is_deletable(bucket, key):
            logger.warning("Refusing to delete s3://%s/%s: not an upload or transcript", bucket, key)
            failed.append(key)
            continue
        try:
            s3_client.delete_object(Bucket=bucket, Key=key)
        except Exception as e:  # noqa: BLE001
            logger.warning("Failed to delete s3://%s/%s: %s", bucket, key, e)
            failed.append(key)
    return failed
