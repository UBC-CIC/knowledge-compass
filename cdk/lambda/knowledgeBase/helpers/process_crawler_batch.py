"""
process_crawler_batch.py

pgvector ingestion path (item R3; see Project Refactoring/PGVECTOR_MIGRATION_PLAN.md).

This is the pgvector-backend counterpart to process_s3_batch.py / process_website_batch.py.
Instead of driving Amazon Bedrock ingestion jobs, it launches the containerized
crawler / transcriber as ECS Fargate tasks (ecs:RunTask). Each task adopts its
ingestion_runs row via the JOB_ID env var and self-finalizes the run
(completed/failed) using the code already in crawler.py / transcrbe.py — so no
scheduler polling is required for this path.

State machine reused unchanged: stage_data_sources -> 'pending';
start_ingestion_job promotes -> 'queued'; this module marks -> 'running'; the
ECS task sets -> 'completed' | 'failed'.

Env vars required (set on lambdaKnowledgeBase when INGESTION_BACKEND=pgvector):
  REGION
  ECS_CLUSTER_ARN            ECS cluster to run tasks in
  CRAWLER_TASK_DEF_ARN       task definition for the web crawler container
  TRANSCRIBER_TASK_DEF_ARN   task definition for the transcriber container
  INGESTION_SUBNET_IDS       comma-separated private subnet IDs (awsvpc networking)
  INGESTION_SECURITY_GROUP_IDS  comma-separated security group IDs
  CRAWLER_CONTAINER_NAME     container name in the crawler task def (default: crawler)
  TRANSCRIBER_CONTAINER_NAME container name in the transcriber task def (default: transcriber)
"""

import json
import logging
import os

import boto3

from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]

# ECS wiring (only required when INGESTION_BACKEND=pgvector).
ECS_CLUSTER_ARN = os.environ.get("ECS_CLUSTER_ARN")
CRAWLER_TASK_DEF_ARN = os.environ.get("CRAWLER_TASK_DEF_ARN")
TRANSCRIBER_TASK_DEF_ARN = os.environ.get("TRANSCRIBER_TASK_DEF_ARN")
INGESTION_SUBNET_IDS = [s for s in os.environ.get("INGESTION_SUBNET_IDS", "").split(",") if s]
INGESTION_SECURITY_GROUP_IDS = [s for s in os.environ.get("INGESTION_SECURITY_GROUP_IDS", "").split(",") if s]
CRAWLER_CONTAINER_NAME = os.environ.get("CRAWLER_CONTAINER_NAME", "crawler")
TRANSCRIBER_CONTAINER_NAME = os.environ.get("TRANSCRIBER_CONTAINER_NAME", "transcriber")

ecs_client = boto3.client("ecs", region_name=REGION)


def _response(event, status_code: int, body: dict):
    """Build a standard API Gateway JSON response with CORS headers."""
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body),
    }


def _latest_queued_runs(connection, data_source_types: list[str]) -> list[dict]:
    """
    Return the latest ingestion run per data source with status 'queued' for the
    given data_source types, including the fields the container tasks need.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            WITH latest_runs AS (
                SELECT
                    ir.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY ir.data_source_id
                        ORDER BY ir.created_at DESC, ir.id DESC
                    ) AS rn
                FROM ingestion_runs ir
            )
            SELECT
                lr.id,
                lr.data_source_id,
                ds.name,
                ds.type,
                ds.include_patterns,
                ds.exclude_patterns,
                ds.metadata
            FROM latest_runs lr
            JOIN data_sources ds ON ds.id = lr.data_source_id
            WHERE lr.rn = 1
              AND lr.status = 'queued'::ingestion_status
              AND ds.type = ANY(%s::data_source_type[])
            ORDER BY ds.created_at ASC, ds.id ASC
            """,
            (data_source_types,),
        )
        rows = cursor.fetchall()
        return [
            {
                "ingestion_run_id": str(row[0]),
                "data_source_id": str(row[1]),
                "name": row[2],
                "type": row[3],
                "include_patterns": row[4] or [],
                "exclude_patterns": row[5] or [],
                "data_source_metadata": row[6] or {},
            }
            for row in rows
        ]


def _mark_run_running(connection, *, ingestion_run_id: str, ecs_task_arn: str, sync_session_id: str):
    """Mark a single ingestion run as running and record the ECS task on it."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET status = 'running'::ingestion_status,
                started_at = now(),
                metadata = COALESCE(metadata, '{}'::jsonb) || %s::jsonb
            WHERE id = %s::uuid
            """,
            (
                json.dumps(
                    {
                        "backend": "pgvector",
                        "sync_session_id": sync_session_id,
                        "ecs_task_arn": ecs_task_arn,
                    }
                ),
                ingestion_run_id,
            ),
        )


def _network_configuration() -> dict:
    return {
        "awsvpcConfiguration": {
            "subnets": INGESTION_SUBNET_IDS,
            "securityGroups": INGESTION_SECURITY_GROUP_IDS,
            "assignPublicIp": "DISABLED",
        }
    }


def _task_arn_from_run_task(resp: dict, *, kind: str) -> str:
    """Raise if ecs.RunTask returned failures / no task instead of indexing [0]."""
    failures = resp.get("failures") or []
    tasks = resp.get("tasks") or []
    if failures or not tasks:
        reasons = "; ".join(
            f"{f.get('arn', 'n/a')}: {f.get('reason', 'unknown')}" for f in failures
        ) or "ecs.RunTask returned no tasks"
        raise RuntimeError(f"{kind} RunTask failed: {reasons}")
    arn = tasks[0].get("taskArn")
    if not arn:
        raise RuntimeError(f"{kind} RunTask returned a task without taskArn")
    return arn


def handle_ecs_task_stopped(event, connection) -> dict:
    """
    Fail an ingestion_runs row that is still 'running' after its ECS task stops.

    Successful tasks finalize the row themselves (completed/failed) before exit;
    this only catches crashes that never reached the DB.
    """
    detail = event.get("detail") or {}
    if (detail.get("lastStatus") or "").upper() != "STOPPED":
        return {"ignored": True, "reason": "not_stopped"}

    task_arn = detail.get("taskArn")
    if not task_arn:
        return {"ignored": True, "reason": "missing_task_arn"}

    stopped_reason = detail.get("stoppedReason") or "ECS task stopped"
    container_bits = []
    for container in detail.get("containers") or []:
        exit_code = container.get("exitCode")
        reason = container.get("reason") or ""
        if exit_code not in (None, 0) or reason:
            name = container.get("name") or "container"
            container_bits.append(f"{name}: exit={exit_code} {reason}".strip())
    error = stopped_reason
    if container_bits:
        error = f"{stopped_reason}; " + "; ".join(container_bits)
    error = error[:1000]

    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE ingestion_runs
            SET status = 'failed'::ingestion_status,
                error_message = %s,
                completed_at = now(),
                finished_at = now()
            WHERE metadata->>'ecs_task_arn' = %s
              AND status = 'running'::ingestion_status
            RETURNING id
            """,
            (error, task_arn),
        )
        row = cursor.fetchone()
    connection.commit()

    if not row:
        logger.info("No running ingestion run for stopped task %s", task_arn)
        return {"ignored": True, "task_arn": task_arn}

    logger.warning("Marked ingestion run %s failed after ECS task stopped: %s", row[0], error)
    return {"failed_run_id": str(row[0]), "task_arn": task_arn, "error": error}


def _run_crawler_task(run: dict) -> str:
    """Launch the crawler ECS task for a website source. Returns the ECS task ARN."""
    # For website sources, ds.name holds the seed URL (see stage_data_sources.py).
    env = [
        {"name": "JOB_ID", "value": run["ingestion_run_id"]},
        {"name": "SEED_URL", "value": run["name"]},
        {"name": "WRITE_DB", "value": "true"},
    ]
    resp = ecs_client.run_task(
        cluster=ECS_CLUSTER_ARN,
        taskDefinition=CRAWLER_TASK_DEF_ARN,
        launchType="FARGATE",
        count=1,
        networkConfiguration=_network_configuration(),
        overrides={"containerOverrides": [{"name": CRAWLER_CONTAINER_NAME, "environment": env}]},
    )
    return _task_arn_from_run_task(resp, kind="crawler")


def launch_transcriber_for_run(connection, *, ingestion_run_id: str, sync_session_id: str) -> dict:
    """Queue-to-running helper used when Amazon Transcribe finishes a video job."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
                ir.id,
                ir.data_source_id,
                ds.name,
                ds.type,
                ds.include_patterns,
                ds.exclude_patterns,
                ds.metadata
            FROM ingestion_runs ir
            JOIN data_sources ds ON ds.id = ir.data_source_id
            WHERE ir.id = %s::uuid
            """,
            (ingestion_run_id,),
        )
        row = cursor.fetchone()

    if not row:
        raise RuntimeError(f"ingestion run not found: {ingestion_run_id}")

    run = {
        "ingestion_run_id": str(row[0]),
        "data_source_id": str(row[1]),
        "name": row[2],
        "type": row[3],
        "include_patterns": row[4] or [],
        "exclude_patterns": row[5] or [],
        "data_source_metadata": row[6] or {},
    }
    if not run["data_source_metadata"].get("transcript_s3_uri"):
        raise RuntimeError("transcript_s3_uri is missing; Transcribe may not have finished")

    task_arn = _run_transcriber_task(run)
    _mark_run_running(
        connection,
        ingestion_run_id=run["ingestion_run_id"],
        ecs_task_arn=task_arn,
        sync_session_id=sync_session_id,
    )
    connection.commit()
    return {"ingestion_run_id": run["ingestion_run_id"], "ecs_task_arn": task_arn}


def _run_transcriber_task(run: dict) -> str:
    """
    Launch the transcriber ECS task for a video source. Returns the ECS task ARN.

    The transcript S3 location and video URL are expected on the data_sources
    metadata (transcript_s3_uri, video_url) produced by the video upload flow.
    The container entrypoint downloads TRANSCRIPT_JSON from S3 before running.
    """
    meta = run["data_source_metadata"]
    env = [
        {"name": "JOB_ID", "value": run["ingestion_run_id"]},
        {"name": "VIDEO_URL", "value": meta.get("video_url", run["name"])},
        {"name": "VIDEO_NAME", "value": run["name"]},
        {"name": "TRANSCRIPT_JSON", "value": meta.get("transcript_s3_uri", "")},
        {"name": "WRITE_DB", "value": "true"},
    ]
    resp = ecs_client.run_task(
        cluster=ECS_CLUSTER_ARN,
        taskDefinition=TRANSCRIBER_TASK_DEF_ARN,
        launchType="FARGATE",
        count=1,
        networkConfiguration=_network_configuration(),
        overrides={"containerOverrides": [{"name": TRANSCRIBER_CONTAINER_NAME, "environment": env}]},
    )
    return _task_arn_from_run_task(resp, kind="transcriber")


def process_crawler_batch(event, connection, sync_session_id: str, triggered_by_scheduler: bool = False):
    """
    Launch ECS ingestion tasks for the currently queued website/video sources.

    Returns a structured result describing whether any tasks started and which
    runs were launched. Each launched run is marked 'running'; the ECS task
    finalizes it to completed/failed on its own.
    """
    if not ECS_CLUSTER_ARN or not INGESTION_SUBNET_IDS or not INGESTION_SECURITY_GROUP_IDS:
        return {
            "started": False,
            "reason": "pgvector ingestion is not configured (missing ECS_CLUSTER_ARN / subnets / security groups)",
        }

    queued = _latest_queued_runs(connection, ["website", "video"])
    if not queued:
        return {"started": False, "reason": "no queued website/video sources"}

    launched = []
    failures = []
    for run in queued:
        try:
            if run["type"] == "website":
                if not CRAWLER_TASK_DEF_ARN:
                    raise RuntimeError("CRAWLER_TASK_DEF_ARN not set")
                task_arn = _run_crawler_task(run)
            elif run["type"] == "video":
                if not TRANSCRIBER_TASK_DEF_ARN:
                    raise RuntimeError("TRANSCRIBER_TASK_DEF_ARN not set")
                meta = run.get("data_source_metadata") or {}
                if meta.get("transcribe_status") != "COMPLETED" or not meta.get("transcript_s3_uri"):
                    logger.info(
                        "Skipping video run %s; Transcribe has not produced a transcript yet",
                        run["ingestion_run_id"],
                    )
                    continue
                task_arn = _run_transcriber_task(run)
            else:
                continue

            _mark_run_running(
                connection,
                ingestion_run_id=run["ingestion_run_id"],
                ecs_task_arn=task_arn,
                sync_session_id=sync_session_id,
            )
            connection.commit()
            launched.append({"ingestion_run_id": run["ingestion_run_id"], "type": run["type"], "ecs_task_arn": task_arn})
        except Exception as e:  # noqa: BLE001
            connection.rollback()
            logger.error("Failed to launch ingestion task for run %s: %s", run["ingestion_run_id"], e, exc_info=True)
            failures.append({"ingestion_run_id": run["ingestion_run_id"], "error": str(e)[:500]})

    return {
        "started": len(launched) > 0,
        "sync_session_id": sync_session_id,
        "launched_count": len(launched),
        "launched": launched,
        "failures": failures,
    }
