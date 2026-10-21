"""
Cutover lock for the ingestion entry points.

While an embedding-space cutover runs (helpers/cutover.py) the pointer row
`embedding_active_space` carries `cutover_locked = true`. Every admin route that can
start ingestion calls `reject_if_locked` first and answers 409 CUTOVER_LOCKED, so no
writer targets the old space after the activation job has decided it is idle. That
includes the guideline routes (helpers/guideline_admin.py). The Transcribe-completion
event has no route: it defers its run instead of launching it
(helpers/video_transcription.py).

`hold=True` reads the pointer row FOR SHARE. A caller that records its work in the same
transaction (a guideline document set to 'processing', an ingestion run set to
'running') makes the cutover's lock UPDATE wait for that commit, so wait_idle is sure
to see the work. Such a caller must commit or roll back before it returns.

The lock can never stay set forever: a lock older than LOCK_TTL_SECONDS counts as
released (and is logged), so a crashed activation job is not a permanent outage. The
cutover job refreshes `cutover_locked_at` as it makes progress, so a long delta does
not run into the TTL.

The check tolerates a database where migration 032 has not been applied yet (the
table is missing): it logs a WARNING and treats the system as unlocked, so the Lambda
deploys safely before or after the migration.

Never log request bodies; this module logs counts and ids only.
"""

import json
import logging
from typing import Any, Dict, Optional

from helpers.cors import get_cors_headers

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# A lock older than this is treated as released (D2). Shared with helpers/cutover.py.
LOCK_TTL_SECONDS = 30 * 60

LOCK_MESSAGE = (
    "A search-index cutover is in progress. Syncing is paused for a few minutes; "
    "please try again shortly."
)
LOCK_CODE = "CUTOVER_LOCKED"

_UNDEFINED_TABLE = "42P01"


def _is_missing_table(error: Exception) -> bool:
    return getattr(error, "pgcode", None) == _UNDEFINED_TABLE or type(error).__name__ == "UndefinedTable"


def _rollback_quietly(connection) -> None:
    try:
        connection.rollback()
    except Exception:  # noqa: BLE001
        pass


def lock_state(connection, hold: bool = False) -> Dict[str, Any]:
    """
    {"locked": bool, "expired": bool, "locked_at": datetime|None, "job_id": str|None}.
    `locked` is True only for a lock inside its TTL. A missing table reads as unlocked.
    `hold` keeps a share lock on the pointer row until the caller's transaction ends.
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT cutover_locked,
                       cutover_locked_at,
                       cutover_job_id::text,
                       (cutover_locked_at IS NOT NULL
                        AND cutover_locked_at < now() - make_interval(secs => %s)) AS expired
                FROM embedding_active_space
                WHERE id = 1
                """ + (" FOR SHARE" if hold else ""),
                (LOCK_TTL_SECONDS,),
            )
            row = cursor.fetchone()
    except Exception as e:  # noqa: BLE001
        _rollback_quietly(connection)
        if _is_missing_table(e):
            logger.warning("embedding_active_space is missing; treating ingestion as unlocked")
            return {"locked": False, "expired": False, "locked_at": None, "job_id": None}
        raise
    if not row or not row[0]:
        return {"locked": False, "expired": False, "locked_at": None, "job_id": None}
    expired = bool(row[3])
    if expired:
        logger.warning(
            "Cutover lock older than %s s treated as released (job %s)", LOCK_TTL_SECONDS, row[2]
        )
    return {"locked": not expired, "expired": expired, "locked_at": row[1], "job_id": row[2]}


def is_locked(connection, hold: bool = False) -> bool:
    return lock_state(connection, hold)["locked"]


def reject_if_locked(event, connection, hold: bool = False) -> Optional[dict]:
    """A 409 CUTOVER_LOCKED API response while a cutover holds the lock, else None."""
    if not is_locked(connection, hold):
        return None
    return {
        "statusCode": 409,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps({"error": LOCK_MESSAGE, "code": LOCK_CODE}),
    }
