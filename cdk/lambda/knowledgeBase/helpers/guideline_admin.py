"""
Admin API for guideline mode (migration 031). All routes sit under /admin/ and
are protected by the existing admin Cognito authorizer in API Gateway.

  GET    /admin/guideline                     mode + documents + detected sections
  POST   /admin/guideline/upload-url          presigned PUT for a .md file
  POST   /admin/guideline/documents           register an upload (new or replace)
  DELETE /admin/guideline/documents/{id}      remove a guide and its chunks
  PATCH  /admin/guideline/sections/{id}       rename (or reset) a situation label
  PUT    /admin/guideline/mode                'standard' | 'guideline'

Request bodies and document text are never logged.
"""

import json
import logging
import os
import re
import uuid

import boto3
from botocore.config import Config

from helpers.admin_user import normalize_email
from helpers.cors import get_cors_headers
from helpers.guideline_document import guideline_source_url
from helpers.guideline_extract import file_kind

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ.get("REGION", "ca-central-1")
LAMBDA_FUNCTION_NAME = os.environ.get("LAMBDA_FUNCTION_NAME", "")

UPLOAD_PREFIX = "uploads/guideline/"
MAX_FILE_NAME = 200
MAX_LABEL_CHARS = 80
MODES = ("standard", "guideline")

# kind -> (stored extension, upload Content-Type, accepted client types, max bytes)
_FILE_TYPES = {
    "markdown": (
        ".md", "text/markdown",
        ("text/markdown", "text/x-markdown", "text/plain", "application/octet-stream", ""),
        1024 * 1024,
    ),
    "docx": (
        ".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/octet-stream", ""),
        10 * 1024 * 1024,
    ),
    "pdf": (
        ".pdf", "application/pdf",
        ("application/pdf", "application/octet-stream", ""),
        10 * 1024 * 1024,
    ),
}
MAX_FILE_BYTES = max(t[3] for t in _FILE_TYPES.values())
_KEY_RE = re.compile(r"^uploads/guideline/[0-9a-f-]{36}\.(md|docx|pdf)$")
_KEY_KIND = {".md": "markdown", ".docx": "docx", ".pdf": "pdf"}
_UNSUPPORTED = "Please choose a Markdown (.md), Word (.docx) or PDF (.pdf) file."

_s3 = None
_lambda = None


def _s3_client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client(
            "s3",
            endpoint_url=f"https://s3.{REGION}.amazonaws.com",
            config=Config(s3={"addressing_style": "virtual"}, region_name=REGION, signature_version="s3v4"),
        )
    return _s3


def _lambda_client():
    global _lambda
    if _lambda is None:
        _lambda = boto3.client("lambda", region_name=REGION)
    return _lambda


def _bucket() -> str:
    bucket = os.environ.get("KNOWLEDGE_BASE_BUCKET_NAME")
    if not bucket:
        raise RuntimeError("KNOWLEDGE_BASE_BUCKET_NAME is not configured")
    return bucket


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body, default=str),
    }


def _admin_email(event) -> str:
    # Only the authorizer is trusted for audit fields; never the request body.
    authorizer = (event.get("requestContext") or {}).get("authorizer") or {}
    return normalize_email(authorizer.get("email")) or None


def _is_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


def _clean_file_name(name) -> str:
    name = os.path.basename(str(name or "")).strip()
    name = re.sub(r"[^\w .()\-]", "_", name)
    return name[:MAX_FILE_NAME]


def _kind_for_key(key: str) -> str | None:
    return _KEY_KIND.get(os.path.splitext(key)[1].lower())


def _size_limit_text(limit: int) -> str:
    return f"{limit // (1024 * 1024)} MB"


def _invoke(payload: dict) -> None:
    if not LAMBDA_FUNCTION_NAME:
        raise RuntimeError("LAMBDA_FUNCTION_NAME is not configured")
    _lambda_client().invoke(
        FunctionName=LAMBDA_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps(payload).encode("utf-8"),
    )


# ── Routing ───────────────────────────────────────────────────────────────────

_ROUTES = (
    ("GET", "/admin/guideline", re.compile(r"/admin/guideline$")),
    ("POST", "/admin/guideline/upload-url", re.compile(r"/admin/guideline/upload-url$")),
    ("POST", "/admin/guideline/documents", re.compile(r"/admin/guideline/documents$")),
    ("DELETE", "/admin/guideline/documents/{id}", re.compile(r"/admin/guideline/documents/[^/]+$")),
    ("PATCH", "/admin/guideline/sections/{id}", re.compile(r"/admin/guideline/sections/[^/]+$")),
    ("PUT", "/admin/guideline/mode", re.compile(r"/admin/guideline/mode$")),
)


def _match(event):
    method = event.get("httpMethod", "")
    resource = event.get("resource", "")
    path = event.get("path", "")
    for route_method, route_resource, pattern in _ROUTES:
        if method == route_method and (resource == route_resource or pattern.search(path or "")):
            return route_resource
    return None


def is_guideline_route(event) -> bool:
    return _match(event) is not None


def handle_guideline_request(event, body, connection):
    route = _match(event)
    path_id = (event.get("pathParameters") or {}).get("id")
    try:
        if route == "/admin/guideline":
            return _response(event, 200, get_guideline_state(connection))
        if route == "/admin/guideline/upload-url":
            return create_upload_url(event, body)
        if route == "/admin/guideline/documents":
            return register_document(event, body, connection)
        if route == "/admin/guideline/documents/{id}":
            return delete_document(event, connection, path_id)
        if route == "/admin/guideline/sections/{id}":
            return rename_section(event, body, connection, path_id)
        if route == "/admin/guideline/mode":
            return set_mode(event, body, connection)
    except Exception as e:  # noqa: BLE001
        try:
            connection.rollback()
        except Exception:  # noqa: BLE001
            pass
        logger.error("Guideline admin request failed (%s): %s", route, type(e).__name__, exc_info=True)
        return _response(event, 500, {"error": "Something went wrong. Please try again."})
    return _response(event, 404, {"error": "Route not found"})


# ── Handlers ──────────────────────────────────────────────────────────────────

def get_guideline_state(connection) -> dict:
    with connection.cursor() as cur:
        cur.execute("SELECT prompt_mode, updated_by, updated_at FROM guideline_config ORDER BY id LIMIT 1")
        row = cur.fetchone()
        mode = row[0] if row and row[0] in MODES else "standard"

        cur.execute(
            """
            SELECT id::text, file_name, status, error, section_count, uploaded_by, created_at, updated_at
            FROM guideline_documents
            ORDER BY created_at, id
            """
        )
        documents = [
            {
                "id": r[0], "file_name": r[1], "status": r[2], "error": r[3],
                "section_count": r[4], "uploaded_by": r[5],
                "created_at": r[6], "updated_at": r[7], "sections": [],
            }
            for r in cur.fetchall()
        ]

        cur.execute(
            """
            SELECT id::text, document_id::text, section_key, heading_path,
                   auto_label, label_override, summary
            FROM guideline_sections
            ORDER BY document_id, sort_order, section_key
            """
        )
        by_doc = {d["id"]: d for d in documents}
        for r in cur.fetchall():
            doc = by_doc.get(r[1])
            if doc is None:
                continue
            doc["sections"].append({
                "id": r[0], "section_key": r[2], "heading_path": r[3],
                "auto_label": r[4], "label_override": r[5],
                "label": (r[5] or "").strip() or r[4], "summary": r[6],
            })

    return {
        "mode": mode,
        "mode_updated_by": row[1] if row else None,
        "mode_updated_at": row[2] if row else None,
        "documents": documents,
        "limits": {"max_file_bytes": MAX_FILE_BYTES, "max_label_chars": MAX_LABEL_CHARS},
    }


def create_upload_url(event, body):
    file_name = _clean_file_name((body or {}).get("file_name"))
    content_type = str((body or {}).get("content_type") or "").split(";", 1)[0].strip().lower()
    kind = file_kind(file_name)
    if not file_name or kind is None:
        return _response(event, 400, {"error": _UNSUPPORTED})
    extension, upload_type, accepted_types, max_bytes = _FILE_TYPES[kind]
    if content_type not in accepted_types:
        return _response(event, 400, {"error": _UNSUPPORTED})

    key = f"{UPLOAD_PREFIX}{uuid.uuid4()}{extension}"
    url = _s3_client().generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": _bucket(), "Key": key, "ContentType": upload_type},
        ExpiresIn=300,
        HttpMethod="PUT",
    )
    return _response(event, 200, {
        "presignedUrl": url,
        "key": key,
        "contentType": upload_type,
        "maxBytes": max_bytes,
    })


def _object_size(key: str):
    head = _s3_client().head_object(Bucket=_bucket(), Key=key)
    return int(head.get("ContentLength") or 0)


def _delete_object_quietly(key: str) -> None:
    if not key or not key.startswith(UPLOAD_PREFIX):
        return
    try:
        _s3_client().delete_object(Bucket=_bucket(), Key=key)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not delete old guideline upload: %s", type(e).__name__)


def register_document(event, body, connection):
    body = body or {}
    s3_key = str(body.get("s3_key") or "")
    file_name = _clean_file_name(body.get("file_name"))
    replace_id = body.get("replace_document_id")

    if not _KEY_RE.match(s3_key):
        return _response(event, 400, {"error": "Invalid upload key."})
    key_kind = _kind_for_key(s3_key)
    # The display name must be the same kind of file as the stored object.
    if not file_name or file_kind(file_name) != key_kind:
        return _response(event, 400, {"error": _UNSUPPORTED})
    if replace_id is not None and not _is_uuid(replace_id):
        return _response(event, 400, {"error": "Invalid document id."})

    max_bytes = _FILE_TYPES[key_kind][3]
    try:
        size = _object_size(s3_key)
    except Exception:  # noqa: BLE001
        return _response(event, 400, {"error": "We couldn't find the uploaded file. Please try again."})
    if size > max_bytes:
        _delete_object_quietly(s3_key)
        return _response(event, 400, {
            "error": f"This file is larger than {_size_limit_text(max_bytes)}. Please split it into smaller files."
        })
    if size == 0:
        _delete_object_quietly(s3_key)
        return _response(event, 400, {"error": "This file is empty. Please check it and upload it again."})

    admin = _admin_email(event)
    old_key = None
    with connection.cursor() as cur:
        if replace_id:
            cur.execute(
                "SELECT s3_key FROM guideline_documents WHERE id = %s::uuid",
                (replace_id,),
            )
            existing = cur.fetchone()
            if not existing:
                return _response(event, 404, {"error": "Guide not found."})
            old_key = existing[0]
            cur.execute(
                """
                UPDATE guideline_documents
                   SET file_name = %s, s3_key = %s, uploaded_by = %s,
                       status = 'processing', error = NULL, updated_at = now()
                 WHERE id = %s::uuid
                RETURNING id::text
                """,
                (file_name, s3_key, admin, replace_id),
            )
        else:
            cur.execute(
                """
                INSERT INTO guideline_documents (file_name, s3_key, uploaded_by, status)
                VALUES (%s, %s, %s, 'processing')
                RETURNING id::text
                """,
                (file_name, s3_key, admin),
            )
        document_id = cur.fetchone()[0]
    connection.commit()

    if old_key and old_key != s3_key:
        _delete_object_quietly(old_key)

    try:
        _invoke({"task": "process_guideline_document", "document_id": document_id})
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to start guideline ingestion: %s", type(e).__name__)
        with connection.cursor() as cur:
            cur.execute(
                """
                UPDATE guideline_documents
                   SET status = 'failed', error = %s, updated_at = now()
                 WHERE id = %s::uuid
                """,
                ("We couldn't start reading this file. Please try uploading it again.", document_id),
            )
        connection.commit()
        return _response(event, 502, {"error": "We couldn't start reading this file. Please try again.", "id": document_id})

    return _response(event, 202, {"id": document_id, "status": "processing"})


def delete_document(event, connection, document_id):
    if not _is_uuid(document_id):
        return _response(event, 400, {"error": "Invalid document id."})
    with connection.cursor() as cur:
        cur.execute(
            "SELECT s3_key FROM guideline_documents WHERE id = %s::uuid",
            (document_id,),
        )
        row = cur.fetchone()
        if not row:
            return _response(event, 404, {"error": "Guide not found."})
        # chunks cascade from sources; guideline_sections cascade from the document.
        cur.execute("DELETE FROM sources WHERE url = %s", (guideline_source_url(document_id),))
        cur.execute("DELETE FROM guideline_documents WHERE id = %s::uuid", (document_id,))
    connection.commit()
    _delete_object_quietly(row[0])
    return _response(event, 200, {"id": document_id, "deleted": True})


def rename_section(event, body, connection, section_id):
    if not _is_uuid(section_id):
        return _response(event, 400, {"error": "Invalid situation id."})
    raw = (body or {}).get("label")
    if raw is not None and not isinstance(raw, str):
        return _response(event, 400, {"error": "Label must be text."})
    label = re.sub(r"\s+", " ", raw or "").strip()
    if len(label) > MAX_LABEL_CHARS:
        return _response(event, 400, {"error": f"Please keep the name under {MAX_LABEL_CHARS} characters."})

    with connection.cursor() as cur:
        cur.execute(
            """
            UPDATE guideline_sections
               SET label_override = %s, updated_at = now()
             WHERE id = %s::uuid
            RETURNING id::text, auto_label
            """,
            (label or None, section_id),
        )
        row = cur.fetchone()
    if not row:
        connection.rollback()
        return _response(event, 404, {"error": "Situation not found."})
    connection.commit()

    try:
        _invoke({"task": "reembed_guideline_sections", "section_ids": [section_id]})
    except Exception as e:  # noqa: BLE001
        # The rename is saved; search picks up the new name on the next upload.
        logger.error("Failed to start guideline re-embed: %s", type(e).__name__)

    return _response(event, 200, {
        "id": row[0],
        "label_override": label or None,
        "label": label or row[1],
    })


def set_mode(event, body, connection):
    mode = (body or {}).get("mode")
    if mode not in MODES:
        return _response(event, 400, {"error": "Mode must be 'standard' or 'guideline'."})
    admin = _admin_email(event)
    with connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO guideline_config (id, prompt_mode, updated_by, updated_at)
            VALUES (1, %s, %s, now())
            ON CONFLICT (id) DO UPDATE SET
              prompt_mode = EXCLUDED.prompt_mode,
              updated_by  = EXCLUDED.updated_by,
              updated_at  = now()
            """,
            (mode, admin),
        )
    connection.commit()
    logger.info("Guideline prompt_mode set to %s", mode)
    return _response(event, 200, {"mode": mode})
