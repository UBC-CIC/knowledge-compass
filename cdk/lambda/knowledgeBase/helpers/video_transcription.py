import json
import logging
import os
import re
from uuid import uuid4

import boto3

from helpers.ingestion_lock import is_locked
from helpers.process_crawler_batch import launch_transcriber_for_run

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]
TRANSCRIBE_DATA_ACCESS_ROLE_ARN = os.environ.get("TRANSCRIBE_DATA_ACCESS_ROLE_ARN", "")
TRANSCRIBE_OUTPUT_PREFIX = os.environ.get("TRANSCRIBE_OUTPUT_PREFIX", "transcripts").rstrip("/")

EXT_TO_MEDIA_FORMAT = {
    ".mp4": "mp4",
    ".m4v": "mp4",
    ".mp3": "mp3",
    ".wav": "wav",
    ".flac": "flac",
    ".ogg": "ogg",
    ".amr": "amr",
    ".webm": "webm",
    ".m4a": "m4a",
}

transcribe_client = boto3.client("transcribe", region_name=REGION)


def media_format_for_file_name(file_name: str) -> str | None:
    lower = file_name.lower()
    for ext, fmt in EXT_TO_MEDIA_FORMAT.items():
        if lower.endswith(ext):
            return fmt
    return None


def start_transcription_job(*, bucket: str, key: str, file_name: str) -> dict:
    media_format = media_format_for_file_name(file_name)
    if not media_format:
        raise ValueError(
            "Unsupported video/audio type. Use mp4, webm, mp3, wav, flac, ogg, m4a, or amr."
        )

    job_name = f"kc-video-{uuid4().hex}"
    output_key = f"{TRANSCRIBE_OUTPUT_PREFIX}/{job_name}.json"
    params = {
        "TranscriptionJobName": job_name,
        "LanguageCode": "en-US",
        "MediaFormat": media_format,
        "Media": {"MediaFileUri": f"s3://{bucket}/{key}"},
        "OutputBucketName": bucket,
        "OutputKey": output_key,
    }
    # DataAccessRoleArn is only valid inside JobExecutionSettings, and only
    # together with AllowDeferredExecution. A top-level DataAccessRoleArn is
    # rejected by boto3 as ParamValidationError.
    if TRANSCRIBE_DATA_ACCESS_ROLE_ARN:
        params["JobExecutionSettings"] = {
            "AllowDeferredExecution": True,
            "DataAccessRoleArn": TRANSCRIBE_DATA_ACCESS_ROLE_ARN,
        }

    transcribe_client.start_transcription_job(**params)
    return {
        "transcribe_job_name": job_name,
        "transcript_s3_uri": f"s3://{bucket}/{output_key}",
        "media_format": media_format,
    }


def handle_transcribe_complete(event, connection):
    detail = event.get("detail") or {}
    job_name = detail.get("TranscriptionJobName")
    status = (detail.get("TranscriptionJobStatus") or "").upper()

    if not job_name or status not in {"COMPLETED", "FAILED"}:
        logger.info("Ignoring Transcribe event: %s %s", job_name, status)
        return {"ignored": True}

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                ds.id,
                ds.name,
                ds.metadata,
                ir.id,
                ir.status
            FROM data_sources ds
            JOIN ingestion_runs ir ON ir.data_source_id = ds.id
            WHERE ds.type = 'video'::data_source_type
              AND ds.metadata->>'transcribe_job_name' = %s
            ORDER BY ir.created_at DESC, ir.id DESC
            LIMIT 1
            """,
            (job_name,),
        )
        row = cursor.fetchone()

    if not row:
        logger.warning("No video data source found for Transcribe job %s", job_name)
        return {"error": "data source not found", "job_name": job_name}

    data_source_id, name, metadata, ingestion_run_id, run_status = (
        str(row[0]),
        row[1],
        row[2] or {},
        str(row[3]),
        row[4],
    )
    metadata = dict(metadata)

    if status == "FAILED":
        failure = detail.get("FailureReason") or "Amazon Transcribe job failed"
        try:
            failure = (
                transcribe_client.get_transcription_job(TranscriptionJobName=job_name)
                .get("TranscriptionJob", {})
                .get("FailureReason")
                or failure
            )
        except Exception:
            logger.exception("Could not load Transcribe failure reason for %s", job_name)

        metadata["transcribe_status"] = "FAILED"
        metadata["transcribe_error"] = failure[:1000]
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE data_sources
                SET metadata = %s::jsonb
                WHERE id = %s::uuid
                """,
                (json.dumps(metadata), data_source_id),
            )
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET status = 'failed'::ingestion_status,
                    error_message = %s,
                    completed_at = now()
                WHERE id = %s::uuid
                """,
                (failure[:1000], ingestion_run_id),
            )
        connection.commit()
        return {"job_name": job_name, "status": "failed", "name": name}

    metadata["transcribe_status"] = "COMPLETED"
    metadata["transcript_s3_uri"] = (
        metadata.get("transcribe_output_s3_uri")
        or metadata.get("transcript_s3_uri")
        or f"s3://{os.environ.get('KNOWLEDGE_BASE_BUCKET_NAME', '')}/{TRANSCRIBE_OUTPUT_PREFIX}/{job_name}.json"
    )
    metadata["action"] = "transcript_ready"

    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE data_sources
            SET metadata = %s::jsonb
            WHERE id = %s::uuid
            """,
            (json.dumps(metadata), data_source_id),
        )
    connection.commit()

    if run_status in ("pending", "queued"):
        # Held until launch_transcriber_for_run commits the run as 'running' (or the
        # rollback below): a cutover either sees the lock here or waits for that commit
        # and then counts the run in wait_idle.
        if is_locked(connection, hold=True):
            # Keep the transcript: the run stays pending and the next sync launches it.
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE ingestion_runs
                    SET status = 'pending'::ingestion_status,
                        metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                    WHERE id = %s::uuid
                    """,
                    (
                        json.dumps({"source": "transcribe_complete", "deferred_by_cutover": True}),
                        ingestion_run_id,
                    ),
                )
            connection.commit()
            logger.info("Cutover in progress; deferred transcriber launch for run %s", ingestion_run_id)
            return {"job_name": job_name, "status": "deferred", "ingestion_run_id": ingestion_run_id}

        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE ingestion_runs
                SET status = 'queued'::ingestion_status,
                    metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
                WHERE id = %s::uuid
                """,
                (json.dumps({"source": "transcribe_complete"}), ingestion_run_id),
            )
        try:
            launched = launch_transcriber_for_run(
                connection,
                ingestion_run_id=ingestion_run_id,
                sync_session_id=f"transcribe-{job_name}",
            )
            return {
                "job_name": job_name,
                "status": "completed",
                "ingestion_run_id": ingestion_run_id,
                "launched": launched,
            }
        except Exception as e:
            logger.exception("Failed to launch transcriber for %s", ingestion_run_id)
            connection.rollback()
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE ingestion_runs
                    SET status = 'failed'::ingestion_status,
                        error_message = %s,
                        completed_at = now()
                    WHERE id = %s::uuid
                    """,
                    (str(e)[:1000], ingestion_run_id),
                )
            connection.commit()
            return {"job_name": job_name, "status": "launch_failed", "error": str(e)[:500]}

    return {"job_name": job_name, "status": "already_processed", "run_status": run_status}


def is_http_url(value: str) -> bool:
    return bool(re.match(r"^https?://", value.strip(), re.IGNORECASE))
