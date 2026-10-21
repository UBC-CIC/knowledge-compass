import os
import json
import secrets
import time
import logging
import boto3
from botocore.config import Config
from helpers.admin_user import admin_sub_from_request
from helpers.cors import get_cors_headers
from helpers.upload_identity import sanitize_file_name
from helpers.upload_issuance import record_issued_uploads

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET = os.environ["KNOWLEDGE_BASE_BUCKET_NAME"]
REGION = os.environ["REGION"]

MAX_FILES = 200  # cap per batch request

ALLOWED_CONTENT_TYPES = {
    "text/csv",
    "text/markdown",
    "application/json",
    "text/json",
    "application/octet-stream",
}

s3 = boto3.client(
    "s3",
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(
        s3={"addressing_style": "virtual"},
        region_name=REGION,
        signature_version="s3v4",
    ),
)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body),
    }


def _base_name(file_name: str) -> str:
    return os.path.basename(file_name).strip()


def _infer_upload_prefix(file_name: str, content_type: str) -> str:
    lower = file_name.lower()
    if lower.endswith(".csv") or content_type == "text/csv":
        return "uploads/csv"
    if lower.endswith(".md") or lower.endswith(".markdown") or content_type == "text/markdown":
        return "uploads/markdown"
    if lower.endswith(".json") or content_type in {"application/json", "text/json"}:
        return "uploads/json"
    return "uploads/files"


def generate_presigned_urls_batch(event, body, connection):
    # Keys are recorded against this sub; staging only accepts them from the
    # same admin (helpers/upload_issuance.py).
    admin_sub = admin_sub_from_request(event)
    if not admin_sub:
        return _response(event, 401, {"error": "Unauthorized"})

    files = body.get("files")

    if not isinstance(files, list) or len(files) == 0:
        return _response(event, 400, {"error": "files must be a non-empty array"})

    if len(files) > MAX_FILES:
        return _response(event, 400, {"error": f"Too many files. Maximum is {MAX_FILES} per batch."})

    timestamp = int(time.time())
    results = []

    for i, entry in enumerate(files):
        file_name = entry.get("file_name", "")
        content_type = entry.get("content_type", "application/octet-stream")

        # `file_name` is echoed back for the caller to match results to its
        # files; the S3 key uses the same sanitizer as single uploads.
        file_name = _base_name(file_name)
        if not file_name:
            return _response(event, 400, {"error": f"files[{i}]: invalid or missing file_name"})

        if content_type not in ALLOWED_CONTENT_TYPES:
            return _response(
                event,
                400,
                {"error": f"files[{i}]: unsupported content_type '{content_type}'"},
            )

        prefix = _infer_upload_prefix(file_name, content_type)
        # The random part keeps names that sanitize alike ("a b.csv",
        # "a_b.csv") from overwriting each other's object, and two admins'
        # uploads from sharing a key; staging then rejects the second of a
        # same-named pair as a duplicate.
        key = f"{prefix}/{timestamp}_{secrets.token_hex(8)}_{sanitize_file_name(file_name)}"

        try:
            presigned_url = s3.generate_presigned_url(
                ClientMethod="put_object",
                Params={"Bucket": BUCKET, "Key": key, "ContentType": content_type},
                ExpiresIn=600,  # 10 min — longer window for batch uploads
                HttpMethod="PUT",
            )
        except Exception as e:
            logger.error("Error generating presigned URL for %s: %s", file_name, e, exc_info=True)
            return _response(event, 500, {"error": f"Failed to generate presigned URL for {file_name}"})

        results.append({
            "file_name": file_name,
            "presigned_url": presigned_url,
            "key": key,
            "bucket": BUCKET,
        })

    try:
        record_issued_uploads(
            connection, issued_to=admin_sub, bucket=BUCKET, keys=[entry["key"] for entry in results]
        )
        connection.commit()
    except Exception as e:
        connection.rollback()
        logger.error("Failed to record issued upload keys: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to generate presigned URLs"})

    return _response(event, 200, {"presigned_urls": results})
