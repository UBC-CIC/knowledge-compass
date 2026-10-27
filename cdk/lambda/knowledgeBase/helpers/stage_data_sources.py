import json
import logging

from helpers.admin_user import (
    admin_email_from_request,
    admin_sub_from_request,
    get_or_create_admin_user_id,
)
from kc_shared.cors import get_cors_headers
from helpers.ingestion_lock import reject_if_locked
from helpers.video_transcription import start_transcription_job
from helpers.url_safety import BlockedURL, InvalidURL, check_public_url
from helpers.process_document_batch import trigger_uploaded_document
from helpers.admin_audit import actor_from_event
from helpers.csv_links import inspect_uploaded_csv, resolve_column
from helpers.data_source_cleanup import supersede_duplicates
from helpers.upload_identity import (
    delete_s3_objects,
    ensure_pending_run,
    find_existing_upload,
    head_etag,
    is_ingestion_in_flight,
    is_issued_upload,
    parse_s3_uri,
    rename_source,
    rename_source_url,
    set_citation_url,
    source_url_for,
    stored_etag,
    update_data_source,
    upload_source_key,
)
from helpers.upload_issuance import claim_issued_uploads, has_unclaimed_uploads

DOCUMENT_EXTENSIONS = (".pdf", ".docx", ".txt")

logger = logging.getLogger()
logger.setLevel(logging.INFO)


class StageRejected(Exception):
    """A staging request that cannot proceed; carries the HTTP status and body."""

    def __init__(self, status_code: int, body: dict):
        super().__init__(body.get("error"))
        self.status_code = status_code
        self.body = body


# The client names where its upload landed; only a location the presigned-URL
# endpoint issues is accepted, so staging cannot read, transcribe, or later
# delete any other object in the bucket.
UPLOAD_LOCATION_ERROR = "Uploaded file location must be one issued by the upload URL endpoint"
# The location must also have been issued to this admin, recently, and not yet
# staged (helpers/upload_issuance.py), so one admin cannot stage, and through
# a later replace delete, another admin's upload.
UPLOAD_NOT_ISSUED_ERROR = (
    "This upload was not issued to you, has expired, or was already staged. Upload the file again."
)
UPLOAD_ALREADY_CLAIMED_ERROR = "This upload is already being staged by another request. Upload the file again."


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


def _is_markdown_file(file_name: str) -> bool:
    lower_name = file_name.lower()
    return lower_name.endswith(".md") or lower_name.endswith(".markdown")


def _validate_file_pair(source_type: str, file_name: str, metadata_file_name: str) -> str | None:
    if source_type == "csv":
        if not file_name.lower().endswith(".csv"):
            return "csv_file_name must end with .csv"
    elif source_type == "markdown":
        if not _is_markdown_file(file_name):
            return "markdown_file_name must end with .md or .markdown"
    else:
        return "Unsupported file source type"

    if not metadata_file_name.endswith(".json"):
        return "metadata_file_name must end with .json"

    expected_metadata_name = f"{file_name}.metadata.json"
    if metadata_file_name != expected_metadata_name:
        return (
            "metadata_file_name must exactly match the primary file base name as "
            f"'{expected_metadata_name}'"
        )

    return None


def _validated_public_url(value: str, field: str) -> tuple[str | None, str | None]:
    """
    SSRF guard for admin-entered URLs (see helpers/url_safety.py).

    Returns (normalized_url, None) when the URL is a public http(s) URL, or
    (None, reason). Reasons are fixed texts that never include resolved
    addresses; nothing about the URL is logged.
    """
    try:
        return check_public_url(value), None
    except InvalidURL as e:
        # InvalidURL texts describe the URL's shape only (scheme, port, ...).
        logger.warning("Rejected %s (%s)", field, type(e).__name__)
        return None, f"{field} must be a public http(s) URL ({e})"
    except BlockedURL as e:
        logger.warning("Rejected %s (%s)", field, type(e).__name__)
        return None, (
            f"{field} must be a public http(s) URL; it points to a private, "
            "loopback, link-local or reserved address"
        )
    except OSError as e:
        logger.warning("Rejected %s (%s)", field, type(e).__name__)
        return None, f"{field} could not be resolved; check the address and try again"


def _source_type_at_url(connection, url: str) -> str | None:
    """source_type of the sources row stored at this exact URL, if any."""
    if not url:
        return None
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT source_type::text
            FROM sources
            WHERE url = %s
            LIMIT 1
            """,
            (url,),
        )
        row = cursor.fetchone()
        return row[0] if row else None


def _existing_website_row_id(connection, *, names: list[str]) -> str | None:
    """Check whether a website data source with any of these URLs already exists"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE type = %s::data_source_type
              AND name = ANY(%s)
            LIMIT 1
            """,
            ("website", names),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _existing_file_row_id(connection, *, s3_bucket: str, s3_key: str) -> str | None:
    """Check whether a staged file already exists by matching its S3 bucket and key"""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id
            FROM data_sources
            WHERE metadata->>'s3_bucket' = %s
              AND metadata->>'s3_key' = %s
            LIMIT 1
            """,
            (s3_bucket, s3_key),
        )
        row = cursor.fetchone()
        return str(row[0]) if row else None


def _insert_data_source_row(
    connection,
    *,
    name: str,
    data_source_type: str,
    created_by_user_id: str,
    metadata: dict,
    include_patterns: list[str] | None = None,
    exclude_patterns: list[str] | None = None,
) -> str:
    """
    Insert a new row into data_sources
    This stores the staged source itself, but does not start ingestion
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO data_sources (
                name,
                type,
                include_patterns,
                exclude_patterns,
                created_by,
                metadata
            )
            VALUES (%s, %s::data_source_type, %s, %s, %s::uuid, %s::jsonb)
            RETURNING id
            """,
            (
                name,
                data_source_type,
                include_patterns,
                exclude_patterns,
                created_by_user_id,
                json.dumps(metadata),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def _insert_ingestion_run_row(
    connection,
    *,
    data_source_row_id: str,
    status: str,
    metadata: dict | None = None,
) -> str:
    """
    Insert an initial ingestion_runs row for a staged source
    New staged sources start in 'pending' so they can later be promoted to
    'queued' when the admin clicks Sync
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, %s::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (
                data_source_row_id,
                status,
                json.dumps(metadata or {}),
            ),
        )
        row = cursor.fetchone()
        return str(row[0])


def _reject_if_not_replaceable(existing: dict | None, *, s3_key: str, file_name: str):
    """A re-upload may replace an existing source, but not mid-ingestion or twice with the same object."""
    if not existing:
        return
    if existing["metadata"].get("s3_key") == s3_key:
        raise StageRejected(
            409,
            {
                "error": f"{file_name} is already staged",
                "existing_data_source_id": existing["id"],
                "file_name": file_name,
            },
        )
    if is_ingestion_in_flight(existing):
        raise StageRejected(
            409,
            {
                "error": f"{file_name} is currently being ingested. Upload it again once that finishes.",
                "existing_data_source_id": existing["id"],
                "file_name": file_name,
            },
        )


def _link_config(
    source_type: str,
    bucket: str,
    key: str,
    url_column: str | None,
    row_id_column: str | None,
    title_column: str | None = None,
    description_column: str | None = None,
    citation_column: str | None = None,
) -> dict:
    """
    Validate configured CSV column roles against the uploaded header, resolving
    each role to the header's exact spelling. ``url_column`` remains the feature
    gate; the other row-resource roles are meaningful only when it is set.
    """
    requested = {
        "url_column": (url_column or "").strip() or None,
        "row_id_column": (row_id_column or "").strip() or None,
        "title_column": (title_column or "").strip() or None,
        "description_column": (description_column or "").strip() or None,
        "citation_column": (citation_column or "").strip() or None,
    }
    role_names = tuple(requested)
    if source_type != "csv":
        if any(requested.values()):
            raise StageRejected(400, {"error": f"{', '.join(role_names)} are only supported for CSV files"})
        return {**{name: None for name in role_names}, "suggested_url_column": None}

    dependent_roles = [name for name in role_names[1:] if requested[name]]
    if dependent_roles and not requested["url_column"]:
        raise StageRejected(400, {
            "error": f"{', '.join(dependent_roles)} require url_column",
        })

    try:
        info = inspect_uploaded_csv(bucket, key)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not read CSV header of s3://%s/%s: %s", bucket, key, e)
        if any(requested.values()):
            raise StageRejected(400, {"error": "Could not read the CSV header to check configured columns"})
        return {**{name: None for name in role_names}, "suggested_url_column": None}

    config = {**{name: None for name in role_names}, "suggested_url_column": info["suggested_url_column"]}
    for field, requested_name in requested.items():
        if not requested_name:
            continue
        resolved = resolve_column(info["columns"], requested_name)
        if not resolved:
            raise StageRejected(400, {
                "error": f"{field} '{requested_name}' is not a column of this CSV",
                "columns": info["columns"],
            })
        config[field] = resolved
    return config


def _content_unchanged(existing: dict, etag: str) -> bool:
    """
    True when a re-upload is byte-identical to the current version. A source
    whose last run failed is always re-processed, so re-uploading it retries.
    """
    if existing["latest_run_status"] == "failed":
        return False
    old_etag = stored_etag(
        existing["metadata"], etag_field="content_etag", bucket_field="s3_bucket", key_field="s3_key"
    )
    return old_etag == etag


def stage_file_pair(
    connection,
    *,
    created_by_user_id: str,
    issued_to: str,
    source_type: str,
    primary_file_name: str,
    primary_s3_bucket: str,
    primary_s3_key: str,
    metadata_file_name: str,
    metadata_s3_bucket: str,
    metadata_s3_key: str,
    url_column: str | None = None,
    row_id_column: str | None = None,
    title_column: str | None = None,
    description_column: str | None = None,
    citation_column: str | None = None,
) -> dict:
    """
    Stage a CSV/Markdown file and its metadata JSON sidecar, replacing the
    existing pair uploaded under the same file name if there is one.

    For a CSV, url_column (optional row_id_column) opts its rows' links into
    crawling (see csv_links.py); leaving it out keeps plain CSV ingestion.

    Returns {"action": "staged" | "replaced" | "unchanged", "data_source_ids",
    "ingestion_run_ids", "s3_cleanup", "suggested_url_column"}. The caller
    commits, then deletes the s3_cleanup objects (superseded or discarded
    uploads). Raises StageRejected before any write when the pair cannot be
    staged.
    """
    primary_label = source_type  # "csv" or "markdown"

    pair_error = _validate_file_pair(source_type, primary_file_name, metadata_file_name)
    if pair_error:
        raise StageRejected(400, {"error": pair_error})

    if not (
        is_issued_upload(primary_s3_bucket, primary_s3_key)
        and is_issued_upload(metadata_s3_bucket, metadata_s3_key)
    ):
        raise StageRejected(400, {"error": UPLOAD_LOCATION_ERROR})
    new_uploads = [(primary_s3_bucket, primary_s3_key), (metadata_s3_bucket, metadata_s3_key)]
    if not has_unclaimed_uploads(connection, issued_to=issued_to, objects=new_uploads):
        raise StageRejected(400, {"error": UPLOAD_NOT_ISSUED_ERROR})

    try:
        primary_etag = head_etag(primary_s3_bucket, primary_s3_key)
        metadata_etag = head_etag(metadata_s3_bucket, metadata_s3_key)
    except Exception as e:
        logger.error("Uploaded file not found in S3: %s", e, exc_info=True)
        raise StageRejected(400, {"error": "One or both uploaded files do not exist in S3"})

    links = _link_config(
        source_type,
        primary_s3_bucket,
        primary_s3_key,
        url_column,
        row_id_column,
        title_column,
        description_column,
        citation_column,
    )
    role_fields = (
        "url_column",
        "row_id_column",
        "title_column",
        "description_column",
        "citation_column",
    )
    link_metadata = {key: links[key] for key in role_fields if links[key]}

    source_key = upload_source_key(source_type, primary_file_name)

    existing = find_existing_upload(
        connection, data_source_type=source_type, source_key=source_key, file_name=primary_file_name
    )
    _reject_if_not_replaceable(existing, s3_key=primary_s3_key, file_name=primary_file_name)
    # The first write: a batch keeps going after a rejected item, so nothing
    # may be written for an item before this succeeds.
    if not claim_issued_uploads(connection, issued_to=issued_to, objects=new_uploads):
        raise StageRejected(409, {"error": UPLOAD_ALREADY_CLAIMED_ERROR})

    same_link_config = existing and all(
        existing["metadata"].get(key) == link_metadata.get(key) for key in role_fields
    )
    if existing and same_link_config and _content_unchanged(existing, primary_etag):
        old_metadata_etag = stored_etag(
            existing["metadata"],
            etag_field="companion_etag",
            bucket_field="companion_s3_bucket",
            key_field="companion_s3_key",
        )
        if old_metadata_etag == metadata_etag:
            superseded = supersede_duplicates(
                connection, existing, survivor_url=source_url_for(source_type, existing["metadata"])
            )
            return {
                "action": "unchanged",
                "data_source_ids": [existing["id"]],
                "ingestion_run_ids": [],
                "s3_cleanup": new_uploads + superseded,
                "suggested_url_column": links["suggested_url_column"],
            }

    primary_metadata = {
        "source": "staged_s3_file",
        "action": "staged_for_future_sync",
        "s3_bucket": primary_s3_bucket,
        "s3_key": primary_s3_key,
        "content_etag": primary_etag,
        "source_key": source_key,
        "source_url": source_key,
        "companion_file_name": metadata_file_name,
        "companion_s3_bucket": metadata_s3_bucket,
        "companion_s3_key": metadata_s3_key,
        "companion_etag": metadata_etag,
        **link_metadata,
    }
    json_metadata = {
        "source": "staged_s3_file",
        "action": "staged_for_future_sync",
        "s3_bucket": metadata_s3_bucket,
        "s3_key": metadata_s3_key,
        "content_etag": metadata_etag,
        "companion_file_name": primary_file_name,
        "companion_s3_bucket": primary_s3_bucket,
        "companion_s3_key": primary_s3_key,
    }
    primary_run_metadata = {
        "source": f"staged_{primary_label}_file",
        "action": "awaiting_sync",
        "s3_bucket": primary_s3_bucket,
        "s3_key": primary_s3_key,
    }
    json_run_metadata = {
        "source": "staged_json_file",
        "action": "awaiting_sync",
        "s3_bucket": metadata_s3_bucket,
        "s3_key": metadata_s3_key,
    }

    if existing:
        old = existing["metadata"]
        primary_ds_id = existing["id"]
        json_ds_id = None
        if old.get("companion_s3_bucket") and old.get("companion_s3_key"):
            json_ds_id = _existing_file_row_id(
                connection, s3_bucket=old["companion_s3_bucket"], s3_key=old["companion_s3_key"]
            )

        update_data_source(
            connection, data_source_id=primary_ds_id, name=primary_file_name, metadata=primary_metadata
        )
        rename_source_url(
            connection, old_url=source_url_for(source_type, old), new_url=primary_metadata["source_url"]
        )
        if json_ds_id:
            update_data_source(
                connection, data_source_id=json_ds_id, name=metadata_file_name, metadata=json_metadata
            )
        else:
            json_ds_id = _insert_data_source_row(
                connection,
                name=metadata_file_name,
                data_source_type="json",
                created_by_user_id=created_by_user_id,
                metadata=json_metadata,
            )

        primary_run_id = ensure_pending_run(
            connection, data_source_id=primary_ds_id, metadata={**primary_run_metadata, "replaced_upload": True}
        )
        json_run_id = ensure_pending_run(
            connection, data_source_id=json_ds_id, metadata={**json_run_metadata, "replaced_upload": True}
        )
        superseded = [
            (old.get("s3_bucket"), old.get("s3_key")),
            (old.get("companion_s3_bucket"), old.get("companion_s3_key")),
        ]
        superseded += supersede_duplicates(
            connection, existing, survivor_url=primary_metadata["source_url"]
        )
        return {
            "action": "replaced",
            "data_source_ids": [primary_ds_id, json_ds_id],
            "ingestion_run_ids": [primary_run_id, json_run_id],
            "s3_cleanup": [obj for obj in superseded if obj not in new_uploads],
            "suggested_url_column": links["suggested_url_column"],
        }

    primary_ds_id = _insert_data_source_row(
        connection,
        name=primary_file_name,
        data_source_type=source_type,
        created_by_user_id=created_by_user_id,
        metadata=primary_metadata,
    )
    json_ds_id = _insert_data_source_row(
        connection,
        name=metadata_file_name,
        data_source_type="json",
        created_by_user_id=created_by_user_id,
        metadata=json_metadata,
    )
    primary_run_id = _insert_ingestion_run_row(
        connection, data_source_row_id=primary_ds_id, status="pending", metadata=primary_run_metadata
    )
    json_run_id = _insert_ingestion_run_row(
        connection, data_source_row_id=json_ds_id, status="pending", metadata=json_run_metadata
    )
    return {
        "action": "staged",
        "data_source_ids": [primary_ds_id, json_ds_id],
        "ingestion_run_ids": [primary_run_id, json_run_id],
        "s3_cleanup": [],
        "suggested_url_column": links["suggested_url_column"],
    }


def _stage_website(event, body, connection, *, created_by: str, created_by_user_id: str):
    name = body.get("name")
    include_patterns = body.get("include_patterns", [])
    exclude_patterns = body.get("exclude_patterns", [])

    if not isinstance(name, str) or not name.strip():
        return _response(event, 400, {"error": "Missing name of the website"})

    # The name is the crawl seed the in-VPC crawler will open: it must be a
    # public http(s) URL. The normalized form is stored.
    raw_name = name.strip()
    name, url_error = _validated_public_url(raw_name, "name")
    if url_error:
        return _response(event, 400, {"error": url_error})

    if not isinstance(include_patterns, list):
        return _response(event, 400, {"error": "include_patterns must be an array"})

    if not isinstance(exclude_patterns, list):
        return _response(event, 400, {"error": "exclude_patterns must be an array"})

    # Also match the raw spelling: rows staged before normalization store it.
    existing_id = _existing_website_row_id(connection, names=list(dict.fromkeys([name, raw_name])))
    if existing_id:
        return _response(
            event,
            409,
            {
                "error": "Website already exists in data_sources",
                "existing_data_source_id": existing_id,
                "name": name,
            },
        )

    data_source_metadata = {
        "source": "staged_website",
        "action": "staged_for_future_sync",
    }

    data_source_id = _insert_data_source_row(
        connection,
        name=name,
        data_source_type="website",
        created_by_user_id=created_by_user_id,
        metadata=data_source_metadata,
        include_patterns=include_patterns if include_patterns else None,
        exclude_patterns=exclude_patterns if exclude_patterns else None,
    )

    ingestion_run_id = _insert_ingestion_run_row(
        connection,
        data_source_row_id=data_source_id,
        status="pending",
        metadata={
            "source": "staged_website",
            "action": "awaiting_sync",
        },
    )

    connection.commit()

    return _response(
        event,
        200,
        {
            "message": "Website staged successfully.",
            "action": "staged_website",
            "type": "website",
            "created_by": created_by,
            "staged_data_source_ids": [data_source_id],
            "pending_ingestion_run_ids": [ingestion_run_id],
        },
    )


def _apply_details_without_reprocessing(
    connection, existing: dict, *, name: str, details: dict, source_url: str
) -> list[tuple[str, str]]:
    """
    For a byte-identical re-upload: keep the current object and chunks, but
    apply any title/link changes so they show up without re-embedding, and
    drop any older duplicates. Returns their S3 objects to delete after commit.
    """
    old = existing["metadata"]
    metadata = {**old, **details, "source_url": source_url}
    update_data_source(connection, data_source_id=existing["id"], name=name, metadata=metadata)
    rename_source_url(connection, old_url=source_url_for(existing["type"], old), new_url=source_url)
    superseded = supersede_duplicates(connection, existing, survivor_url=source_url)
    rename_source(connection, url=source_url, name=name)
    return superseded


def _stage_video(event, body, connection, *, created_by: str, created_by_user_id: str, admin_sub: str):
    file_name = body.get("video_file_name")
    s3_bucket = body.get("video_s3_bucket")
    s3_key = body.get("video_s3_key")
    video_url = (body.get("video_url") or "").strip()
    display_name = (body.get("name") or file_name or "").strip()

    if not file_name or not s3_bucket or not s3_key:
        return _response(event, 400, {"error": "Missing video file details"})
    # Validated only; the trimmed original is stored so deep links are kept.
    if not video_url or _validated_public_url(video_url, "video_url")[1]:
        return _response(
            event,
            400,
            {"error": "video_url must be a public http(s) URL used for citations and deep-links"},
        )
    # sources.url is shared with crawled pages. The transcriber stores this
    # exact string there, so a URL already held by a non-video row is rejected
    # before transcription starts and before any chunk rewrite.
    occupant = _source_type_at_url(connection, video_url)
    if occupant and occupant != "video":
        error = (
            "video_url is already a crawled web page and cannot be used as a video source"
            if occupant == "web"
            else "video_url is already used by another source and cannot be overwritten"
        )
        return _response(
            event,
            409,
            {"error": error, "existing_source_type": occupant, "video_url": video_url},
        )

    if not is_issued_upload(s3_bucket, s3_key):
        return _response(event, 400, {"error": UPLOAD_LOCATION_ERROR})
    if not has_unclaimed_uploads(connection, issued_to=admin_sub, objects=[(s3_bucket, s3_key)]):
        return _response(event, 400, {"error": UPLOAD_NOT_ISSUED_ERROR})

    try:
        etag = head_etag(s3_bucket, s3_key)
    except Exception as e:
        logger.error("Uploaded video not found in S3: %s", e, exc_info=True)
        return _response(event, 400, {"error": "Uploaded video does not exist in S3"})

    source_key = upload_source_key("video", file_name)
    existing = find_existing_upload(
        connection, data_source_type="video", source_key=source_key, file_name=file_name
    )
    _reject_if_not_replaceable(existing, s3_key=s3_key, file_name=file_name)
    if not claim_issued_uploads(connection, issued_to=admin_sub, objects=[(s3_bucket, s3_key)]):
        raise StageRejected(409, {"error": UPLOAD_ALREADY_CLAIMED_ERROR})

    if existing and _content_unchanged(existing, etag):
        superseded = _apply_details_without_reprocessing(
            connection,
            existing,
            name=display_name,
            details={"video_url": video_url, "source_key": source_key, "content_etag": etag},
            source_url=video_url,
        )
        connection.commit()
        delete_s3_objects([(s3_bucket, s3_key), *superseded])
        return _response(
            event,
            200,
            {
                "message": "This video is identical to the one already uploaded, so transcription was skipped. Title and link were updated.",
                "action": "unchanged",
                "type": "video",
                "created_by": created_by,
                "existing_data_source_id": existing["id"],
                "staged_data_source_ids": [],
                "pending_ingestion_run_ids": [],
            },
        )

    try:
        transcribe_info = start_transcription_job(
            bucket=s3_bucket,
            key=s3_key,
            file_name=file_name,
        )
    except Exception as e:
        # Releases the claim so the same upload can be staged again.
        connection.rollback()
        logger.error("Failed to start Transcribe job: %s", e, exc_info=True)
        detail = str(e).strip().replace("\n", " ")[:400]
        return _response(
            event,
            500,
            {
                "error": "Failed to start transcription. Check the file format and try again.",
                "detail": detail,
            },
        )

    data_source_metadata = {
        "source": "staged_video",
        "action": "transcribing",
        "s3_bucket": s3_bucket,
        "s3_key": s3_key,
        "content_etag": etag,
        "source_key": source_key,
        "source_url": video_url,
        "video_url": video_url,
        "video_file_name": file_name,
        "transcribe_job_name": transcribe_info["transcribe_job_name"],
        "transcribe_status": "IN_PROGRESS",
        "transcribe_output_s3_uri": transcribe_info["transcript_s3_uri"],
        "media_format": transcribe_info["media_format"],
    }
    run_metadata = {
        "source": "staged_video",
        "action": "awaiting_transcription",
        "transcribe_job_name": transcribe_info["transcribe_job_name"],
    }

    superseded: list[tuple[str, str]] = []
    if existing:
        old = existing["metadata"]
        data_source_id = existing["id"]
        # Fresh metadata (not a merge) so the old transcript_s3_uri cannot be
        # picked up before the new transcription finishes.
        update_data_source(
            connection, data_source_id=data_source_id, name=display_name, metadata=data_source_metadata
        )
        rename_source_url(connection, old_url=source_url_for("video", old), new_url=video_url)
        superseded += supersede_duplicates(connection, existing, survivor_url=video_url)
        ingestion_run_id = ensure_pending_run(
            connection, data_source_id=data_source_id, metadata={**run_metadata, "replaced_upload": True}
        )
        superseded.append((old.get("s3_bucket"), old.get("s3_key")))
        for uri in {old.get("transcribe_output_s3_uri"), old.get("transcript_s3_uri")}:
            parsed = parse_s3_uri(uri)
            if parsed:
                superseded.append(parsed)
        action = "replaced_video_transcription"
        message = "Video replaced. Transcription has started; only changed transcript chunks will be re-embedded."
    else:
        data_source_id = _insert_data_source_row(
            connection,
            name=display_name,
            data_source_type="video",
            created_by_user_id=created_by_user_id,
            metadata=data_source_metadata,
        )
        ingestion_run_id = _insert_ingestion_run_row(
            connection,
            data_source_row_id=data_source_id,
            status="pending",
            metadata=run_metadata,
        )
        action = "staged_video_transcription"
        message = "Video uploaded. Transcription has started; embedding will run automatically when it finishes."

    connection.commit()
    delete_s3_objects([obj for obj in superseded if obj != (s3_bucket, s3_key)])

    return _response(
        event,
        200,
        {
            "message": message,
            "action": action,
            "type": "video",
            "created_by": created_by,
            "staged_data_source_ids": [data_source_id],
            "pending_ingestion_run_ids": [ingestion_run_id],
            "transcribe_job_name": transcribe_info["transcribe_job_name"],
        },
    )


def _stage_document(event, body, connection, *, created_by: str, created_by_user_id: str, admin_sub: str):
    file_name = body.get("document_file_name")
    s3_bucket = body.get("document_s3_bucket")
    s3_key = body.get("document_s3_key")
    document_url = (body.get("document_url") or "").strip()
    display_name = (body.get("name") or file_name or "").strip()

    if not file_name or not s3_bucket or not s3_key:
        return _response(event, 400, {"error": "Missing document file details"})
    if not file_name.lower().endswith(DOCUMENT_EXTENSIONS):
        return _response(
            event,
            400,
            {"error": "document_file_name must end with .pdf, .docx, or .txt"},
        )
    # Public users can only open a cited document through this link (uploads
    # are never served from S3), so it is required.
    if not document_url or _validated_public_url(document_url, "document_url")[1]:
        return _response(
            event,
            400,
            {"error": "document_url is required and must be a public http(s) URL used for citations"},
        )
    # The link is display-only, but it is the public citation. A crawled page's
    # URL is not reused as that citation.
    if _source_type_at_url(connection, document_url) == "web":
        return _response(
            event,
            409,
            {
                "error": "document_url is already a crawled web page and cannot be used as a citation",
                "existing_source_type": "web",
                "document_url": document_url,
            },
        )

    if not is_issued_upload(s3_bucket, s3_key):
        return _response(event, 400, {"error": UPLOAD_LOCATION_ERROR})
    if not has_unclaimed_uploads(connection, issued_to=admin_sub, objects=[(s3_bucket, s3_key)]):
        return _response(event, 400, {"error": UPLOAD_NOT_ISSUED_ERROR})

    try:
        etag = head_etag(s3_bucket, s3_key)
    except Exception as e:
        logger.error("Uploaded document not found in S3: %s", e, exc_info=True)
        return _response(event, 400, {"error": "Uploaded document does not exist in S3"})

    source_key = upload_source_key("document", file_name)
    # Chunks are always stored under the internal key, never the link: the
    # link may change between uploads or be shared by two documents. The link
    # is only shown in citations (sources citation_url).
    source_url = source_key
    citation_url = document_url
    existing = find_existing_upload(
        connection, data_source_type="document", source_key=source_key, file_name=file_name
    )
    _reject_if_not_replaceable(existing, s3_key=s3_key, file_name=file_name)
    if not claim_issued_uploads(connection, issued_to=admin_sub, objects=[(s3_bucket, s3_key)]):
        raise StageRejected(409, {"error": UPLOAD_ALREADY_CLAIMED_ERROR})

    if existing and _content_unchanged(existing, etag):
        superseded = _apply_details_without_reprocessing(
            connection,
            existing,
            name=display_name,
            details={"document_url": document_url, "source_key": source_key, "content_etag": etag},
            source_url=source_url,
        )
        set_citation_url(connection, url=source_url, citation_url=citation_url)
        connection.commit()
        delete_s3_objects([(s3_bucket, s3_key), *superseded])
        return _response(
            event,
            200,
            {
                "message": "This document is identical to the one already uploaded, so it was not re-embedded. Title and link were updated.",
                "action": "unchanged",
                "type": "document",
                "created_by": created_by,
                "existing_data_source_id": existing["id"],
                "staged_data_source_ids": [],
                "pending_ingestion_run_ids": [],
            },
        )

    data_source_metadata = {
        "source": "staged_document",
        "action": "processing",
        "s3_bucket": s3_bucket,
        "s3_key": s3_key,
        "content_etag": etag,
        "source_key": source_key,
        "source_url": source_url,
        "document_file_name": file_name,
        "document_url": document_url,
    }
    run_metadata = {
        "source": "staged_document",
        "action": "awaiting_embedding",
    }

    superseded: list[tuple[str, str]] = []
    if existing:
        old = existing["metadata"]
        data_source_id = existing["id"]
        update_data_source(
            connection, data_source_id=data_source_id, name=display_name, metadata=data_source_metadata
        )
        rename_source_url(connection, old_url=source_url_for("document", old), new_url=source_url)
        superseded += supersede_duplicates(connection, existing, survivor_url=source_url)
        # Show the new link right away; re-ingestion rewrites it with the metadata.
        set_citation_url(connection, url=source_url, citation_url=citation_url)
        ingestion_run_id = ensure_pending_run(
            connection, data_source_id=data_source_id, metadata={**run_metadata, "replaced_upload": True}
        )
        superseded.append((old.get("s3_bucket"), old.get("s3_key")))
        replaced = True
    else:
        data_source_id = _insert_data_source_row(
            connection,
            name=display_name,
            data_source_type="document",
            created_by_user_id=created_by_user_id,
            metadata=data_source_metadata,
        )
        ingestion_run_id = _insert_ingestion_run_row(
            connection,
            data_source_row_id=data_source_id,
            status="pending",
            metadata=run_metadata,
        )
        replaced = False

    connection.commit()
    delete_s3_objects([obj for obj in superseded if obj != (s3_bucket, s3_key)])

    trigger_result = trigger_uploaded_document(connection, ingestion_run_id, actor=actor_from_event(event))

    if not trigger_result.get("started"):
        message = "Document staged, but embedding could not be started automatically. Use Sync to retry."
    elif replaced:
        message = "Document replaced. Only changed sections will be re-embedded."
    else:
        message = "Document uploaded. Embedding has started."

    return _response(
        event,
        200,
        {
            "message": message,
            "action": "replaced_document_embedding" if replaced else "staged_document_embedding",
            "type": "document",
            "created_by": created_by,
            "staged_data_source_ids": [data_source_id],
            "pending_ingestion_run_ids": [ingestion_run_id],
        },
    )


def _stage_pair(
    event, body, connection, *, source_type: str, created_by: str, created_by_user_id: str, admin_sub: str
):
    if source_type == "csv":
        primary_file_name = body.get("csv_file_name")
        primary_s3_bucket = body.get("csv_s3_bucket")
        primary_s3_key = body.get("csv_s3_key")
    else:
        primary_file_name = body.get("markdown_file_name")
        primary_s3_bucket = body.get("markdown_s3_bucket")
        primary_s3_key = body.get("markdown_s3_key")
    primary_source_label = source_type

    metadata_file_name = body.get("metadata_file_name")
    metadata_s3_bucket = body.get("metadata_s3_bucket")
    metadata_s3_key = body.get("metadata_s3_key")

    if not primary_file_name or not primary_s3_bucket or not primary_s3_key:
        return _response(event, 400, {"error": f"Missing {primary_source_label} file details"})

    if not metadata_file_name or not metadata_s3_bucket or not metadata_s3_key:
        return _response(event, 400, {"error": "Missing metadata JSON file details"})

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
            url_column=body.get("url_column"),
            row_id_column=body.get("row_id_column"),
            title_column=body.get("title_column"),
            description_column=body.get("description_column"),
            citation_column=body.get("citation_column"),
        )
    except StageRejected as rejected:
        return _response(event, rejected.status_code, rejected.body)

    connection.commit()
    delete_s3_objects(result["s3_cleanup"])

    label = primary_source_label.capitalize()
    if result["action"] == "unchanged":
        message = f"{primary_file_name} is identical to the version already uploaded, so nothing was re-staged."
    elif result["action"] == "replaced":
        message = f"{label} and metadata JSON replaced the existing {primary_file_name}. Click Sync now; only changed chunks will be re-embedded."
    else:
        message = f"{label} and metadata JSON staged successfully."

    return _response(
        event,
        200,
        {
            "message": message,
            "action": f"{result['action']}_{primary_source_label}_and_metadata",
            "type": source_type,
            "created_by": created_by,
            "staged_data_source_ids": [] if result["action"] == "unchanged" else result["data_source_ids"],
            "pending_ingestion_run_ids": result["ingestion_run_ids"],
            "suggested_url_column": result["suggested_url_column"],
        },
    )


def stage_data_sources(event, body, connection):
    """
    Stage either a website, CSV/JSON pair, or markdown/JSON pair for future syncing

    This method:
    - validates the request
    - inserts the appropriate data_sources row(s), or for a file uploaded again
      under the same name, replaces the existing row(s) in place (see
      upload_identity.py) so its chunks are re-embedded only where changed
    - creates matching ingestion_runs row(s) with status 'pending'
    - does NOT start ingestion or create schedulers

    Supported request types:
    - type = "website"
    - type = "csv"
    - type = "markdown"
    - type = "video"
    - type = "document"
    """
    # Staging a document or video auto-starts its ingestion, so it honors the
    # cutover lock too (deliberately a superset of sync / batch / retry).
    locked = reject_if_locked(event, connection)
    if locked:
        return locked

    # Audit identity is the authorizer only. A missing email is 401, and the
    # body is never consulted (finding f-c4d6f814).
    created_by = admin_email_from_request(event)
    admin_sub = admin_sub_from_request(event)
    if not admin_sub or not created_by:
        return _response(event, 401, {"error": "Unauthorized"})

    source_type = body.get("type")
    if source_type not in {"website", "csv", "markdown", "video", "document"}:
        return _response(event, 400, {"error": "type must be one of: website, csv, markdown, video, document"})

    created_by_user_id = get_or_create_admin_user_id(connection, admin_sub, created_by)
    if not created_by_user_id:
        return _response(event, 400, {"error": "Admin user not found in database"})
    connection.commit()

    kwargs = {"created_by": created_by, "created_by_user_id": created_by_user_id}
    try:
        if source_type == "website":
            return _stage_website(event, body, connection, **kwargs)
        if source_type == "video":
            return _stage_video(event, body, connection, admin_sub=admin_sub, **kwargs)
        if source_type == "document":
            return _stage_document(event, body, connection, admin_sub=admin_sub, **kwargs)
        return _stage_pair(event, body, connection, source_type=source_type, admin_sub=admin_sub, **kwargs)

    except StageRejected as rejected:
        connection.rollback()
        return _response(event, rejected.status_code, rejected.body)
    except Exception as e:
        connection.rollback()
        logger.error("Failed to stage data sources: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to stage data sources"})
