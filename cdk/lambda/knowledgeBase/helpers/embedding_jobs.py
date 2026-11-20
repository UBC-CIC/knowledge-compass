"""
Shared plumbing for the embedding-space jobs (migration 033, table embedding_jobs).

reembed_space, validate_space and cutover all read and write the same job row, are
started by an Event self-invocation and report through the same polling endpoint.
This module holds the pieces they share: the row <-> dict mapping, status updates,
the self-invoke, a short error summary and the CloudWatch metric line.

Job rows, logs and API responses carry ids, counts, step names and error CLASS names
only. They never contain chunk text, queries or credentials.
"""

import json
import logging
import os
import time
from typing import Any, Dict, Optional

import boto3

from helpers.worker_envelope import worker_payload

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ.get("REGION", "ca-central-1")
LAMBDA_FUNCTION_NAME = os.environ.get("LAMBDA_FUNCTION_NAME", "")

METRIC_NAMESPACE = "KnowledgeCompass/Embeddings"
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled")

JOB_COLUMNS = """
    id::text, space_id::text, mode, status, total_chunks, processed, failed,
    est_tokens, est_cost_usd, est_seconds, price_configured, cursor, continuation,
    current_step, steps, report, last_error, requested_by,
    created_at, started_at, finished_at, updated_at"""

_lambda = None


def _lambda_client():
    global _lambda
    if _lambda is None:
        _lambda = boto3.client("lambda", region_name=REGION)
    return _lambda


def _json_value(value, default):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return default
    return default if value is None else value


def _number(value):
    """Decimal / numeric text -> float for JSON; None stays None."""
    return None if value is None else float(value)


def row_to_job(row) -> Dict[str, Any]:
    return {
        "id": str(row[0]),
        "space_id": str(row[1]),
        "mode": row[2],
        "status": row[3],
        "total_chunks": row[4],
        "processed": row[5] or 0,
        "failed": row[6] or 0,
        "est_tokens": row[7],
        "est_cost_usd": _number(row[8]),
        "est_seconds": row[9],
        "price_configured": bool(row[10]),
        "cursor": row[11],
        "continuation": row[12] or 0,
        "current_step": row[13],
        "steps": _json_value(row[14], []),
        "report": _json_value(row[15], None),
        "last_error": row[16],
        "requested_by": row[17],
        "created_at": row[18],
        "started_at": row[19],
        "finished_at": row[20],
        "updated_at": row[21],
    }


def load_job(connection, job_id: str) -> Optional[Dict[str, Any]]:
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT {JOB_COLUMNS} FROM embedding_jobs WHERE id = %s::uuid", (str(job_id),))
        row = cursor.fetchone()
    return row_to_job(row) if row else None


def mark_running(connection, job_id: str, continuation: int = 0) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE embedding_jobs
               SET status = 'running',
                   started_at = COALESCE(started_at, now()),
                   continuation = GREATEST(continuation, %s),
                   updated_at = now()
             WHERE id = %s::uuid AND status IN ('queued', 'running')
            """,
            (int(continuation), str(job_id)),
        )
    connection.commit()


def finish_job(
    connection,
    job_id: str,
    status: str,
    *,
    last_error: Optional[str] = None,
    report: Optional[dict] = None,
) -> None:
    """Move a job to a terminal status. `report`, when given, replaces the stored report."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE embedding_jobs
               SET status = %s,
                   finished_at = now(),
                   updated_at = now(),
                   last_error = COALESCE(%s, last_error),
                   report = COALESCE(%s::jsonb, report)
             WHERE id = %s::uuid
            """,
            (status, last_error, None if report is None else json.dumps(report), str(job_id)),
        )
    connection.commit()


def rollback_quietly(connection) -> None:
    """End an aborted transaction so later statements on this connection work."""
    try:
        connection.rollback()
    except Exception:  # noqa: BLE001
        pass


def error_summary(error: BaseException) -> str:
    """Class name (plus the AWS error code, when there is one). Never the message text."""
    name = type(error).__name__
    response = getattr(error, "response", None)
    code = ((response or {}).get("Error") or {}).get("Code") if isinstance(response, dict) else None
    return f"{name} ({code})" if code and code != name else name


def invoke_self(payload: dict) -> None:
    """Fire the next invocation of this Lambda asynchronously (InvocationType=Event)."""
    if not LAMBDA_FUNCTION_NAME:
        raise RuntimeError("LAMBDA_FUNCTION_NAME is not configured")
    _lambda_client().invoke(
        FunctionName=LAMBDA_FUNCTION_NAME,
        InvocationType="Event",
        Payload=worker_payload(payload),
    )


def emit_metric(name: str, code: str) -> None:
    """
    CloudWatch Embedded Metric Format line on stdout (the Lambda log pipeline turns it
    into a metric; no PutMetricData permission). It must be the whole log line, so it is
    printed rather than logged. The empty dimension set publishes the un-dimensioned
    aggregate that the alarms use.
    """
    print(json.dumps({
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": METRIC_NAMESPACE,
                "Dimensions": [["Code"], []],
                "Metrics": [{"Name": name, "Unit": "Count"}],
            }],
        },
        "Code": code,
        name: 1,
    }))


def time_left_fn(context, default_seconds: int = 600):
    """Seconds left in this invocation, from the Lambda context when there is one."""
    if context is not None and hasattr(context, "get_remaining_time_in_millis"):
        return lambda: context.get_remaining_time_in_millis() / 1000
    started = time.monotonic()
    return lambda: default_seconds - (time.monotonic() - started)
