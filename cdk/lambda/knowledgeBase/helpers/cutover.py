"""
Cutover and rollback between embedding spaces (async tasks `activate_space` and
`rollback_space`).

Switching the live space is a pointer flip, not a rebuild: the new space was built next
to the live one (reembed_space), validated (validate_space), and activation only has to
make sure it is complete at the instant the single pointer row moves. Chat keeps
answering from the old space until the flip; only SYNCING is paused, for a few minutes.

Steps (persisted in embedding_jobs.steps / current_step; the UI polls plain text):

  1 lock              cutover_locked = true on the pointer row. The ingestion entry points
                      (sync routes, guideline upload and rename) then answer 409
                      CUTOVER_LOCKED and a finished Transcribe job defers its run
                      (helpers/ingestion_lock.py).
  2 wait_idle         wait until no ingestion run is 'running' and no guideline document
                      is 'processing'
                      (ACTIVATE_IDLE_TIMEOUT_SECONDS, default 900; fail and unlock on timeout)
  3 delta             embed what the target space still lacks (reembed_space.run_delta,
                      inline). Rollback: the same, on the RETIRED target.
  4 revalidate        coverage + per-source-type criteria and, for an activation, the golden
                      set against both spaces. That run also captures the pre-flip baseline.
                      Rollback re-checks coverage only.
  5 flip              ONE transaction: old active -> retired, new -> active, pointer moved
                      (compare-and-swap on the old space id). Any miss rolls the whole
                      transaction back and fails the job with the pointer unchanged.
  6 post_flip_check   wait one text-generation cache TTL (65 s), embed whatever late writers
                      left behind in the new space, then run the golden set against the NEW
                      active space and compare with the baseline. A failure emits the
                      PostFlipCheckFailed metric and fails the job. It does NOT roll back
                      by itself: an automatic rollback could flip traffic twice in minutes
                      on a flaky check; the operator decides using the Rollback action.
  7 unlock            ALWAYS, in a `finally`, whatever happened above.

The lock cannot outlive the job: it is released on every exit path of the task, refreshed
as the job makes progress, and treated as expired after ingestion_lock.LOCK_TTL_SECONDS
if the Lambda is killed before it can release it.

Long steps (waiting for ingestion, the delta, waiting out the cache TTL, the golden set)
hand over to a fresh invocation (Event self-invoke, continuation + 1) when time runs low.
Logs and reports carry ids, step names and counts only.
"""

import datetime
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

from helpers import validate_space
from helpers.admin_audit import actor_from_event
from helpers.embedding_jobs import (
    TERMINAL_STATUSES,
    emit_metric,
    error_summary,
    finish_job,
    invoke_self,
    load_job,
    mark_running,
    rollback_quietly,
    time_left_fn,
)
from helpers.embedding_space import fetch_space
from helpers.ingestion_lock import LOCK_TTL_SECONDS
from helpers.reembed_space import count_remaining, run_delta

logger = logging.getLogger()
logger.setLevel(logging.INFO)

STEP_NAMES = ("lock", "wait_idle", "delta", "revalidate", "flip", "post_flip_check", "unlock")
_WORK_STEPS = STEP_NAMES[:-1]

CACHE_TTL_SECONDS = 65     # textGeneration caches the active space for 60 s
POLL_SECONDS = 10
DEFAULT_IDLE_TIMEOUT_SECONDS = 900
RESERVE_SECONDS = 60
QUALITY_MIN_SECONDS = 180  # a golden-set run needs this much time, else continue fresh
_MAX_CONTINUATIONS = 200

POST_FLIP_METRIC = "PostFlipCheckFailed"
_CONTINUE = object()

_TASKS = {"activate": "activate_space", "rollback": "rollback_space"}
_EXPECTED_NEW_STATUS = {"activate": "validated", "rollback": "retired"}


class CutoverError(RuntimeError):
    """A cutover step failed in a way worth a clear, text-free message."""


class PostFlipCheckFailed(CutoverError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


@dataclass
class _Context:
    kind: str
    job: Dict[str, Any]
    old_space_id: str
    new_space_id: str
    skip_quality: bool
    tolerance: float


# ── Time ──────────────────────────────────────────────────────────────────────

def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(moment: datetime.datetime) -> str:
    return moment.isoformat()


def _idle_timeout_seconds() -> int:
    try:
        value = int(os.environ.get("ACTIVATE_IDLE_TIMEOUT_SECONDS", DEFAULT_IDLE_TIMEOUT_SECONDS))
    except ValueError:
        return DEFAULT_IDLE_TIMEOUT_SECONDS
    return value if value > 0 else DEFAULT_IDLE_TIMEOUT_SECONDS


# ── Progress (steps persisted on the job row) ─────────────────────────────────

class _Progress:
    def __init__(self, connection, job: Dict[str, Any]):
        self.connection = connection
        self.job_id = job["id"]
        steps = list(job.get("steps") or [])
        if not steps:
            steps = [
                {"name": name, "status": "pending", "started_at": None, "finished_at": None, "detail": None}
                for name in STEP_NAMES
            ]
        self.steps = steps
        self.report: Dict[str, Any] = dict(job.get("report") or {})
        self.current: Optional[str] = job.get("current_step")

    def entry(self, name: str) -> Dict[str, Any]:
        for step in self.steps:
            if step["name"] == name:
                return step
        raise KeyError(name)

    def persist(self) -> None:
        with self.connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE embedding_jobs
                   SET steps = %s::jsonb, current_step = %s, report = %s::jsonb, updated_at = now()
                 WHERE id = %s::uuid
                """,
                (json.dumps(self.steps), self.current, json.dumps(self.report, default=str), self.job_id),
            )
        self.connection.commit()

    def begin(self, name: str) -> None:
        step = self.entry(name)
        if step["status"] == "pending":
            step.update(status="running", started_at=_iso(_now()))
        self.current = name
        self.persist()

    def started_at(self, name: str) -> datetime.datetime:
        stamp = self.entry(name).get("started_at")
        return datetime.datetime.fromisoformat(stamp) if stamp else _now()

    def done(self, name: str, detail: Optional[str] = None) -> None:
        self.entry(name).update(status="done", finished_at=_iso(_now()), detail=detail)
        self.persist()

    def fail(self, name: str, detail: str) -> None:
        self.entry(name).update(status="failed", finished_at=_iso(_now()), detail=detail)
        self.persist()


# ── Lock ──────────────────────────────────────────────────────────────────────

def _acquire_lock(connection, job_id: str) -> None:
    """Take the lock; a lock past its TTL (dead job) can be taken over, another live one cannot."""
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE embedding_active_space
               SET cutover_locked = true, cutover_locked_at = now(),
                   cutover_job_id = %s::uuid, updated_at = now()
             WHERE id = 1
               AND (cutover_locked = false
                    OR cutover_job_id = %s::uuid
                    OR cutover_locked_at < now() - make_interval(secs => %s))
            """,
            (job_id, job_id, LOCK_TTL_SECONDS),
        )
        taken = cursor.rowcount == 1
    connection.commit()
    if not taken:
        raise CutoverError("Another cutover holds the lock; try again when it has finished")


def _heartbeat(connection, job_id: str) -> None:
    """Refresh the lock time and the job's updated_at so neither looks dead mid-job."""
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE embedding_active_space SET cutover_locked_at = now() "
            "WHERE id = 1 AND cutover_locked = true AND cutover_job_id = %s::uuid",
            (job_id,),
        )
        cursor.execute("UPDATE embedding_jobs SET updated_at = now() WHERE id = %s::uuid", (job_id,))
    connection.commit()


def _release_lock(connection, job_id: str) -> bool:
    """
    Release THIS job's lock. Never raises: a failure is logged and the lock then
    expires by itself after LOCK_TTL_SECONDS.
    """
    rollback_quietly(connection)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE embedding_active_space
                   SET cutover_locked = false, cutover_locked_at = NULL,
                       cutover_job_id = NULL, updated_at = now()
                 WHERE id = 1 AND cutover_job_id = %s::uuid
                """,
                (job_id,),
            )
        connection.commit()
        return True
    except Exception as e:  # noqa: BLE001
        rollback_quietly(connection)
        logger.error(
            "Could not release the cutover lock for job %s (%s); it expires after %s s",
            job_id, error_summary(e), LOCK_TTL_SECONDS,
        )
        return False


# ── Steps ─────────────────────────────────────────────────────────────────────

def _load_spaces(connection, ctx: _Context):
    new = fetch_space(connection, ctx.new_space_id)
    old = fetch_space(connection, ctx.old_space_id)
    connection.commit()
    if new is None or old is None:
        raise CutoverError("An embedding space in this cutover no longer exists")
    return new, old


def _step_lock(connection, ctx: _Context, progress: _Progress, time_left):
    _acquire_lock(connection, ctx.job["id"])
    # Re-check what the API checked, now that nothing else can change the pointer.
    with connection.cursor() as cursor:
        cursor.execute("SELECT space_id::text FROM embedding_active_space WHERE id = 1")
        pointer = cursor.fetchone()
    connection.commit()
    if not pointer or pointer[0] not in (ctx.old_space_id, ctx.new_space_id):
        raise CutoverError("The active space changed after this request was made")
    new, _old = _load_spaces(connection, ctx)
    already = pointer[0] == ctx.new_space_id
    if not already and new.status != _EXPECTED_NEW_STATUS[ctx.kind]:
        raise CutoverError(f"The target space is {new.status}, expected {_EXPECTED_NEW_STATUS[ctx.kind]}")
    return None


def _running_ingestion_count(connection) -> int:
    """
    Running ingestion runs plus guideline documents still being read. A 'processing'
    guideline row older than the longest Lambda run (15 min) is a dead worker, not a
    writer, so it cannot hold the cutover until the idle timeout.
    """
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT (SELECT count(*) FROM ingestion_runs
                     WHERE status = 'running'::ingestion_status)
                 + (SELECT count(*) FROM guideline_documents
                     WHERE status = 'processing'
                       AND updated_at > now() - interval '15 minutes')
            """
        )
        count = int(cursor.fetchone()[0])
    connection.commit()
    return count


def _step_wait_idle(connection, ctx: _Context, progress: _Progress, time_left):
    timeout = _idle_timeout_seconds()
    started = progress.started_at("wait_idle")
    while True:
        running = _running_ingestion_count(connection)
        if running == 0:
            waited = int((_now() - started).total_seconds())
            return f"idle after {waited} s"
        elapsed = (_now() - started).total_seconds()
        if elapsed >= timeout:
            raise CutoverError(f"{running} ingestion run(s) were still running after {timeout} s")
        _heartbeat(connection, ctx.job["id"])
        if time_left() < RESERVE_SECONDS + POLL_SECONDS:
            return _CONTINUE
        time.sleep(POLL_SECONDS)


def _delta_for(connection, ctx: _Context, space, time_left, job_id: str):
    """run_delta on `space`, with the lock refreshed after every batch."""
    reload = load_job(connection, job_id)
    connection.commit()
    cursor = (reload or {}).get("cursor")
    if reload is not None and reload.get("total_chunks") is None:
        total = count_remaining(connection, space.id)
        with connection.cursor() as cur:
            cur.execute("UPDATE embedding_jobs SET total_chunks = %s WHERE id = %s::uuid", (total, job_id))
        connection.commit()
    return run_delta(
        connection, space, space.spec,
        job_id=job_id,
        time_left=time_left,
        cursor=cursor,
        on_batch=lambda _n: _heartbeat(connection, job_id),
    )


def _step_delta(connection, ctx: _Context, progress: _Progress, time_left):
    new, _old = _load_spaces(connection, ctx)
    outcome = _delta_for(connection, ctx, new, time_left, ctx.job["id"])
    if not outcome.done:
        return _CONTINUE
    return f"embedded {outcome.processed} in the final pass" if outcome.processed else "nothing left to embed"


def _step_revalidate(connection, ctx: _Context, progress: _Progress, time_left):
    include_quality = ctx.kind == "activate" and not ctx.skip_quality
    if include_quality and time_left() < QUALITY_MIN_SECONDS:
        return _CONTINUE
    new, old = _load_spaces(connection, ctx)
    report = validate_space.run_validation(
        connection, new, old,
        tolerance=ctx.tolerance,
        include_quality=include_quality,
        time_left=time_left,
    )
    progress.report["revalidate"] = report
    if include_quality:
        progress.report["baseline"] = report["quality"]["active"]["metrics"]
    progress.persist()
    if not report["passed"]:
        failed = ", ".join(validate_space.failed_criteria(report)) or "criteria"
        raise CutoverError(f"Re-validation did not pass: {failed}")
    return "coverage ok" + (", quality ok" if include_quality else "")


def _already_flipped(connection, ctx: _Context) -> bool:
    with connection.cursor() as cursor:
        cursor.execute("SELECT space_id::text FROM embedding_active_space WHERE id = 1")
        row = cursor.fetchone()
    connection.commit()
    return bool(row) and row[0] == ctx.new_space_id


def _flip(connection, ctx: _Context) -> None:
    """
    Move the pointer in ONE transaction. Every UPDATE must touch exactly one row, else
    the transaction is rolled back and nothing has changed.
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "UPDATE embedding_spaces SET status = 'retired', retired_at = now() "
                "WHERE id = %s::uuid AND status = 'active'",
                (ctx.old_space_id,),
            )
            if cursor.rowcount != 1:
                raise CutoverError("The outgoing space is no longer active")
            cursor.execute(
                "UPDATE embedding_spaces SET status = 'active', activated_at = now(), retired_at = NULL "
                "WHERE id = %s::uuid AND status = %s",
                (ctx.new_space_id, _EXPECTED_NEW_STATUS[ctx.kind]),
            )
            if cursor.rowcount != 1:
                raise CutoverError("The target space is not in the expected state")
            cursor.execute(
                "UPDATE embedding_active_space SET space_id = %s::uuid, updated_at = now() "
                "WHERE id = 1 AND space_id = %s::uuid",
                (ctx.new_space_id, ctx.old_space_id),
            )
            if cursor.rowcount != 1:
                raise CutoverError("The active pointer changed during the cutover")
        connection.commit()
    except Exception:
        rollback_quietly(connection)
        raise


def _step_flip(connection, ctx: _Context, progress: _Progress, time_left):
    if _already_flipped(connection, ctx):  # re-entered after the commit but before it was recorded
        return "already flipped"
    _flip(connection, ctx)
    logger.info("Embedding pointer moved (%s)", ctx.kind)
    return "pointer moved"


def golden_check(metrics: Dict[str, Any], baseline: Optional[Dict[str, Any]], tolerance: float) -> Optional[str]:
    """None when the post-flip golden run is acceptable, else a failure code."""
    if baseline:
        comparison = validate_space.compare_quality(metrics, baseline, tolerance)
        return None if comparison["passed"] else "QUALITY_BELOW_BASELINE"
    # No baseline (rollback, or quality skipped): only reject a space that finds nothing.
    return None if float(metrics.get(f"recall@{validate_space.NUM_RESULTS}", 0.0)) > 0 else "NO_RELEVANT_RESULTS"


def _step_post_flip_check(connection, ctx: _Context, progress: _Progress, time_left):
    state = progress.report.setdefault("post_flip", {})

    # 1. Let every text-generation container refresh its cached active space.
    elapsed = (_now() - progress.started_at("post_flip_check")).total_seconds()
    if elapsed < CACHE_TTL_SECONDS:
        remaining = CACHE_TTL_SECONDS - elapsed
        _heartbeat(connection, ctx.job["id"])
        if time_left() < remaining + RESERVE_SECONDS:
            return _CONTINUE
        time.sleep(remaining)

    new, _old = _load_spaces(connection, ctx)

    # 2. Writers that resolved the OLD space late may have left chunks without a vector here.
    if not state.get("delta_done"):
        outcome = _delta_for(connection, ctx, new, time_left, ctx.job["id"])
        if not outcome.done:
            return _CONTINUE
        state["delta_done"] = True
        state["late_writer_vectors"] = outcome.processed
        progress.persist()

    # 3. Golden set against the NEW active space.
    if ctx.kind == "activate" and ctx.skip_quality:
        state["quality"] = "skipped"
        progress.persist()
        return "quality check skipped by request"
    if time_left() < QUALITY_MIN_SECONDS:
        return _CONTINUE
    result = validate_space.evaluate_space(connection, new, validate_space.load_golden(), time_left=time_left)
    code = golden_check(result["metrics"], progress.report.get("baseline"), ctx.tolerance)
    state["quality"] = {"metrics": result["metrics"], "baseline": progress.report.get("baseline")}
    progress.persist()
    if code:
        raise PostFlipCheckFailed(code, f"Post-flip golden-set check failed ({code})")
    return "golden set ok"


_HANDLERS = {
    "lock": _step_lock,
    "wait_idle": _step_wait_idle,
    "delta": _step_delta,
    "revalidate": _step_revalidate,
    "flip": _step_flip,
    "post_flip_check": _step_post_flip_check,
}


def _execute(connection, ctx: _Context, progress: _Progress, time_left):
    """Run the work steps still to do. Returns _CONTINUE or None (all done)."""
    for name in _WORK_STEPS:
        if progress.entry(name)["status"] == "done":
            continue
        progress.begin(name)
        try:
            outcome = _HANDLERS[name](connection, ctx, progress, time_left)
        except Exception as e:  # noqa: BLE001
            rollback_quietly(connection)
            if name == "post_flip_check":
                code = e.code if isinstance(e, PostFlipCheckFailed) else type(e).__name__
                logger.error("Post-flip check failed for job %s: code=%s", ctx.job["id"], code)
                emit_metric(POST_FLIP_METRIC, code)
            detail = str(e)[:200] if isinstance(e, CutoverError) else error_summary(e)
            try:
                progress.fail(name, detail)
            except Exception:  # noqa: BLE001 - recording is best effort
                rollback_quietly(connection)
            raise
        if outcome is _CONTINUE:
            return _CONTINUE
        progress.done(name, outcome)
    return None


def _hand_over(connection, ctx: _Context, kind: str, continuation: int, actor=None) -> None:
    # `actor` (the originating admin, if known) is forwarded for logging.
    next_continuation = continuation + 1
    if next_continuation > _MAX_CONTINUATIONS:
        raise CutoverError(f"Stopped after {_MAX_CONTINUATIONS} continuations")
    _heartbeat(connection, ctx.job["id"])
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE embedding_jobs SET continuation = %s, updated_at = now() WHERE id = %s::uuid",
            (next_continuation, ctx.job["id"]),
        )
    connection.commit()
    payload = {"task": _TASKS[kind], "job_id": ctx.job["id"], "continuation": next_continuation}
    if actor is not None:
        payload["actor"] = actor
    invoke_self(payload)
    logger.info("Cutover job %s continues in a fresh invocation (%s)", ctx.job["id"], next_continuation)


# ── Entry points ──────────────────────────────────────────────────────────────

def _run(kind: str, event, connection, context) -> dict:
    job_id = event.get("job_id")
    continuation = int(event.get("continuation") or 0)
    job = load_job(connection, job_id) if job_id else None
    connection.commit()
    if job is None:
        logger.error("Cutover job not found: %s", job_id)
        return {"status": "not_found"}
    if job["status"] in TERMINAL_STATUSES:
        return {"status": job["status"]}
    if job["mode"] != kind:
        finish_job(connection, job["id"], "failed", last_error=f"Job mode is not {kind}")
        return {"status": "failed"}

    report = job.get("report") or {}
    request = report.get("request") or {}
    ctx = _Context(
        kind=kind,
        job=job,
        old_space_id=str(report.get("old_space_id") or ""),
        new_space_id=str(job["space_id"]),
        skip_quality=bool(request.get("skip_quality")),
        tolerance=validate_space.resolve_tolerance(request.get("tolerance")),
    )

    progress: Optional[_Progress] = None
    handed_over = False
    final_status, final_error = "succeeded", None
    time_left = time_left_fn(context)
    try:
        mark_running(connection, job["id"], continuation)
        if not ctx.old_space_id:
            raise CutoverError("The job has no outgoing space recorded")
        if continuation > _MAX_CONTINUATIONS:
            raise CutoverError(f"Stopped after {_MAX_CONTINUATIONS} continuations")
        progress = _Progress(connection, job)
        if _execute(connection, ctx, progress, time_left) is _CONTINUE:
            _hand_over(connection, ctx, kind, continuation, actor=actor_from_event(event))
            handed_over = True
    except Exception as e:  # noqa: BLE001 - recorded on the job, never re-raised
        rollback_quietly(connection)
        final_status = "failed"
        final_error = str(e)[:300] if isinstance(e, CutoverError) else error_summary(e)
        logger.error("Cutover job %s (%s) failed: %s", job["id"], kind, error_summary(e))
    finally:
        # Step 7, always: nothing above may leave syncing paused. Skipped only when a
        # fresh invocation of this same job has taken over (the lock stays for it).
        unlocked = True if handed_over else _release_lock(connection, job["id"])

    if handed_over:
        return {"status": "continued"}

    try:
        if progress is not None:
            if unlocked:
                progress.done("unlock", "sync resumed")
            else:
                progress.fail("unlock", "lock will expire by itself")
        if not unlocked and final_status == "succeeded":
            final_error = "The lock could not be released and will expire by itself"
        finish_job(connection, job["id"], final_status, last_error=final_error)
    except Exception as e:  # noqa: BLE001
        rollback_quietly(connection)
        logger.error("Could not record the result of cutover job %s: %s", job["id"], error_summary(e))
    return {"status": final_status}


def activate_space(event, connection, context=None) -> dict:
    """Async task `activate_space`: `{"task", "job_id", "continuation"}`."""
    return _run("activate", event, connection, context)


def rollback_space(event, connection, context=None) -> dict:
    """Async task `rollback_space`: `{"task", "job_id", "continuation"}`."""
    return _run("rollback", event, connection, context)
