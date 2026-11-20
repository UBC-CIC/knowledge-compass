"""
Audit trail for privileged admin actions (finding f-0d57a9d0, migration
040_admin_audit). Mirrors cdk/lambda/handlers/utils/adminAudit.js.

The actor always comes from the verified admin authorizer context
(requestContext.authorizer.userId / .email), never from a request body. A
self-invoked worker payload ({"task": ...}) carries the originating admin as
"actor": {"sub", "email", "request_id"}, copied from the HTTP request that
started it (with_actor) and forwarded by continuations. Workers only log it
(log_worker_task); audit rows are written only on HTTP paths, where the
identity is verified.

Targets and log lines hold ids and field names only: never message bodies,
document content, tokens or guest personal data. The admin's own email is
allowed.
"""

import json
import logging

from helpers.admin_user import admin_email_from_request, admin_sub_from_request

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Ids a worker payload may carry; logged with the task when present.
_WORKER_ID_FIELDS = ("job_id", "document_id", "ingestion_run_id", "sync_session_id", "continuation")


def _optional_str(value) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def actor_from_event(event) -> dict | None:
    """
    {"sub", "email", "request_id"} of the originating admin, or None.

    HTTP events: from the admin authorizer context. Self-invoke payloads: from
    event["actor"] when it is a dict with a non-empty string sub.
    """
    event = event or {}
    sub = admin_sub_from_request(event)
    if sub:
        request_id = (event.get("requestContext") or {}).get("requestId")
        return {
            "sub": sub,
            "email": admin_email_from_request(event) or None,
            "request_id": _optional_str(request_id),
        }
    actor = event.get("actor")
    if isinstance(actor, dict) and isinstance(actor.get("sub"), str) and actor["sub"].strip():
        return {
            "sub": actor["sub"].strip(),
            "email": _optional_str(actor.get("email")),
            "request_id": _optional_str(actor.get("request_id")),
        }
    return None


def with_actor(payload: dict, event) -> dict:
    """`payload` plus "actor" when the event has a known actor; else unchanged."""
    actor = actor_from_event(event)
    if actor is None:
        return payload
    return {**payload, "actor": actor}


def insert_admin_audit(cursor, actor: dict | None, action: str, target: dict) -> None:
    """Insert one admin_audit row. The caller commits with the change it records."""
    if not actor or not actor.get("sub"):
        raise ValueError("audit actor missing")
    cursor.execute(
        """
        INSERT INTO admin_audit (actor_sub, actor_email, action, target, request_id)
        VALUES (%s, %s, %s, %s::jsonb, %s)
        """,
        (
            actor["sub"],
            actor.get("email"),
            action,
            json.dumps(target or {}, default=str),
            actor.get("request_id"),
        ),
    )


def log_admin_audit(actor: dict, action: str, target: dict) -> None:
    """One structured log line for a committed admin action."""
    logger.info(
        json.dumps(
            {
                "audit": "admin_action",
                "action": action,
                "actor_sub": (actor or {}).get("sub"),
                "actor_email": (actor or {}).get("email"),
                "target": target,
                "request_id": (actor or {}).get("request_id"),
            },
            default=str,
        )
    )


def log_worker_task(event) -> None:
    """One structured log line per self-invoked task, with the originating admin (or nulls)."""
    event = event or {}
    actor = actor_from_event(event) or {}
    line = {
        "audit": "worker_task",
        "task": event.get("task"),
        "actor_sub": actor.get("sub"),
        "actor_email": actor.get("email"),
        "request_id": actor.get("request_id"),
    }
    for field in _WORKER_ID_FIELDS:
        if event.get(field) is not None:
            line[field] = event.get(field)
    logger.info(json.dumps(line, default=str))
