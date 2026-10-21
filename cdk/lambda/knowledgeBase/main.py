import os
import json
from helpers.cors import get_cors_headers
import boto3
import logging
import psycopg2

from helpers.stage_data_sources import stage_data_sources
from helpers.stage_data_sources_batch import stage_data_sources_batch
from helpers.start_ingestion_job import start_ingestion_job
from helpers.generate_presigned_url import generate_presigned_url
from helpers.generate_presigned_urls_batch import generate_presigned_urls_batch
from helpers.video_transcription import handle_transcribe_complete
from helpers.process_crawler_batch import handle_ecs_task_stopped
from helpers.retry_ingestion_run import retry_ingestion_run
from helpers.delete_data_source import delete_data_source
from helpers.process_document_batch import process_document_batch
from helpers.process_csv_links import process_csv_links
from helpers.csv_links import get_data_source_links
from helpers.guideline_document import process_guideline_document, reembed_guideline_sections
from helpers.guideline_admin import handle_guideline_request, is_guideline_route
from helpers.embedding_admin import handle_embedding_request, is_embedding_route
from helpers.reembed_space import reembed_space
from helpers.validate_space import validate_space
from helpers.cutover import activate_space, rollback_space
from helpers.admin_audit import log_worker_task
from helpers.worker_envelope import INVOKE_TOKEN_FIELD, verify_worker_event

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Environment variables
DB_SECRET_NAME = os.environ["SM_DB_CREDENTIALS"]
REGION = os.environ["REGION"]
RDS_PROXY_ENDPOINT = os.environ["RDS_PROXY_ENDPOINT"]

# Cached resources
connection = None
secret_cache = {}

# AWS Clients
secrets_manager_client = boto3.client("secretsmanager", region_name=REGION)

def _get_secret(secret_name: str, expect_json: bool = True):
    if secret_name in secret_cache:
        return secret_cache[secret_name]

    try:
        response = secrets_manager_client.get_secret_value(SecretId=secret_name)["SecretString"]
        value = json.loads(response) if expect_json else response
        secret_cache[secret_name] = value
        return value
    except json.JSONDecodeError as e:
        logger.error(f"Failed to decode JSON for secret '{secret_name}': {e}")
        raise ValueError(f"Secret '{secret_name}' is not properly formatted as JSON.")
    except Exception as e:
        logger.error(f"Error fetching secret '{secret_name}': {e}")
        raise

_EMBEDDING_TASKS = {
    "reembed_space": reembed_space,
    "validate_space": validate_space,
    "activate_space": activate_space,
    "rollback_space": rollback_space,
}

def _connect_to_db():
    global connection
    if connection is None or connection.closed:
        try:
            db_secret = _get_secret(DB_SECRET_NAME, expect_json=True)
            connection_params = {
                'dbname': db_secret["dbname"],
                'user': db_secret["username"],
                'password': db_secret["password"],
                'host': RDS_PROXY_ENDPOINT,
                'port': db_secret["port"], 
                'sslmode': 'require'
            }
            connection = psycopg2.connect(**connection_params)
            logger.info("Connected to the database!")
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            if connection:
                connection.rollback()
                connection.close()
            raise
    return connection

def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            **get_cors_headers(event),
        },
        "body": json.dumps(body),
    }

def _parse_body(event):
    body = {}
    raw_body = event.get("body")

    if not raw_body:
        return body

    try:
        if isinstance(raw_body, str):
            body = json.loads(raw_body)
        elif isinstance(raw_body, dict):
            body = raw_body
        else:
            raise ValueError("Unsupported body format")
    except Exception as e:
        logger.error("Failed to parse body: %s", e)
        raise ValueError("Invalid JSON body")

    return body

def handler(event, context=None):
    # Never log the body or the worker invoke token.
    safe_event = {k: v for k, v in event.items() if k not in ('body', INVOKE_TOKEN_FIELD)}
    logger.info("Event: %s (body omitted)", json.dumps(safe_event))
    
    try:
        # Self-invoked {task} payloads rewrite the corpus and move the live
        # embedding pointer. The IAM self-invoke grant alone is not trusted:
        # every task must carry the invoke token (helpers/worker_envelope.py),
        # a generated Secrets Manager value only this function's role can read.
        # Checked before any dispatch or logging of the payload's actor.
        # EventBridge events (aws.transcribe / aws.ecs via transcribeRelay)
        # never carry "task" and are handled below without a token.
        if "task" in event and not verify_worker_event(event):
            logger.warning(
                "Rejected worker invocation without a valid invoke token: task=%s",
                str(event.get("task"))[:64],
            )
            return {"error": "Unauthorized worker invocation"}

        if event.get("source") == "aws.transcribe":
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return _response(event, 500, {"error": "Error connecting to database"})
            return handle_transcribe_complete(event, connection)

        if event.get("source") == "aws.ecs":
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return _response(event, 500, {"error": "Error connecting to database"})
            return handle_ecs_task_stopped(event, connection)

        # Every self-invoked {task} branch below is logged once with the
        # originating admin from the payload's "actor" (helpers/admin_audit.py;
        # null when the task was not started by an admin request).
        if event.get("task"):
            log_worker_task(event)

        # Async self-invocation path (pgvector document ingestion; see
        # helpers/process_document_batch.py). Fired via lambda_client.invoke(...,
        # InvocationType="Event") from trigger_document_batch so the actual
        # chunk+embed work isn't bound by API Gateway's 29s integration timeout.
        if event.get("task") == "process_document_batch":
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return {"error": "Error connecting to database"}
            return process_document_batch(event=event, connection=connection, context=context)

        # Async link phase of a CSV run (see helpers/process_csv_links.py);
        # fired by csv_links.start_link_phase and by itself to continue.
        if event.get("task") == "process_csv_links":
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return {"error": "Error connecting to database"}
            return process_csv_links(event=event, connection=connection, context=context)

        # Async guideline-mode workers (helpers/guideline_document.py), fired
        # by the /admin/guideline routes with InvocationType="Event".
        if event.get("task") in ("process_guideline_document", "reembed_guideline_sections"):
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return {"error": "Error connecting to database"}
            if event["task"] == "process_guideline_document":
                return process_guideline_document(event=event, connection=connection, context=context)
            return reembed_guideline_sections(event=event, connection=connection)

        # Async embedding-space workers (helpers/reembed_space.py, validate_space.py,
        # cutover.py), fired by the /admin/embedding-spaces routes with
        # InvocationType="Event" and by themselves to continue.
        if event.get("task") in _EMBEDDING_TASKS:
            try:
                connection = _connect_to_db()
            except Exception as e:
                logger.error(f"Error connecting to database: {e}")
                return {"error": "Error connecting to database"}
            return _EMBEDDING_TASKS[event["task"]](event=event, connection=connection, context=context)

        # API Gateway path
        # Every route on this function is /admin/* behind adminAuthorizer
        # (OpenAPI_Swagger_Definition.yaml). Defence in depth, mirroring
        # adminHandler.js: a route left without the authorizer, or any other
        # event shape, is still denied here.
        role = ((event.get("requestContext") or {}).get("authorizer") or {}).get("role")
        if role != "admin":
            logger.warning("Rejected non-admin request: resource=%s", event.get("resource"))
            return _response(event, 403, {"error": "Admin access required"})

        method = event.get("httpMethod", "")
        resource = event.get("resource", "")
        path = event.get("path", "")

        try:
            body = _parse_body(event)
        except ValueError as e:
            return _response(event, 400, {"error": str(e)})
        
        # connect to database
        try:
            connection = _connect_to_db()
        except Exception as e:
            logger.error(f"Error connecting to database: {e}")
            return _response(event, 500, {"error": "Error connecting to database"})

        # Route: GET /admin/generate-presigned-url
        # Issued keys are recorded per admin (helpers/upload_issuance.py), so
        # the presign routes need the database too.
        if method == "GET" and (
            resource == "/admin/generate-presigned-url"
            or path.endswith("/admin/generate-presigned-url")
        ):
            return generate_presigned_url(event=event, connection=connection)

        # Route: POST /admin/generate-presigned-urls/batch
        if method == "POST" and (
            resource == "/admin/generate-presigned-urls/batch"
            or path.endswith("/admin/generate-presigned-urls/batch")
        ):
            return generate_presigned_urls_batch(event=event, body=body, connection=connection)

        # Routes: /admin/guideline* (guideline mode; helpers/guideline_admin.py)
        if is_guideline_route(event):
            return handle_guideline_request(event=event, body=body, connection=connection)

        # Routes: /admin/embedding-spaces* and /admin/embedding-jobs/{id}
        # (helpers/embedding_admin.py). Before the /admin/data_sources branches.
        if is_embedding_route(event):
            return handle_embedding_request(event=event, body=body, connection=connection)

        # Route: POST /admin/data_sources
        if method == "POST" and (
            resource == "/admin/data_sources"
            or path.endswith("/admin/data_sources")
        ):
            return stage_data_sources(event=event, body=body, connection=connection)

        # Route: POST /admin/data_sources/batch
        if method == "POST" and (
            resource == "/admin/data_sources/batch"
            or path.endswith("/admin/data_sources/batch")
        ):
            return stage_data_sources_batch(event=event, body=body, connection=connection)

        # Route: POST /admin/data_sources/{id}/retry
        if method == "POST" and (
            resource == "/admin/data_sources/{id}/retry"
            or path.endswith("/retry")
        ):
            data_source_id = (event.get("pathParameters") or {}).get("id")
            if not data_source_id:
                return _response(event, 400, {"error": "Missing data source id"})
            return retry_ingestion_run(
                event=event,
                body=body,
                connection=connection,
                data_source_id=data_source_id,
            )

        # Route: GET /admin/data_sources/{id}/links
        if method == "GET" and (
            resource == "/admin/data_sources/{id}/links"
            or (path.startswith("/admin/data_sources/") and path.endswith("/links"))
        ):
            data_source_id = (event.get("pathParameters") or {}).get("id")
            if not data_source_id:
                return _response(event, 400, {"error": "Missing data source id"})
            return get_data_source_links(event=event, connection=connection, data_source_id=data_source_id)

        # Route: DELETE /admin/data_sources/{id}
        if method == "DELETE" and (
            resource == "/admin/data_sources/{id}"
            or (path.startswith("/admin/data_sources/") and not path.endswith("/retry"))
        ):
            data_source_id = (event.get("pathParameters") or {}).get("id")
            if not data_source_id:
                return _response(event, 400, {"error": "Missing data source id"})
            return delete_data_source(
                event=event,
                body=body,
                connection=connection,
                data_source_id=data_source_id,
            )

        # Route: POST /admin/data_sources/sync
        if method == "POST" and (
            resource == "/admin/data_sources/sync"
            or path.endswith("/admin/data_sources/sync")
        ):
            return start_ingestion_job(
                event=event,
                body=body,
                connection=connection,
            )

        return _response(
            event,
            404,
            {
                "error": "Route not found",
                "method": method,
                "resource": resource,
                "path": path,
            },
        )

    except Exception as e:
        logger.error("Error: %s", e, exc_info=True)
        return _response(event, 500, {"error": "Internal server error"})