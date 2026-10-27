import json
import logging
from kc_shared.cors import get_cors_headers
from helpers.ingestion_lock import reject_if_locked
from helpers.admin_user import (
    admin_email_from_request,
    admin_sub_from_request,
    get_or_create_admin_user_id,
)
from helpers.stage_data_sources import StageRejected, stage_file_pair
from helpers.upload_identity import delete_s3_objects, upload_source_key

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body),
    }


def stage_data_sources_batch(event, body, connection):
    """
    Stage multiple CSV/Markdown + metadata JSON file pairs in a single request.

    Each pair goes through the same stage_file_pair as a single upload: a file
    uploaded again under an existing name replaces that source in place
    ("replaced"), a byte-identical re-upload is dropped ("unchanged"), and a
    source that is mid-ingestion is left alone ("skipped").

    The acting admin is the authorizer email. A created_by field in the body
    is ignored.

    Request body:
    {
      "items": [
        {
          "type": "csv" | "markdown",
          "primary_file_name": "alumni.csv",
          "primary_s3_bucket": "...",
          "primary_s3_key": "...",
          "metadata_file_name": "alumni.csv.metadata.json",
          "metadata_s3_bucket": "...",
          "metadata_s3_key": "..."
        },
        ...
      ]
    }
    """
    locked = reject_if_locked(event, connection)
    if locked:
        return locked

    # Audit identity is the authorizer only. A missing email is 401, and the
    # body is never consulted (finding f-c4d6f814).
    created_by = admin_email_from_request(event)
    admin_sub = admin_sub_from_request(event)
    if not admin_sub or not created_by:
        return _response(event, 401, {"error": "Unauthorized"})

    items = body.get("items")

    if not isinstance(items, list) or len(items) == 0:
        return _response(event, 400, {"error": "items must be a non-empty array"})

    if len(items) > 100:
        return _response(event, 400, {"error": "Too many items. Maximum is 100 per batch."})

    created_by_user_id = get_or_create_admin_user_id(connection, admin_sub, created_by)
    if not created_by_user_id:
        return _response(event, 400, {"error": "Admin user not found in database"})
    connection.commit()

    staged = []
    replaced = []
    unchanged = []
    skipped = []
    errors = []
    s3_cleanup = []

    # source_key -> file name of the item that claimed it earlier in this batch.
    # Two files whose names only differ by case/punctuation ("Data.csv",
    # "data.csv") are the same source; without this the later one would
    # silently replace the one staged a moment earlier in this same request.
    batch_keys: dict[str, str] = {}

    try:
        for i, item in enumerate(items):
            source_type = item.get("type")
            primary_file_name = item.get("primary_file_name")
            primary_s3_bucket = item.get("primary_s3_bucket")
            primary_s3_key = item.get("primary_s3_key")
            metadata_file_name = item.get("metadata_file_name")
            metadata_s3_bucket = item.get("metadata_s3_bucket")
            metadata_s3_key = item.get("metadata_s3_key")

            if source_type not in {"csv", "markdown"}:
                errors.append({"index": i, "error": "type must be csv or markdown"})
                continue

            if not all([primary_file_name, primary_s3_bucket, primary_s3_key,
                        metadata_file_name, metadata_s3_bucket, metadata_s3_key]):
                errors.append({"index": i, "file": primary_file_name, "error": "Missing required fields"})
                continue

            source_key = upload_source_key(source_type, primary_file_name)
            if source_key in batch_keys:
                errors.append({
                    "index": i,
                    "file": primary_file_name,
                    "error": (
                        f"{primary_file_name} is the same source as {batch_keys[source_key]} in this upload "
                        "(file names are matched ignoring case and punctuation). Rename one of them."
                    ),
                })
                continue
            batch_keys[source_key] = primary_file_name

            try:
                result = stage_file_pair(
                    connection,
                    created_by_user_id=created_by_user_id,
                    issued_to=admin_sub,
                    source_type=source_type,
                    primary_file_name=primary_file_name,
                    primary_s3_bucket=primary_s3_bucket,
                    primary_s3_key=primary_s3_key,
                    metadata_file_name=metadata_file_name,
                    metadata_s3_bucket=metadata_s3_bucket,
                    metadata_s3_key=metadata_s3_key,
                    url_column=item.get("url_column"),
                    row_id_column=item.get("row_id_column"),
                    title_column=item.get("title_column"),
                    description_column=item.get("description_column"),
                    citation_column=item.get("citation_column"),
                )
            except StageRejected as rejected:
                reason = rejected.body.get("error")
                if rejected.status_code == 409:
                    skipped.append({"index": i, "file": primary_file_name, "reason": reason})
                else:
                    errors.append({"index": i, "file": primary_file_name, "error": reason})
                continue

            s3_cleanup.extend(result["s3_cleanup"])
            entry = {"index": i, "file": primary_file_name, "data_source_ids": result["data_source_ids"]}
            if result["suggested_url_column"]:
                entry["suggested_url_column"] = result["suggested_url_column"]
            if result["action"] == "replaced":
                replaced.append(entry)
            elif result["action"] == "unchanged":
                unchanged.append(entry)
            else:
                staged.append(entry)

        connection.commit()

    except Exception as e:
        connection.rollback()
        logger.error("Batch staging failed: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Batch staging failed"})

    delete_s3_objects(s3_cleanup)

    return _response(event, 200, {
        "message": (
            f"Batch staging complete. {len(staged)} new, {len(replaced)} replaced, "
            f"{len(unchanged)} unchanged, {len(skipped)} skipped, {len(errors)} failed."
        ),
        "staged_count": len(staged),
        "replaced_count": len(replaced),
        "unchanged_count": len(unchanged),
        "skipped_count": len(skipped),
        "error_count": len(errors),
        "staged": staged,
        "replaced": replaced,
        "unchanged": unchanged,
        "skipped": skipped,
        "errors": errors,
    })
