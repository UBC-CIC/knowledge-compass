import json
import logging
import os

import boto3

from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]

s3_client = boto3.client("s3", region_name=REGION)


def _response(event, status_code: int, body: dict):
    """Build a standard API Gateway JSON response with CORS headers"""
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }


def _fetch_data_source(connection, data_source_id: str) -> dict | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, name, type, metadata
            FROM data_sources
            WHERE id = %s::uuid
            LIMIT 1
            """,
            (data_source_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": str(row[0]),
            "name": row[1],
            "type": row[2],
            "metadata": row[3] or {},
        }


def _find_companion_row(connection, *, s3_bucket: str, s3_key: str) -> dict | None:
    """Find the paired data_sources row (e.g. the .metadata.json for a csv/markdown file)"""
    if not s3_bucket or not s3_key:
        return None
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, name, type, metadata
            FROM data_sources
            WHERE metadata->>'s3_bucket' = %s
              AND metadata->>'s3_key' = %s
            LIMIT 1
            """,
            (s3_bucket, s3_key),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": str(row[0]),
            "name": row[1],
            "type": row[2],
            "metadata": row[3] or {},
        }


def _delete_s3_object(bucket: str | None, key: str | None, warnings: list[str]):
    if not bucket or not key:
        return
    try:
        s3_client.delete_object(Bucket=bucket, Key=key)
    except Exception as e:
        logger.warning("Failed to delete s3://%s/%s: %s", bucket, key, e)
        warnings.append(f"Could not delete uploaded file {key} from storage")


def _delete_s3_uri(uri: str | None, warnings: list[str]):
    if not uri or not uri.startswith("s3://"):
        return
    bucket, _, key = uri[len("s3://"):].partition("/")
    _delete_s3_object(bucket, key, warnings)


def _delete_matching_source(connection, *, source_type: str, url: str | None, warnings: list[str]):
    """
    Best-effort cleanup of the pgvector-backend `sources` row (and its cascaded
    `chunks`) for a website or video data source. Websites and videos are the
    only types embedded through the crawler/transcriber containers; there is
    no matching `sources` row for csv/markdown/json under the Bedrock KB
    backend, so a miss here is expected and not an error.
    """
    if not url:
        return
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM sources WHERE source_type = %s AND url = %s",
                (source_type, url),
            )
    except Exception as e:
        logger.warning("Failed to delete matching sources row for %s: %s", url, e)
        warnings.append("Could not clean up the associated search index entry")


def delete_data_source(event, body, connection, data_source_id: str):
    """
    Permanently remove an uploaded data source (file, video, or website) that
    was added by mistake.

    This method:
    - looks up the data source and, for csv/markdown/json pairs, its companion row
    - deletes the ingestion_runs row(s) first (no ON DELETE CASCADE on the FK)
    - deletes the data_sources row(s)
    - best-effort deletes the underlying S3 object(s) (primary, companion, transcript)
    - best-effort deletes any matching pgvector `sources` row so its embedded
      chunks stop being served by retrieval

    S3/vector-store cleanup failures are logged and returned as warnings, but
    do not block the database delete: the resource is meant to disappear from
    the admin list even if a downstream cleanup step could not be completed.
    """
    row = _fetch_data_source(connection, data_source_id)
    if not row:
        return _response(event, 404, {"error": "Data source not found"})

    targets = [row]

    metadata = row["metadata"]
    if row["type"] in ("csv", "markdown", "json"):
        companion = _find_companion_row(
            connection,
            s3_bucket=metadata.get("companion_s3_bucket"),
            s3_key=metadata.get("companion_s3_key"),
        )
        if companion:
            targets.append(companion)

    target_ids = [t["id"] for t in targets]
    warnings: list[str] = []

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "DELETE FROM ingestion_runs WHERE data_source_id = ANY(%s::uuid[])",
                (target_ids,),
            )
            cursor.execute(
                "DELETE FROM data_sources WHERE id = ANY(%s::uuid[])",
                (target_ids,),
            )
        connection.commit()
    except Exception as e:
        connection.rollback()
        logger.error("Failed to delete data source %s: %s", data_source_id, e, exc_info=True)
        return _response(event, 500, {"error": "Failed to delete data source"})

    # Best-effort cleanup below; the DB rows are already gone, so failures here
    # are surfaced as warnings rather than rolled back.
    for target in targets:
        target_metadata = target["metadata"]
        _delete_s3_object(target_metadata.get("s3_bucket"), target_metadata.get("s3_key"), warnings)

    if row["type"] == "video":
        _delete_s3_uri(metadata.get("transcribe_output_s3_uri"), warnings)
        _delete_matching_source(
            connection,
            source_type="video",
            url=metadata.get("video_url"),
            warnings=warnings,
        )
    elif row["type"] == "website":
        _delete_matching_source(
            connection,
            source_type="web",
            url=row["name"],
            warnings=warnings,
        )
    connection.commit()

    return _response(
        event,
        200,
        {
            "message": "Data source deleted.",
            "action": "deleted",
            "data_source_id": data_source_id,
            "deleted_data_source_ids": target_ids,
            "warnings": warnings,
        },
    )
