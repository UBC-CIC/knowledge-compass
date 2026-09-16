import os
import json
import re
from helpers.cors import get_cors_headers
import time
import boto3
import logging
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET = os.environ["KNOWLEDGE_BASE_BUCKET_NAME"]
REGION = os.environ["REGION"]

ALLOWED_CONTENT_TYPES = {
    "text/csv",
    "text/markdown",
    "application/json",
    "text/json",
    "application/octet-stream",
    "video/mp4",
    "video/webm",
    "video/x-m4v",
    "video/mpeg",
    "video/quicktime",
    "video/x-mp4",
    "application/mp4",
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/x-m4a",
    "audio/flac",
    "audio/ogg",
    "audio/amr",
}

VIDEO_EXTENSIONS = (
    ".mp4",
    ".m4v",
    ".mp3",
    ".wav",
    ".flac",
    ".ogg",
    ".amr",
    ".webm",
    ".m4a",
)

EXT_TO_CONTENT_TYPE = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".amr": "audio/amr",
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
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }

def _sanitize_file_name(file_name: str) -> str:
    base = os.path.basename(file_name).strip()
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"[^\w.\-]+", "_", stem, flags=re.UNICODE)
    stem = re.sub(r"_+", "_", stem).strip("._") or "upload"
    ext = re.sub(r"[^\w.]", "", ext.lower())
    return f"{stem}{ext}"[:180]


def _normalize_content_type(content_type: str) -> str:
    normalized = (content_type or "application/octet-stream").strip().lower()
    return normalized.split(";", 1)[0].strip() or "application/octet-stream"


def _content_type_for_file(file_name: str, content_type: str) -> str:
    """Keep a client type if it is allowed; otherwise map known video extensions."""
    if content_type in ALLOWED_CONTENT_TYPES:
        return content_type
    lower_name = file_name.lower()
    for ext, canonical in EXT_TO_CONTENT_TYPE.items():
        if lower_name.endswith(ext):
            return canonical
    return content_type

def _is_markdown_file(file_name: str) -> bool:
    lower_name = file_name.lower()
    return lower_name.endswith(".md") or lower_name.endswith(".markdown")

def _is_video_file(file_name: str) -> bool:
    lower_name = file_name.lower()
    return lower_name.endswith(VIDEO_EXTENSIONS)


def _infer_upload_prefix(file_name: str, content_type: str) -> str:
    lower_name = file_name.lower()

    if lower_name.endswith(".csv") or content_type == "text/csv":
        return "uploads/csv"

    if _is_markdown_file(file_name) or content_type == "text/markdown":
        return "uploads/markdown"

    if lower_name.endswith(".json") or content_type in {"application/json", "text/json"}:
        return "uploads/json"

    if _is_video_file(file_name) or content_type.startswith("video/") or content_type.startswith("audio/"):
        return "uploads/video"

    return "uploads/files"

def generate_presigned_url(event):
    query_params = event.get("queryStringParameters") or {}

    file_name = query_params.get("file_name")
    content_type = _normalize_content_type(query_params.get("content_type", "application/octet-stream"))

    if not file_name:
        return _response(event, 400, {"error": "Missing file_name parameter"})

    file_name = _sanitize_file_name(file_name)
    if not file_name:
        return _response(event, 400, {"error": "Invalid file_name parameter"})

    content_type = _content_type_for_file(file_name, content_type)

    if content_type not in ALLOWED_CONTENT_TYPES:
        return _response(
            event,
            400,
            {
                "error": "Unsupported content_type",
                "allowed_content_types": sorted(ALLOWED_CONTENT_TYPES),
            },
        )

    lower_name = file_name.lower()

    if lower_name.endswith(".csv") and content_type not in {"text/csv", "application/octet-stream"}:
        return _response(event, 400, {"error": "CSV files must use content_type text/csv or application/octet-stream"})

    if _is_markdown_file(file_name) and content_type not in {"text/markdown", "application/octet-stream"}:
        return _response(event, 400, {"error": "Markdown files must use content_type text/markdown or application/octet-stream"})

    if lower_name.endswith(".json") and content_type not in {"application/json", "text/json", "application/octet-stream"}:
        return _response(event, 400, {"error": "JSON files must use content_type application/json, text/json, or application/octet-stream"})

    prefix = _infer_upload_prefix(file_name, content_type)
    timestamp = int(time.time())
    key = f"{prefix}/{timestamp}_{file_name}"
    expires_in = 3600 if prefix == "uploads/video" else 300

    try:
        presigned_url = s3.generate_presigned_url(
            ClientMethod="put_object",
            Params={
                "Bucket": BUCKET,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires_in,
            HttpMethod="PUT",
        )

        return _response(
            event,
            200,
            {
                "presignedUrl": presigned_url,
                "key": key,
                "bucket": BUCKET,
            },
        )

    except Exception as e:
        logger.error("Error generating presigned URL: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to generate presigned URL"})