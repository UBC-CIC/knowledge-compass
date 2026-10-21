import os
import json
import logging
from uuid import uuid4

from helpers.admin_user import (
    admin_email_from_request,
    admin_sub_from_request,
    get_or_create_admin_user_id,
)
from helpers.cors import get_cors_headers
from helpers.ingestion_lock import reject_if_locked
from helpers.process_crawler_batch import process_crawler_batch
from helpers.process_document_batch import trigger_document_batch

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]


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


def _promote_pending_to_queued(connection, *, sync_session_id: str) -> int:
    """
    Promote the latest pending ingestion run for each data source to queued.
    This is the first step of a sync session. It marks staged work as officially
    selected for ingestion and stamps the runs with the sync_session_id so the
    rest of the workflow can track them as part of the same sync.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.id,
                    ir.data_source_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            UPDATE ingestion_runs ir
            SET
                status = 'queued'::ingestion_status,
                metadata = COALESCE(ir.metadata, '{}'::jsonb) || %s::jsonb
            FROM latest_runs lr
            JOIN data_sources ds ON ds.id = lr.data_source_id
            WHERE ir.id = lr.id
              AND lr.rn = 1
              AND ir.status = 'pending'::ingestion_status
              AND NOT (
                ds.type = 'video'::data_source_type
                AND COALESCE(ds.metadata->>'transcribe_status', '') <> 'COMPLETED'
              )
            """,
            (json.dumps({"sync_session_id": sync_session_id}),),
        )
        return cursor.rowcount


def start_ingestion_job(event, body, connection):
    """
    Start a new sync session for staged data sources.

    This method:
    - validates the requesting admin
    - creates a new sync_session_id
    - promotes pending ingestion runs to queued
    - launches ECS crawler/transcriber tasks for website/video sources and an
      async self-invocation for csv/markdown/json sources
    - returns whether any ingestion work was actually started

    The actual ingestion work is delegated to:
    - process_crawler_batch(...)   (website/video, via ECS Fargate)
    - trigger_document_batch(...)  (csv/markdown/json, via async Lambda self-invoke)
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

    created_by_user_id = get_or_create_admin_user_id(connection, admin_sub, created_by)
    if not created_by_user_id:
        return _response(event, 400, {"error": "Admin user not found in database"})
    connection.commit()

    sync_session_id = uuid4().hex

    try:
        queued_count = _promote_pending_to_queued(
            connection,
            sync_session_id=sync_session_id,
        )
        connection.commit()

        if queued_count == 0:
            return _response(
                event,
                409,
                {
                    "error": "No pending data sources found to queue.",
                    "sync_session_id": sync_session_id,
                },
            )

        # Launch ECS crawler/transcriber tasks for website/video, and an async
        # self-invocation for csv/markdown/json (see helpers/process_document_batch.py).
        # Each self-finalizes its own ingestion_runs row(s), independent of this
        # request's lifecycle.
        crawler_started = process_crawler_batch(
            event=event,
            connection=connection,
            sync_session_id=sync_session_id,
            triggered_by_scheduler=False,
        )
        document_started = trigger_document_batch(
            event=event,
            connection=connection,
            sync_session_id=sync_session_id,
        )
        started = crawler_started.get("started") or document_started.get("started")
        status_code = 200 if started else 409
        return _response(
            event,
            status_code,
            {
                "message": (
                    "Pending data sources queued and ingestion tasks started."
                    if started
                    else "Pending data sources were queued, but no ingestion tasks could be started."
                ),
                "action": "queued_and_started_pgvector_ingestion",
                "sync_session_id": sync_session_id,
                "queued_count": queued_count,
                "details": {"crawler": crawler_started, "documents": document_started},
            },
        )

    except Exception as e:
        connection.rollback()
        logger.error("Failed to start ingestion job orchestration: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Failed to start ingestion job orchestration"})