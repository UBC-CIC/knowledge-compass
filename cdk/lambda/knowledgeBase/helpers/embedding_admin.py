"""
Admin API for embedding spaces and their jobs (migrations 032 and 033). Every route
sits under /admin/ and is protected by the existing admin Cognito authorizer in API
Gateway. Routes that change anything additionally need the authorizer's `requestContext`
email (the audit identity); a body-supplied email is ignored.

  GET  /admin/embedding-spaces                     spaces, coverage, lock state, latest job
  POST /admin/embedding-spaces                     register a space (status 'building')
  POST /admin/embedding-spaces/{id}/jobs           dry_run | rebuild | delta   (202)
  POST /admin/embedding-spaces/{id}/validate       validation job              (202)
  POST /admin/embedding-spaces/{id}/activate       cutover to this space       (202)
  POST /admin/embedding-spaces/{id}/rollback       cutover back to a retired space (202)
  GET  /admin/embedding-jobs/{id}                  progress, steps, estimate / report

Long work never runs in the API request: each POST records a job row and fires an
Event self-invocation (`reembed_space`, `validate_space`, `activate_space`,
`rollback_space`); the UI polls GET /admin/embedding-jobs/{id}. A purge route is added
by the retention task together with its OpenAPI entry.

Responses and job reports carry ids, counts and metrics only: no chunk text, no
queries, no credentials. Request bodies are never logged.
"""

import datetime
import json
import logging
import math
import re
import uuid
from decimal import Decimal
from typing import Any, Dict, Optional, Tuple

from helpers import embeddings
from helpers.cors import get_cors_headers
from helpers.embedding_jobs import JOB_COLUMNS, invoke_self, load_job, row_to_job
from helpers.embedding_space import index_name
from helpers.ingestion_lock import LOCK_CODE, LOCK_MESSAGE, LOCK_TTL_SECONDS, lock_state
from helpers.admin_user import normalize_email

logger = logging.getLogger()
logger.setLevel(logging.INFO)

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,62}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_INVOKE_TARGET = 2048
MAX_MODEL_ID = 512
MAX_VERSION = 32
MAX_PRICE = 99_999_999
JOB_MODES = ("dry_run", "rebuild", "delta")
# Jobs with no progress for this long are treated as dead so they cannot block new ones.
STALE_REBUILD_SECONDS = 15 * 60
STALE_CUTOVER_SECONDS = LOCK_TTL_SECONDS
MAX_TOLERANCE = 0.5

# setting -> (minimum, maximum) for the integer settings; `normalize` is a boolean.
_SETTING_BOUNDS = {
    "batch_size": (1, 256),
    "max_chars": (100, 50_000),
    "concurrency": (1, 32),
}

_TASK_FOR_MODE = {
    "dry_run": "reembed_space",
    "rebuild": "reembed_space",
    "delta": "reembed_space",
    "validate": "validate_space",
    "activate": "activate_space",
    "rollback": "rollback_space",
}


# ── Responses ─────────────────────────────────────────────────────────────────

def _json_default(value):
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return str(value)


def _response(event, status_code: int, body: dict):
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **get_cors_headers(event)},
        "body": json.dumps(body, default=_json_default),
    }


def _admin_email(event) -> Optional[str]:
    # Only the authorizer is trusted for audit fields; never the request body.
    authorizer = (event.get("requestContext") or {}).get("authorizer") or {}
    return normalize_email(authorizer.get("email")) or None


def _is_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


def _rollback_quietly(connection) -> None:
    try:
        connection.rollback()
    except Exception:  # noqa: BLE001
        pass


def _is_unique_violation(error: Exception) -> bool:
    return getattr(error, "pgcode", None) == "23505" or type(error).__name__ == "UniqueViolation"


def _locked_response(event):
    return _response(event, 409, {"error": LOCK_MESSAGE, "code": LOCK_CODE})


# ── Routing ───────────────────────────────────────────────────────────────────

_ROUTES = (
    ("GET", "/admin/embedding-spaces", re.compile(r"/admin/embedding-spaces$")),
    ("POST", "/admin/embedding-spaces", re.compile(r"/admin/embedding-spaces$")),
    ("POST", "/admin/embedding-spaces/{id}/jobs", re.compile(r"/admin/embedding-spaces/[^/]+/jobs$")),
    ("POST", "/admin/embedding-spaces/{id}/validate", re.compile(r"/admin/embedding-spaces/[^/]+/validate$")),
    ("POST", "/admin/embedding-spaces/{id}/activate", re.compile(r"/admin/embedding-spaces/[^/]+/activate$")),
    ("POST", "/admin/embedding-spaces/{id}/rollback", re.compile(r"/admin/embedding-spaces/[^/]+/rollback$")),
    ("GET", "/admin/embedding-jobs/{id}", re.compile(r"/admin/embedding-jobs/[^/]+$")),
)

_PATH_ID = re.compile(r"/admin/embedding-(?:spaces|jobs)/([^/]+)")


def _match(event) -> Optional[Tuple[str, str]]:
    method = event.get("httpMethod", "")
    resource = event.get("resource", "")
    path = event.get("path", "")
    for route_method, route_resource, pattern in _ROUTES:
        if method == route_method and (resource == route_resource or pattern.search(path or "")):
            return route_method, route_resource
    return None


def is_embedding_route(event) -> bool:
    return _match(event) is not None


def _path_id(event) -> Optional[str]:
    value = (event.get("pathParameters") or {}).get("id")
    if value:
        return value
    found = _PATH_ID.search(event.get("path", "") or "")
    return found.group(1) if found else None


def handle_embedding_request(event, body, connection):
    route = _match(event)
    if route is None:
        return _response(event, 404, {"error": "Route not found"})
    method, resource = route
    mutating = method != "GET"
    admin = _admin_email(event)
    if mutating and not admin:
        return _response(event, 401, {"error": "Unauthorized"})
    path_id = _path_id(event)
    if "{id}" in resource and not _is_uuid(path_id):
        return _response(event, 400, {"error": "Invalid id."})
    body = body if isinstance(body, dict) else {}
    try:
        if resource == "/admin/embedding-spaces" and method == "GET":
            return list_spaces(event, connection)
        if resource == "/admin/embedding-spaces":
            return register_space(event, body, connection, admin)
        if resource == "/admin/embedding-spaces/{id}/jobs":
            return create_job(event, body, connection, path_id, admin)
        if resource == "/admin/embedding-spaces/{id}/validate":
            return create_validate_job(event, body, connection, path_id, admin)
        if resource == "/admin/embedding-spaces/{id}/activate":
            return create_cutover_job(event, body, connection, path_id, admin, "activate")
        if resource == "/admin/embedding-spaces/{id}/rollback":
            return create_cutover_job(event, body, connection, path_id, admin, "rollback")
        if resource == "/admin/embedding-jobs/{id}":
            return get_job(event, connection, path_id)
    except Exception as e:  # noqa: BLE001
        _rollback_quietly(connection)
        # Class name only: a database error message can quote the offending row.
        logger.error("Embedding admin request failed (%s %s): %s", method, resource, type(e).__name__)
        return _response(event, 500, {"error": "Something went wrong. Please try again."})
    return _response(event, 404, {"error": "Route not found"})


# ── Validation of a new space ─────────────────────────────────────────────────

def _is_number(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def validate_registration(body: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """(clean fields, None) or (None, the first problem found, in plain language)."""
    name = body.get("name")
    if not isinstance(name, str) or not NAME_RE.match(name):
        return None, "name must be 3 to 63 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit."

    provider = body.get("provider")
    if not isinstance(provider, str) or provider not in embeddings.ADAPTERS:
        return None, f"provider must be one of: {', '.join(sorted(embeddings.ADAPTERS))}."
    adapter = embeddings.ADAPTERS[provider]

    dimensions = body.get("dimensions")
    allowed = sorted(adapter.allowed_dimensions or ())
    if not _is_int(dimensions) or (allowed and dimensions not in allowed) or not 1 <= dimensions <= 2000:
        return None, f"dimensions for {provider} must be one of: {', '.join(str(d) for d in allowed) or '1 to 2000'}."

    invoke_target = body.get("invoke_target")
    if (
        not isinstance(invoke_target, str)
        or not invoke_target
        or len(invoke_target) > MAX_INVOKE_TARGET
        or re.search(r"\s", invoke_target)
    ):
        return None, f"invoke_target must be a model id or inference profile ARN of up to {MAX_INVOKE_TARGET} characters, without spaces."

    model_id = body.get("model_id")
    if not isinstance(model_id, str) or not model_id.strip() or len(model_id) > MAX_MODEL_ID:
        return None, "model_id must be a non-empty text value."

    version = body.get("version", "1")
    if version is None:
        version = "1"
    if not isinstance(version, str) or not version.strip() or len(version) > MAX_VERSION:
        return None, f"version must be a short text value (up to {MAX_VERSION} characters)."

    price = body.get("price_per_1m_tokens")
    if price is not None and (not _is_number(price) or price < 0 or price > MAX_PRICE):
        return None, "price_per_1m_tokens must be empty or a number of 0 or more."

    eol_date = body.get("eol_date")
    if eol_date is not None:
        try:
            if not isinstance(eol_date, str) or not _DATE_RE.match(eol_date):
                raise ValueError
            datetime.date.fromisoformat(eol_date)
        except ValueError:
            return None, "eol_date must be empty or a date written YYYY-MM-DD."

    thresholds = {}
    for field in ("min_score", "split_threshold"):
        value = body.get(field)
        if value is not None and (not _is_number(value) or not 0 <= value <= 1):
            return None, f"{field} must be empty or a number between 0 and 1."
        thresholds[field] = value

    settings = body.get("settings")
    if settings is None:
        settings = {}
    if not isinstance(settings, dict):
        return None, "settings must be an object."
    for key, value in settings.items():
        if key == "normalize":
            if not isinstance(value, bool):
                return None, "settings.normalize must be true or false."
        elif key in _SETTING_BOUNDS:
            low, high = _SETTING_BOUNDS[key]
            if not _is_int(value) or not low <= value <= high:
                return None, f"settings.{key} must be a whole number from {low} to {high}."
        else:
            return None, f"settings.{key} is not an allowed setting (allowed: batch_size, max_chars, concurrency, normalize)."

    clean = {
        "name": name,
        "provider": provider,
        "model_id": model_id.strip(),
        "invoke_target": invoke_target,
        "dimensions": dimensions,
        "version": version.strip(),
        "min_score": thresholds["min_score"],
        "split_threshold": thresholds["split_threshold"],
        "price_per_1m_tokens": price,
        "eol_date": eol_date,
        "settings": settings,
    }
    try:  # adapter-specific limits, e.g. a batch size over the provider maximum
        embeddings.spec_from_row(clean)
    except (ValueError, KeyError, TypeError) as e:
        return None, f"These settings do not fit {provider}: {e}"
    return clean, None


# ── Handlers: spaces ──────────────────────────────────────────────────────────

_SPACE_COLUMNS = """
    s.id::text, s.name, s.provider, s.model_id, s.invoke_target, s.dimensions, s.version,
    s.status, s.min_score, s.split_threshold, s.price_per_1m_tokens, s.eol_date,
    s.settings, s.created_by, s.created_at, s.activated_at, s.retired_at"""


def _num(value):
    return None if value is None else float(value)


def _job_summary(row) -> Dict[str, Any]:
    job = row_to_job(row)
    return {
        "id": job["id"], "mode": job["mode"], "status": job["status"],
        "processed": job["processed"], "total_chunks": job["total_chunks"],
        "current_step": job["current_step"], "last_error": job["last_error"],
        "created_at": job["created_at"], "finished_at": job["finished_at"],
    }


def list_spaces(event, connection):
    with connection.cursor() as cur:
        cur.execute("SELECT count(*) FROM chunks")
        total_chunks = int(cur.fetchone()[0])

        cur.execute("SELECT space_id::text FROM embedding_active_space WHERE id = 1")
        active_row = cur.fetchone()
        active_id = active_row[0] if active_row else None

        cur.execute(
            f"""
            SELECT {_SPACE_COLUMNS},
                   CASE WHEN s.status = 'purged' THEN 0 ELSE (
                     SELECT count(*) FROM chunk_embeddings ce
                     JOIN chunks c ON c.id = ce.chunk_id
                     WHERE ce.space_id = s.id AND ce.embed_hash = md5(c.embed_text)
                   ) END AS current_vectors
            FROM embedding_spaces s
            ORDER BY s.created_at, s.name
            """
        )
        space_rows = cur.fetchall()

        cur.execute(
            f"""
            SELECT DISTINCT ON (embedding_jobs.space_id) {JOB_COLUMNS}
            FROM embedding_jobs
            ORDER BY embedding_jobs.space_id, embedding_jobs.created_at DESC
            """
        )
        latest = {str(r[1]): _job_summary(r) for r in cur.fetchall()}
    connection.commit()

    lock = lock_state(connection)
    spaces = []
    for r in space_rows:
        current = int(r[17] or 0)
        spaces.append({
            "id": r[0], "name": r[1], "provider": r[2], "model_id": r[3],
            "invoke_target": r[4], "dimensions": r[5], "version": r[6], "status": r[7],
            "min_score": _num(r[8]), "split_threshold": _num(r[9]),
            "price_per_1m_tokens": _num(r[10]), "eol_date": r[11],
            "settings": r[12] if isinstance(r[12], dict) else json.loads(r[12] or "{}"),
            "created_by": r[13], "created_at": r[14], "activated_at": r[15], "retired_at": r[16],
            "is_active": r[0] == active_id,
            "coverage": {
                "current_vectors": current,
                "total_chunks": total_chunks,
                "percent": round(100.0 * current / total_chunks, 1) if total_chunks else None,
            },
            "latest_job": latest.get(r[0]),
        })
    return _response(event, 200, {
        "spaces": spaces,
        "active_space_id": active_id,
        "total_chunks": total_chunks,
        "cutover_locked": lock["locked"],
        "cutover": {"locked": lock["locked"], "locked_at": lock["locked_at"], "job_id": lock["job_id"]},
    })


def register_space(event, body, connection, admin):
    clean, problem = validate_registration(body)
    if problem:
        return _response(event, 400, {"error": problem})

    with connection.cursor() as cur:
        cur.execute("SELECT 1 FROM embedding_spaces WHERE name = %s", (clean["name"],))
        if cur.fetchone():
            _rollback_quietly(connection)
            return _response(event, 409, {"error": f"A space named '{clean['name']}' already exists."})
        try:
            cur.execute(
                """
                INSERT INTO embedding_spaces
                  (name, provider, model_id, invoke_target, dimensions, version, status,
                   min_score, split_threshold, price_per_1m_tokens, eol_date, settings, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, 'building', %s, %s, %s, %s, %s::jsonb, %s)
                RETURNING id::text
                """,
                (
                    clean["name"], clean["provider"], clean["model_id"], clean["invoke_target"],
                    clean["dimensions"], clean["version"], clean["min_score"], clean["split_threshold"],
                    clean["price_per_1m_tokens"], clean["eol_date"], json.dumps(clean["settings"]), admin,
                ),
            )
        except Exception as e:  # noqa: BLE001
            if _is_unique_violation(e):
                _rollback_quietly(connection)
                return _response(event, 409, {"error": f"A space named '{clean['name']}' already exists."})
            raise
        space_id = cur.fetchone()[0]
        # Same transaction as the insert: either the space and its index exist, or neither.
        cur.execute("SELECT create_space_index(%s::uuid)", (space_id,))
    connection.commit()
    logger.info("Embedding space %s registered (%s, %s dims)", clean["name"], clean["provider"], clean["dimensions"])
    return _response(event, 201, {
        "id": space_id,
        "name": clean["name"],
        "status": "building",
        "index_name": index_name(space_id),
    })


# ── Handlers: jobs ────────────────────────────────────────────────────────────

def _load_space(connection, space_id) -> Optional[Dict[str, Any]]:
    with connection.cursor() as cur:
        cur.execute(
            "SELECT id::text, name, status FROM embedding_spaces WHERE id = %s::uuid",
            (space_id,),
        )
        row = cur.fetchone()
    connection.commit()
    return {"id": row[0], "name": row[1], "status": row[2]} if row else None


def _reap_stale_jobs(connection, modes: tuple, seconds: int, space_id: Optional[str] = None) -> None:
    """Fail queued/running jobs with no progress for `seconds` so they cannot block new ones."""
    sql = (
        "UPDATE embedding_jobs SET status = 'failed', finished_at = now(), updated_at = now(), "
        "last_error = 'Stalled: no progress was recorded' "
        "WHERE status IN ('queued', 'running') AND mode = ANY(%s) "
        "AND updated_at < now() - make_interval(secs => %s)"
    )
    params: list = [list(modes), seconds]
    if space_id:
        sql += " AND space_id = %s::uuid"
        params.append(space_id)
    with connection.cursor() as cur:
        cur.execute(sql, tuple(params))
        if cur.rowcount:
            logger.warning("Marked %s stalled embedding job(s) as failed", cur.rowcount)
    connection.commit()


def _insert_job(connection, space_id: str, mode: str, admin: str, report: Optional[dict] = None) -> str:
    with connection.cursor() as cur:
        cur.execute(
            """
            INSERT INTO embedding_jobs (space_id, mode, status, requested_by, report)
            VALUES (%s::uuid, %s, 'queued', %s, %s::jsonb)
            RETURNING id::text
            """,
            (space_id, mode, admin, None if report is None else json.dumps(report)),
        )
        job_id = cur.fetchone()[0]
    connection.commit()
    return job_id


def _start_job(event, connection, job_id: str, mode: str):
    """Fire the worker. A failure to start fails the job so nothing is left queued forever."""
    try:
        invoke_self({"task": _TASK_FOR_MODE[mode], "job_id": job_id, "continuation": 0})
    except Exception as e:  # noqa: BLE001
        logger.error("Failed to start %s job %s: %s", mode, job_id, type(e).__name__)
        with connection.cursor() as cur:
            cur.execute(
                "UPDATE embedding_jobs SET status = 'failed', finished_at = now(), updated_at = now(), "
                "last_error = %s WHERE id = %s::uuid",
                ("The job could not be started", job_id),
            )
        connection.commit()
        return _response(event, 502, {"error": "We couldn't start the job. Please try again.", "id": job_id})
    return _response(event, 202, {"id": job_id, "job_id": job_id, "mode": mode, "status": "queued"})


def _active_job_exists(connection, modes: tuple, space_id: Optional[str] = None) -> Optional[str]:
    sql = "SELECT id::text FROM embedding_jobs WHERE status IN ('queued', 'running') AND mode = ANY(%s)"
    params: list = [list(modes)]
    if space_id:
        sql += " AND space_id = %s::uuid"
        params.append(space_id)
    with connection.cursor() as cur:
        cur.execute(sql + " LIMIT 1", tuple(params))
        row = cur.fetchone()
    connection.commit()
    return row[0] if row else None


def create_job(event, body, connection, space_id, admin):
    mode = body.get("mode")
    if mode not in JOB_MODES:
        return _response(event, 400, {"error": "mode must be dry_run, rebuild or delta."})
    space = _load_space(connection, space_id)
    if space is None:
        return _response(event, 404, {"error": "Embedding space not found."})
    if space["status"] == "purged":
        return _response(event, 409, {"error": "This space has been purged and cannot be rebuilt."})
    if lock_state(connection)["locked"]:
        return _locked_response(event)

    if mode in ("rebuild", "delta"):
        _reap_stale_jobs(connection, ("rebuild", "delta"), STALE_REBUILD_SECONDS, space_id)
        running = _active_job_exists(connection, ("rebuild", "delta"), space_id)
        if running:
            return _response(event, 409, {
                "error": "A rebuild is already running for this space.", "job_id": running,
            })
    try:
        job_id = _insert_job(connection, space_id, mode, admin)
    except Exception as e:  # noqa: BLE001
        if _is_unique_violation(e):
            _rollback_quietly(connection)
            return _response(event, 409, {"error": "A rebuild is already running for this space."})
        raise
    return _start_job(event, connection, job_id, mode)


def create_validate_job(event, body, connection, space_id, admin):
    request: Dict[str, Any] = {}
    tolerance = body.get("tolerance")
    if tolerance is not None:
        if not _is_number(tolerance) or not 0 <= tolerance <= MAX_TOLERANCE:
            return _response(event, 400, {"error": f"tolerance must be a number from 0 to {MAX_TOLERANCE}."})
        request["tolerance"] = tolerance
    skip_quality = body.get("skip_quality")
    if skip_quality is not None:
        if not isinstance(skip_quality, bool):
            return _response(event, 400, {"error": "skip_quality must be true or false."})
        request["skip_quality"] = skip_quality

    space = _load_space(connection, space_id)
    if space is None:
        return _response(event, 404, {"error": "Embedding space not found."})
    if space["status"] not in ("building", "validated"):
        return _response(event, 409, {
            "error": f"A {space['status']} space cannot be validated. Only a building or validated space can.",
        })
    job_id = _insert_job(connection, space_id, "validate", admin, {"request": request})
    return _start_job(event, connection, job_id, "validate")


def create_cutover_job(event, body, connection, space_id, admin, mode: str):
    """POST .../activate and .../rollback: check the preconditions, record the job, start it."""
    request: Dict[str, Any] = {}
    if mode == "activate":
        skip_quality = body.get("skip_quality")
        if skip_quality is not None:
            if not isinstance(skip_quality, bool):
                return _response(event, 400, {"error": "skip_quality must be true or false."})
            request["skip_quality"] = skip_quality

    space = _load_space(connection, space_id)
    if space is None:
        return _response(event, 404, {"error": "Embedding space not found."})

    with connection.cursor() as cur:
        cur.execute("SELECT space_id::text FROM embedding_active_space WHERE id = 1")
        pointer = cur.fetchone()
    connection.commit()
    if not pointer:
        return _response(event, 409, {"error": "There is no active embedding space to switch from."})
    old_space_id = pointer[0]

    if space["id"] == old_space_id:
        return _response(event, 409, {"error": "This space is already the active space."})
    if mode == "activate":
        if space["status"] == "retired":
            return _response(event, 409, {"error": "This space is retired. Use rollback to return to it."})
        if space["status"] != "validated":
            return _response(event, 409, {"error": "Only a validated space can be activated. Validate it first."})
    else:
        if space["status"] != "retired":
            return _response(event, 409, {"error": "Only a retired space can be rolled back to."})

    _reap_stale_jobs(connection, ("activate", "rollback"), STALE_CUTOVER_SECONDS)
    running = _active_job_exists(connection, ("activate", "rollback"))
    if running:
        return _response(event, 409, {"error": "A cutover is already in progress.", "job_id": running})
    if lock_state(connection)["locked"]:
        return _locked_response(event)

    report = {"request": request, "old_space_id": old_space_id, "new_space_id": space["id"]}
    try:
        job_id = _insert_job(connection, space_id, mode, admin, report)
    except Exception as e:  # noqa: BLE001
        if _is_unique_violation(e):
            _rollback_quietly(connection)
            return _response(event, 409, {"error": "A cutover is already in progress."})
        raise
    return _start_job(event, connection, job_id, mode)


def get_job(event, connection, job_id):
    job = load_job(connection, job_id)
    connection.commit()
    if job is None:
        return _response(event, 404, {"error": "Job not found."})
    total = job["total_chunks"]
    job["progress_percent"] = (
        round(100.0 * job["processed"] / total, 1) if total else None
    )
    # The cursor is an internal chunk id; the UI has no use for it.
    job.pop("cursor", None)
    if job["mode"] == "dry_run" and job["status"] == "succeeded" and not job["price_configured"]:
        job["cost_note"] = "price not configured"
    return _response(event, 200, job)
