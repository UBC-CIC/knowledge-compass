"""
Validate an embedding space before it is activated (async task `validate_space`).

Three independent criteria, all stored in the job `report` (ids, counts and metrics
only; never chunk text or query text):

  1. Coverage        no chunk lacks a current vector (embed_hash = md5(embed_text)) in
                     the target space. Up to 20 sample chunk ids are listed.
  2. Source types    per sources.source_type: chunks vs current vectors in the target
                     (and in the active space, for comparison). Passes when the target
                     has no gaps and nothing the active space covers is missing there.
  3. Quality         every POSITIVE golden query runs through the SAME retrieval SQL as
                     chat (retrieval_core) against the active and the target space, each
                     query embedded with that space's own model. recall@5 and recall@15
                     of the target must be >= the active space's minus a tolerance
                     (VALIDATE_RECALL_TOLERANCE, default 0.05, overridable per job within
                     0..0.5). MRR is reported. near_miss / off_topic entries only feed the
                     score distribution and a SUGGESTED min_score, which is never applied.

On a pass the space moves building -> validated (validated stays validated). On a fail
the status is unchanged and the report is kept on the job. The golden set is the
synthetic kc_shared/golden_queries.json from the shared layer (the same file the
textGeneration eval runs against).

`run_validation` is the reusable core; helpers/cutover.py calls it again right before the
pointer flips.
"""

import json
import logging
import os
from typing import Any, Callable, Dict, List, Optional

from kc_shared import embeddings, eval_scoring, retrieval_core
from helpers.embedding_jobs import (
    TERMINAL_STATUSES,
    error_summary,
    finish_job,
    load_job,
    mark_running,
    rollback_quietly,
    time_left_fn,
)
from helpers.embedding_space import fetch_space

logger = logging.getLogger()
logger.setLevel(logging.INFO)

GOLDEN_PATH = os.path.join(os.path.dirname(os.path.abspath(eval_scoring.__file__)), "golden_queries.json")
K_VALUES = (5, 15)
NUM_RESULTS = max(K_VALUES)
DEFAULT_TOLERANCE = 0.05
MAX_TOLERANCE = 0.5
RESERVE_SECONDS = 60
SAMPLE_IDS = 20
_EPSILON = 1e-9
_VALIDATABLE_STATUSES = ("building", "validated")


class ValidationTimeout(RuntimeError):
    """Not enough Lambda time left to finish the golden-set run."""


# ── Inputs ────────────────────────────────────────────────────────────────────

def load_golden(path: Optional[str] = None) -> List[Dict[str, Any]]:
    with open(path or GOLDEN_PATH, "r", encoding="utf-8") as handle:
        entries = json.load(handle)
    if not isinstance(entries, list):
        raise ValueError("golden set must be a JSON list")
    return entries


def resolve_tolerance(requested=None) -> float:
    """
    The recall tolerance: the job request's value, else VALIDATE_RECALL_TOLERANCE,
    else 0.05. Always clamped to 0..MAX_TOLERANCE; a non-numeric value falls back.
    """
    for candidate in (requested, os.environ.get("VALIDATE_RECALL_TOLERANCE")):
        if candidate is None or isinstance(candidate, bool):
            continue
        try:
            value = float(candidate)
        except (TypeError, ValueError):
            continue
        if value != value:  # NaN
            continue
        return max(0.0, min(MAX_TOLERANCE, value))
    return DEFAULT_TOLERANCE


# ── Criterion 1 and 2: coverage ───────────────────────────────────────────────

_GAP_FILTER = """
    FROM chunks c
    LEFT JOIN chunk_embeddings ce
      ON ce.chunk_id = c.id AND ce.space_id = %s::uuid
    WHERE ce.chunk_id IS NULL OR ce.embed_hash <> md5(c.embed_text)
"""


def coverage_report(connection, space_id: str) -> Dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT count(*) {_GAP_FILTER}", (space_id,))
        missing = int(cursor.fetchone()[0])
        sample: List[str] = []
        if missing:
            cursor.execute(f"SELECT c.id::text {_GAP_FILTER} ORDER BY c.id LIMIT %s", (space_id, SAMPLE_IDS))
            sample = [row[0] for row in cursor.fetchall()]
    connection.commit()
    return {"chunks_without_current_vector": missing, "sample_chunk_ids": sample, "passed": missing == 0}


def source_type_report(connection, target_id: str, active_id: str) -> Dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT s.source_type::text,
                   count(*) AS chunks,
                   count(*) FILTER (WHERE t.chunk_id IS NOT NULL) AS target_current,
                   count(*) FILTER (WHERE a.chunk_id IS NOT NULL) AS active_current,
                   count(*) FILTER (WHERE a.chunk_id IS NOT NULL AND t.chunk_id IS NULL) AS active_only
            FROM chunks c
            JOIN sources s ON s.id = c.source_id
            LEFT JOIN chunk_embeddings t
              ON t.chunk_id = c.id AND t.space_id = %s::uuid AND t.embed_hash = md5(c.embed_text)
            LEFT JOIN chunk_embeddings a
              ON a.chunk_id = c.id AND a.space_id = %s::uuid AND a.embed_hash = md5(c.embed_text)
            GROUP BY s.source_type
            ORDER BY 1
            """,
            (target_id, active_id),
        )
        rows = cursor.fetchall()
    connection.commit()
    entries = []
    for source_type, chunks, target_current, active_current, active_only in rows:
        gaps = int(chunks) - int(target_current)
        entries.append({
            "source_type": source_type,
            "chunks": int(chunks),
            "target_current": int(target_current),
            "active_current": int(active_current),
            "target_gaps": gaps,
            "active_only": int(active_only),
            "passed": gaps == 0 and int(active_only) == 0,
        })
    return {"by_source_type": entries, "passed": all(e["passed"] for e in entries)}


# ── Criterion 3: golden-set quality ───────────────────────────────────────────

def _vector_literal(vector) -> str:
    return "[" + ",".join(str(x) for x in vector) + "]"


def evaluate_space(
    connection,
    space,
    golden: List[Dict[str, Any]],
    *,
    time_left: Callable[[], float],
    reserve_seconds: float = RESERVE_SECONDS,
) -> Dict[str, Any]:
    """Run the golden set against `space` (query embedded with the space's own model)."""
    spec = space.spec
    per_question: List[Dict[str, Any]] = []
    for item in golden:
        if time_left() < reserve_seconds:
            raise ValidationTimeout("not enough time left to finish the golden-set run")
        kind = eval_scoring.kind_of(item)
        query = item.get("search_query") or item.get("question") or ""
        vector = embeddings.embed_query(query, spec)
        try:
            with connection.cursor() as cursor:
                rows = retrieval_core.fetch_candidate_rows(
                    cursor, space, _vector_literal(vector), NUM_RESULTS, 0
                )
        finally:
            # SET LOCAL ends with the transaction; do not leak into the next query.
            rollback_quietly(connection)
        results = retrieval_core.select_results(rows, NUM_RESULTS, 0.0, 0)
        entry: Dict[str, Any] = {
            "id": item.get("id"),
            "kind": kind,
            "top_score": results[0]["score"] if results else None,
            "rank": None,
        }
        if kind == eval_scoring.KIND_POSITIVE:
            entry["rank"] = eval_scoring.first_relevant_rank(results, item, NUM_RESULTS)
        per_question.append(entry)

    distribution = eval_scoring.score_distribution(per_question)
    return {
        "space": {"id": str(space.id), "name": space.name},
        "metrics": eval_scoring.summarize(per_question, K_VALUES),
        "score_distribution": distribution,
        "suggested_min_score": eval_scoring.suggest_min_score(distribution),
        "missed_question_ids": [q["id"] for q in per_question
                                if q["kind"] == eval_scoring.KIND_POSITIVE and q["rank"] is None],
    }


def compare_quality(target_metrics: Dict[str, Any], baseline_metrics: Dict[str, Any], tolerance: float) -> Dict[str, Any]:
    """recall@k of the target must be >= the baseline's minus `tolerance` for every k."""
    deltas: Dict[str, Any] = {}
    passed = True
    for k in K_VALUES:
        key = f"recall@{k}"
        delta = round(float(target_metrics.get(key, 0.0)) - float(baseline_metrics.get(key, 0.0)), 4)
        ok = delta >= -tolerance - _EPSILON
        deltas[key] = {"delta": delta, "passed": ok}
        passed = passed and ok
    deltas["mrr"] = {"delta": round(float(target_metrics.get("mrr", 0.0)) - float(baseline_metrics.get("mrr", 0.0)), 4)}
    return {"tolerance": tolerance, "deltas": deltas, "passed": passed}


# ── The three criteria together ───────────────────────────────────────────────

def run_validation(
    connection,
    target,
    active,
    *,
    tolerance: float,
    include_quality: bool = True,
    time_left: Optional[Callable[[], float]] = None,
    golden: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """The validation report for `target` against the `active` space. Counts and ids only."""
    time_left = time_left or time_left_fn(None)
    coverage = coverage_report(connection, str(target.id))
    source_types = source_type_report(connection, str(target.id), str(active.id))
    report: Dict[str, Any] = {
        "target": {"id": str(target.id), "name": target.name},
        "active": {"id": str(active.id), "name": active.name},
        "tolerance": tolerance,
        "coverage": coverage,
        "source_types": source_types,
    }
    quality_passed: Optional[bool] = None
    if include_quality:
        golden = golden if golden is not None else load_golden()
        baseline = evaluate_space(connection, active, golden, time_left=time_left)
        candidate = evaluate_space(connection, target, golden, time_left=time_left)
        comparison = compare_quality(candidate["metrics"], baseline["metrics"], tolerance)
        report["quality"] = {"active": baseline, "target": candidate, "comparison": comparison}
        quality_passed = comparison["passed"]
    else:
        report["quality"] = {"skipped": True}
    report["criteria"] = {
        "coverage": coverage["passed"],
        "source_types": source_types["passed"],
        "quality": quality_passed,
    }
    report["passed"] = bool(
        coverage["passed"] and source_types["passed"] and (quality_passed is None or quality_passed)
    )
    return report


def failed_criteria(report: Dict[str, Any]) -> List[str]:
    return [name for name, ok in (report.get("criteria") or {}).items() if ok is False]


# ── Entry point ───────────────────────────────────────────────────────────────

def validate_space(event, connection, context=None) -> dict:
    """
    Async worker. `event = {"task": "validate_space", "job_id": ...}`. The job's
    `report.request` may carry `tolerance` (0..0.5).
    """
    job_id = event.get("job_id")
    job = load_job(connection, job_id) if job_id else None
    if job is None:
        logger.error("Validation job not found: %s", job_id)
        return {"status": "not_found"}
    if job["status"] in TERMINAL_STATUSES:
        return {"status": job["status"]}
    if job["mode"] != "validate":
        finish_job(connection, job["id"], "failed", last_error="Job mode is not validate")
        return {"status": "failed"}

    request = (job.get("report") or {}).get("request") or {}
    try:
        mark_running(connection, job["id"], int(event.get("continuation") or 0))
        target = fetch_space(connection, job["space_id"])
        active = fetch_space(connection)
        if target is None or active is None:
            finish_job(connection, job["id"], "failed", last_error="Embedding space not found")
            return {"status": "failed"}
        if target.status not in _VALIDATABLE_STATUSES:
            finish_job(connection, job["id"], "failed",
                       last_error=f"A {target.status} space cannot be validated")
            return {"status": "failed"}

        report = run_validation(
            connection,
            target,
            active,
            tolerance=resolve_tolerance(request.get("tolerance")),
            include_quality=not bool(request.get("skip_quality")),
            time_left=time_left_fn(context),
        )
        report["request"] = request
        if report["passed"]:
            with connection.cursor() as cursor:
                cursor.execute(
                    "UPDATE embedding_spaces SET status = 'validated' "
                    "WHERE id = %s::uuid AND status IN ('building', 'validated')",
                    (target.id,),
                )
            connection.commit()
            finish_job(connection, job["id"], "succeeded", report=report)
            logger.info("Space %s validated", target.name)
            return {"status": "succeeded", "passed": True}
        failed = ", ".join(failed_criteria(report)) or "criteria"
        finish_job(connection, job["id"], "failed", last_error=f"Validation did not pass: {failed}", report=report)
        logger.info("Space %s did not pass validation: %s", target.name, failed)
        return {"status": "failed", "passed": False}
    except Exception as e:  # noqa: BLE001 - recorded on the job, never re-raised
        rollback_quietly(connection)
        logger.error("Validation job %s failed: %s", job["id"], error_summary(e))
        message = str(e)[:200] if isinstance(e, ValidationTimeout) else error_summary(e)
        try:
            finish_job(connection, job["id"], "failed", last_error=message)
        except Exception as inner:  # noqa: BLE001
            rollback_quietly(connection)
            logger.error("Could not record failure of job %s: %s", job["id"], error_summary(inner))
        return {"status": "failed"}
