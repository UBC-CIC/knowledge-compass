import json
import logging

from helpers.admin_user import (
    admin_email_from_request,
    admin_sub_from_request,
    get_or_create_admin_user_id,
)
from kc_shared.cors import get_cors_headers
from helpers.ingestion_lock import reject_if_locked

logger = logging.getLogger()
logger.setLevel(logging.INFO)


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


def _data_source_type(connection, data_source_id: str) -> str | None:
    """The data source's type, or None when it does not exist."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT type FROM data_sources WHERE id = %s::uuid LIMIT 1",
            (data_source_id,),
        )
        row = cursor.fetchone()
        return row[0] if row else None


def _can_requeue(source_type: str, latest_status: str | None) -> bool:
    """
    A failed source can always be retried. A website whose latest run
    completed can also be re-crawled to pick up changes to the site. Anything
    pending, queued or running is already in flight and is left alone.
    """
    if latest_status == "failed":
        return True
    return source_type == "website" and latest_status == "completed"


def _latest_ingestion_run(connection, data_source_id: str) -> dict | None:
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
        if not row:
            return None
        return {"id": str(row[0]), "status": row[1]}


def _insert_retry_run(
    connection, *, data_source_id: str, retry_of_ingestion_run_id: str, action: str = "manual_retry"
) -> str:
    """
    Create a new 'pending' ingestion_runs row for a manual admin retry or re-crawl.

    Reuses the same pending -> queued -> running state machine as a fresh
    stage: the row shows up as "Pending" and is picked up the next time an
    admin clicks Sync now.
    """
    metadata = {
        "action": action,
        "retry_of_ingestion_run_id": retry_of_ingestion_run_id,
    }
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO ingestion_runs (
                data_source_id,
                status,
                error_message,
                metadata
            )
            VALUES (%s::uuid, 'pending'::ingestion_status, NULL, %s::jsonb)
            RETURNING id
            """,
            (data_source_id, json.dumps(metadata)),
        )
        row = cursor.fetchone()
        return str(row[0])


def retry_ingestion_run(event, body, connection, data_source_id: str):
    """
    Re-queue a failed data source for another ingestion attempt, or a
    completed website for a re-crawl.

    This method:
    - validates the requesting admin
    - confirms the data source exists and its latest run is 'failed', or
      'completed' for a website
    - inserts a new 'pending' ingestion_runs row pointing at the same source

    A re-crawl reuses the crawler's change detection: only chunks whose
    content changed are re-embedded, and the current content keeps serving
    until it is replaced.

    Ingestion itself is not started here; the new pending run is picked up by
    the existing Sync now flow (start_ingestion_job), same as any other
    staged source.
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

    source_type = _data_source_type(connection, data_source_id)
    if source_type is None:
        return _response(event, 404, {"error": "Data source not found"})

    latest_run = _latest_ingestion_run(connection, data_source_id)
    latest_status = latest_run["status"] if latest_run else None
    if not _can_requeue(source_type, latest_status):
        return _response(
            event,
            409,
            {
                "error": (
                    "Only data sources whose latest ingestion run failed can be retried, "
                    "and only completed websites can be re-crawled."
                ),
                "current_status": latest_status,
            },
        )

    is_recrawl = latest_status == "completed"
    try:
        pending_run_id = _insert_retry_run(
            connection,
            data_source_id=data_source_id,
            retry_of_ingestion_run_id=latest_run["id"],
            action="manual_recrawl" if is_recrawl else "manual_retry",
        )
        connection.commit()
    except Exception as e:
        connection.rollback()
        logger.error("Failed to queue retry for data source %s: %s", data_source_id, e, exc_info=True)
        return _response(event, 500, {"error": "Failed to queue retry"})

    return _response(
        event,
        200,
        {
            "message": (
                "Website queued for re-crawl. Click Sync now to run it."
                if is_recrawl
                else "Resource re-queued. Click Sync now to run it."
            ),
            "action": "recrawl_queued" if is_recrawl else "retry_queued",
            "data_source_id": data_source_id,
            "retry_of_ingestion_run_id": latest_run["id"],
            "pending_ingestion_run_id": pending_run_id,
        },
    )
