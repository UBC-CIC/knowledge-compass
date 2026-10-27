import json
import logging

from helpers.admin_audit import actor_from_event, insert_admin_audit, log_admin_audit
from kc_shared.cors import get_cors_headers
from helpers.data_source_cleanup import plan_removal, remove_data_sources
from helpers.upload_identity import delete_s3_objects
from helpers.web_sources import delete_website_pages

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


def _fetch_data_source(connection, data_source_id: str) -> dict | None:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT id, name, type, metadata
            FROM data_sources
            WHERE id = %s::uuid
            LIMIT 1
            FOR UPDATE
            """,
            (data_source_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None
        return {
            "id": str(row[0]),
            "name": row[1],
            "type": row[2],
            "metadata": row[3] or {},
        }


def delete_data_source(event, body, connection, data_source_id: str):
    """
    Permanently remove an uploaded data source (file, video, or website) that
    was added by mistake.

    This method, in one transaction:
    - looks up the data source and, for csv/markdown/json pairs, its companion row
    - deletes the ingestion_runs row(s) and the data_sources row(s)
    - deletes the matching pgvector `sources` row (its chunks cascade) so they
      stop being served by retrieval, unless another data source still maps
      to the same url (e.g. two documents sharing one citation link)
    - for a website, deletes every crawled page row (seed included) it solely
      owns plus unowned legacy pages inside its site; pages another live
      website also crawled are kept (helpers/web_sources.py). The counts are
      returned as deleted_page_count / retained_shared_page_count.

    - writes an admin_audit row ("data_source.delete": the acting admin from
      the authorizer context, the removed data source ids and source urls,
      deleted_page_count), so the deletion and its record commit together;
      a structured log line follows the commit (finding f-0d57a9d0)

    A request without an authorizer identity is refused with 401 before any
    query (fail closed; the admin authorizer always sets it).

    The data_sources row is locked FOR UPDATE for the whole transaction; any
    failure (including the audit insert) rolls everything back and returns 500.

    Then, after commit, best-effort deletes the underlying S3 object(s)
    (primary, companion, transcript). S3 failures are returned as warnings:
    the resource is meant to disappear from the admin list even if its
    storage could not be cleaned up.
    """
    actor = actor_from_event(event)
    if actor is None:
        logger.warning("Refusing data source delete without an authorizer identity")
        return _response(event, 401, {"error": "Unauthorized"})

    row = _fetch_data_source(connection, data_source_id)
    if not row:
        return _response(event, 404, {"error": "Data source not found"})

    plan = plan_removal(connection, [row])

    page_result = {"deleted_page_count": 0, "retained_shared_page_count": 0}
    try:
        if row["type"] == "website":
            page_result = delete_website_pages(
                connection, data_source_id=row["id"], seed_url=row["name"]
            )
        remove_data_sources(connection, plan)
        audit_target = {
            "data_source_id": data_source_id,
            "type": row["type"],
            "deleted_data_source_ids": plan["ids"],
            "source_urls": plan["source_urls"],
            "deleted_page_count": page_result["deleted_page_count"],
        }
        with connection.cursor() as cursor:
            insert_admin_audit(cursor, actor, "data_source.delete", audit_target)
        connection.commit()
    except Exception as e:
        connection.rollback()
        logger.error("Failed to delete data source %s: %s", data_source_id, e, exc_info=True)
        return _response(event, 500, {"error": "Failed to delete data source"})

    log_admin_audit(actor, "data_source.delete", audit_target)

    warnings = [
        f"Could not delete uploaded file {key} from storage"
        for key in delete_s3_objects(plan["s3_objects"])
    ]

    return _response(
        event,
        200,
        {
            "message": "Data source deleted.",
            "action": "deleted",
            "data_source_id": data_source_id,
            "deleted_data_source_ids": plan["ids"],
            "warnings": warnings,
            **page_result,
        },
    )
