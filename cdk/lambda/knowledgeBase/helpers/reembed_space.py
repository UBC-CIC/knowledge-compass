"""
Re-embed the corpus into an embedding space (async task `reembed_space`).

A space is built NEXT TO the live one from the chunks already stored in the database
(`chunks.embed_text`), so a rebuild never needs the original upload or crawl. Vectors go
to `chunk_embeddings` under the new space id; nothing the live space serves changes.

Modes (table embedding_jobs, migration 033):
  dry_run   count what would be embedded, estimate tokens / cost / time, write nothing
  rebuild   embed every chunk without a current vector in the space
  delta     the same loop; a separate mode for audit and for the one-active-job-per-space rule

Idempotent and resumable
------------------------
The work list is always "chunks with no vector in this space, or a vector whose
embed_hash differs from md5(chunks.embed_text)", scanned in chunk id order. Each batch
upserts its vectors and advances the job's `processed` and `cursor` in ONE transaction,
so a crash loses at most the batch in flight and a re-run embeds only what is still
missing. A final scan from the start (cursor NULL) must find nothing before the job is
`succeeded`; this also picks up chunks that gained ids behind the cursor meanwhile.
A successful rebuild leaves the space status alone: marking it `validated` is the
validate task's job (helpers/validate_space.py).

Time and throttling
-------------------
The Lambda hands over to a fresh invocation (Event self-invoke, continuation + 1) when
less than RESERVE_SECONDS remain, at most _MAX_CONTINUATIONS times. Bedrock throttling
is retried by botocore's adaptive mode first, then per batch with exponential backoff and
jitter (2, 4, 8, ... capped at 60 s, at most _MAX_TRIES attempts). A failed job keeps its
cursor and stores only the error class in `last_error`, never chunk text.

`run_delta` is the loop itself, reused inline by the cutover job (helpers/cutover.py).
"""

import json
import logging
import math
import random
import time
from dataclasses import dataclass, replace
from typing import Callable, List, Optional

from helpers import embeddings
from helpers.admin_audit import actor_from_event
from helpers.embedding_jobs import (
    TERMINAL_STATUSES,
    error_summary,
    finish_job,
    invoke_self,
    load_job,
    mark_running,
    rollback_quietly,
    time_left_fn,
)
from helpers.embedding_space import EmbeddingSpaceError, fetch_space

logger = logging.getLogger()
logger.setLevel(logging.INFO)

RESERVE_SECONDS = 60
_MAX_CONTINUATIONS = 200
_MAX_TRIES = 5
_BACKOFF_BASE_SECONDS = 2
_BACKOFF_CAP_SECONDS = 60
_SAMPLE_SIZE = 10
_TOKEN_CHARS = 4  # D8: tokens are estimated as ceil(chars / 4)
_NIL_UUID = "00000000-0000-0000-0000-000000000000"
_MODES = ("dry_run", "rebuild", "delta")
_clock = time.perf_counter  # module-level so tests can replace it without touching `time`

_THROTTLE_CODES = frozenset({
    "ThrottlingException",
    "ThrottledException",
    "ServiceQuotaExceededException",
    "TooManyRequestsException",
})

# The still-missing-or-stale work list. md5 comes from Postgres so the stored
# embed_hash is computed by the same function the read path compares against.
_SELECT_BATCH_SQL = """
    SELECT c.id::text, c.embed_text, md5(c.embed_text)
    FROM chunks c
    LEFT JOIN chunk_embeddings ce
      ON ce.chunk_id = c.id AND ce.space_id = %s::uuid
    WHERE c.id > %s::uuid
      AND (ce.chunk_id IS NULL OR ce.embed_hash <> md5(c.embed_text))
    ORDER BY c.id
    LIMIT %s
"""

# Same ON CONFLICT upsert as the writers (process_document_batch._upsert_chunk). The
# SELECT from chunks skips a chunk deleted since the batch was read instead of failing
# the foreign key; embed_hash is the hash read WITH the text, so a chunk edited
# meanwhile simply reads as stale and is picked up again.
_UPSERT_VECTOR_SQL = """
    INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)
    SELECT c.id, %s::uuid, %s::vector, %s, now()
    FROM chunks c
    WHERE c.id = %s::uuid
    ON CONFLICT (chunk_id, space_id) DO UPDATE SET
      embedding   = EXCLUDED.embedding,
      embed_hash  = EXCLUDED.embed_hash,
      embedded_at = EXCLUDED.embedded_at
"""

_REMAINING_FILTER = """
    FROM chunks c
    LEFT JOIN chunk_embeddings ce
      ON ce.chunk_id = c.id AND ce.space_id = %s::uuid
    WHERE ce.chunk_id IS NULL OR ce.embed_hash <> md5(c.embed_text)
"""


class ReembedError(RuntimeError):
    """A job failed in a way worth a clear, text-free message."""


@dataclass
class DeltaOutcome:
    done: bool                 # the final scan from the start found nothing left
    processed: int             # vectors written by this call
    cursor: Optional[str]      # last chunk id finished (None right after a completed scan)
    out_of_time: bool = False  # stopped early to hand over to a fresh invocation


# ── Pure helpers ──────────────────────────────────────────────────────────────

def estimate_tokens(chars: int) -> int:
    """Token estimate (an estimate: Titan's real count is only known after a call)."""
    return int(math.ceil(max(0, int(chars)) / float(_TOKEN_CHARS)))


def estimate_cost(tokens: int, price_per_1m_tokens) -> Optional[float]:
    """USD for `tokens`, or None when the space has no price configured."""
    if price_per_1m_tokens is None:
        return None
    return round(tokens / 1_000_000.0 * float(price_per_1m_tokens), 4)


def single_text_adapter(spec: "embeddings.ModelSpec") -> bool:
    """Adapters that send one text per request (Titan) have batch_size 1."""
    return int(spec.batch_size) <= 1


def estimate_seconds(rows: int, sample_count: int, sample_seconds: float, spec: "embeddings.ModelSpec") -> int:
    """
    Extrapolate the run time from a timed sample call. Batched adapters:
    ceil(rows / batch_size) calls of `sample_seconds` each, spread over `concurrency`.
    Single-text adapters: `rows` calls of the per-text sample time, over `concurrency`.
    The single-text sample must be timed sequentially (see _sample_seconds).
    """
    if rows <= 0 or sample_count <= 0:
        return 0
    workers = max(1, int(spec.concurrency))
    if single_text_adapter(spec):
        per_text = sample_seconds / sample_count
        return int(math.ceil(rows * per_text / workers))
    calls = int(math.ceil(rows / float(spec.batch_size)))
    return int(math.ceil(calls * sample_seconds / workers))


def select_batch_size(spec: "embeddings.ModelSpec") -> int:
    """Rows read per batch: two full requests for batching adapters, 8 per worker for Titan."""
    if single_text_adapter(spec):
        return max(1, int(spec.concurrency)) * 8
    return int(spec.batch_size) * 2


def is_throttle(error: BaseException) -> bool:
    response = getattr(error, "response", None)
    code = ((response or {}).get("Error") or {}).get("Code") if isinstance(response, dict) else None
    return code in _THROTTLE_CODES or type(error).__name__ in _THROTTLE_CODES


def embed_with_backoff(texts: List[str], spec: "embeddings.ModelSpec") -> List[List[float]]:
    """
    embed_documents with per-batch exponential backoff and jitter on throttling.
    Anything that is not a throttle error is raised at once.
    """
    delay = _BACKOFF_BASE_SECONDS
    for attempt in range(1, _MAX_TRIES + 1):
        try:
            return embeddings.embed_documents(texts, spec)
        except Exception as e:  # noqa: BLE001
            if not is_throttle(e) or attempt == _MAX_TRIES:
                raise
            wait = min(delay, _BACKOFF_CAP_SECONDS) * random.uniform(0.75, 1.0)
            logger.warning(
                "Embedding throttled (attempt %s of %s); retrying in %.1f s", attempt, _MAX_TRIES, wait
            )
            time.sleep(wait)
            delay = min(delay * 2, _BACKOFF_CAP_SECONDS)
    raise AssertionError("unreachable")  # pragma: no cover


# ── Database helpers ──────────────────────────────────────────────────────────

def count_remaining(connection, space_id: str) -> int:
    """Chunks with no current vector in the space."""
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT count(*) {_REMAINING_FILTER}", (space_id,))
        row = cursor.fetchone()
    connection.commit()
    return int(row[0]) if row else 0


def _select_batch(connection, space_id: str, cursor_id: Optional[str], limit: int) -> list:
    with connection.cursor() as cursor:
        cursor.execute(_SELECT_BATCH_SQL, (space_id, cursor_id or _NIL_UUID, int(limit)))
        rows = cursor.fetchall()
    # End the read transaction before the (slow) embedding call.
    connection.commit()
    return rows


def _write_batch(connection, space_id: str, job_id: str, rows: list, vectors: list, cursor_id: str) -> None:
    """Upsert the batch's vectors and advance the job in ONE transaction."""
    try:
        with connection.cursor() as cursor:
            for (chunk_id, _text, embed_hash), vector in zip(rows, vectors):
                literal = "[" + ",".join(str(x) for x in vector) + "]"
                cursor.execute(_UPSERT_VECTOR_SQL, (space_id, literal, embed_hash, chunk_id))
            cursor.execute(
                """
                UPDATE embedding_jobs
                   SET processed = processed + %s, cursor = %s, updated_at = now()
                 WHERE id = %s::uuid
                """,
                (len(rows), cursor_id, str(job_id)),
            )
        connection.commit()
    except Exception:
        rollback_quietly(connection)
        raise


def _clear_cursor(connection, job_id: str) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE embedding_jobs SET cursor = NULL, updated_at = now() WHERE id = %s::uuid",
            (str(job_id),),
        )
    connection.commit()


# ── The loop ──────────────────────────────────────────────────────────────────

def run_delta(
    connection,
    space,
    spec: "embeddings.ModelSpec",
    *,
    job_id: str,
    time_left: Callable[[], float],
    cursor: Optional[str] = None,
    reserve_seconds: float = RESERVE_SECONDS,
    on_batch: Optional[Callable[[int], None]] = None,
) -> DeltaOutcome:
    """
    Embed every chunk of `space` that has no current vector, in id order from `cursor`.

    Returns done=True only after a scan from the very start found nothing left. Returns
    out_of_time=True (not done) when fewer than `reserve_seconds` remain; the caller
    continues in a fresh invocation from the returned cursor. Progress (`processed`,
    `cursor`) is written to the job row per batch. Exceptions propagate after the
    in-flight batch is rolled back; earlier batches stay committed.
    """
    space_id = str(space.id if hasattr(space, "id") else space["id"])
    limit = select_batch_size(spec)
    processed = 0
    current = cursor
    while True:
        if time_left() < reserve_seconds:
            return DeltaOutcome(done=False, processed=processed, cursor=current, out_of_time=True)
        rows = _select_batch(connection, space_id, current, limit)
        if not rows:
            if current is None:
                return DeltaOutcome(done=True, processed=processed, cursor=None)
            # Reached the end of a pass: scan again from the start to be sure.
            current = None
            _clear_cursor(connection, job_id)
            continue
        vectors = embed_with_backoff([row[1] for row in rows], spec)
        if len(vectors) != len(rows):
            raise ReembedError("embedding count mismatch")
        _write_batch(connection, space_id, job_id, rows, vectors, rows[-1][0])
        current = rows[-1][0]
        processed += len(rows)
        if on_batch is not None:
            on_batch(len(rows))


# ── Dry run ───────────────────────────────────────────────────────────────────

def _remaining_stats(connection, space_id: str, max_chars: int) -> tuple:
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT count(*), COALESCE(sum(LEAST(length(c.embed_text), %s)), 0) {_REMAINING_FILTER}",
            (int(max_chars), space_id),
        )
        row = cursor.fetchone()
    connection.commit()
    return (int(row[0]), int(row[1])) if row else (0, 0)


def _sample_texts(connection, space_id: str, size: int) -> List[str]:
    with connection.cursor() as cursor:
        cursor.execute(
            f"SELECT c.embed_text {_REMAINING_FILTER} ORDER BY c.id LIMIT %s",
            (space_id, int(size)),
        )
        rows = cursor.fetchall()
    connection.commit()
    return [row[0] for row in rows]


def _sample_seconds(texts: List[str], spec: "embeddings.ModelSpec") -> float:
    """
    Time one real embedding call on the sample. A single-text adapter is timed with
    concurrency 1 so the per-text figure is sequential; estimate_seconds then divides
    by the configured concurrency once.
    """
    timed_spec = replace(spec, concurrency=1) if single_text_adapter(spec) else spec
    started = _clock()
    embeddings.embed_documents(texts, timed_spec)
    return _clock() - started


def _price(connection, space_id: str):
    with connection.cursor() as cursor:
        cursor.execute("SELECT price_per_1m_tokens FROM embedding_spaces WHERE id = %s::uuid", (space_id,))
        row = cursor.fetchone()
    connection.commit()
    return row[0] if row else None


def _dry_run(connection, job: dict, space, spec) -> None:
    """Estimate only: counts, tokens, cost and time. Writes nothing to chunk_embeddings."""
    rows, chars = _remaining_stats(connection, space.id, spec.max_chars)
    tokens = estimate_tokens(chars)
    price = _price(connection, space.id)
    cost = estimate_cost(tokens, price)

    est_seconds = None
    estimate_error = None
    sample_size = 0
    if rows == 0:
        est_seconds = 0
    else:
        try:
            sample = _sample_texts(connection, space.id, _SAMPLE_SIZE)
            sample_size = len(sample)
            seconds = _sample_seconds(sample, spec)
            est_seconds = estimate_seconds(rows, sample_size, seconds, spec)
        except Exception as e:  # noqa: BLE001 - an estimate problem, not a job failure
            rollback_quietly(connection)
            estimate_error = f"Time estimate unavailable: {error_summary(e)}"
            logger.warning("Dry-run sample embedding failed: %s", error_summary(e))

    report = {
        "chunks_to_embed": rows,
        "characters": chars,
        "token_estimate_method": f"ceil(characters / {_TOKEN_CHARS})",
        "sample_size": sample_size,
        "batch_size": int(spec.batch_size),
        "concurrency": int(spec.concurrency),
        "price_configured": price is not None,
    }
    with connection.cursor() as cursor:
        cursor.execute(
            """
            UPDATE embedding_jobs
               SET status = 'succeeded', total_chunks = %s, est_tokens = %s, est_cost_usd = %s,
                   est_seconds = %s, price_configured = %s, report = %s::jsonb,
                   last_error = %s, finished_at = now(), updated_at = now()
             WHERE id = %s::uuid
            """,
            (rows, tokens, cost, est_seconds, price is not None,
             json.dumps(report), estimate_error, job["id"]),
        )
    connection.commit()
    logger.info("Dry run for job %s: %s chunks, ~%s tokens", job["id"], rows, tokens)


# ── Rebuild / delta ───────────────────────────────────────────────────────────

def _set_total_if_unset(connection, job: dict, space_id: str) -> None:
    if job.get("total_chunks") is not None:
        return
    total = count_remaining(connection, space_id)
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE embedding_jobs SET total_chunks = %s, updated_at = now() WHERE id = %s::uuid",
            (total, job["id"]),
        )
    connection.commit()


def _hand_over(connection, job: dict, continuation: int, actor=None) -> dict:
    """Continue in a fresh invocation, or fail clearly at the continuation cap.
    `actor` (the originating admin, if known) is forwarded for logging."""
    next_continuation = continuation + 1
    if next_continuation > _MAX_CONTINUATIONS:
        finish_job(
            connection, job["id"], "failed",
            last_error=f"Stopped after {_MAX_CONTINUATIONS} continuations; start a delta job to resume",
        )
        return {"status": "failed", "reason": "continuation_cap"}
    with connection.cursor() as cursor:
        cursor.execute(
            "UPDATE embedding_jobs SET continuation = %s, updated_at = now() WHERE id = %s::uuid",
            (next_continuation, job["id"]),
        )
    connection.commit()
    payload = {"task": "reembed_space", "job_id": job["id"], "continuation": next_continuation}
    if actor is not None:
        payload["actor"] = actor
    invoke_self(payload)
    logger.info("Re-embed job %s continues in a fresh invocation (%s)", job["id"], next_continuation)
    return {"status": "continued", "continuation": next_continuation}


def _rebuild(connection, job: dict, space, spec, context, continuation: int, actor=None) -> dict:
    _set_total_if_unset(connection, job, space.id)
    outcome = run_delta(
        connection, space, spec,
        job_id=job["id"],
        time_left=time_left_fn(context),
        cursor=job.get("cursor"),
    )
    if outcome.done:
        finish_job(connection, job["id"], "succeeded")
        logger.info("Re-embed job %s finished", job["id"])
        return {"status": "succeeded"}
    return _hand_over(connection, job, continuation, actor=actor)


# ── Entry point ───────────────────────────────────────────────────────────────

def reembed_space(event, connection, context=None) -> dict:
    """
    Async worker. `event = {"task": "reembed_space", "job_id": ..., "continuation": n}`.
    Safe to deliver twice: a job already in a terminal status is left alone, and a
    re-run only picks up the chunks that are still missing.
    """
    job_id = event.get("job_id")
    continuation = int(event.get("continuation") or 0)
    job = load_job(connection, job_id) if job_id else None
    if job is None:
        logger.error("Re-embed job not found: %s", job_id)
        return {"status": "not_found"}
    if job["status"] in TERMINAL_STATUSES:
        return {"status": job["status"]}
    if job["mode"] not in _MODES:
        finish_job(connection, job["id"], "failed", last_error="Job mode is not a re-embed mode")
        return {"status": "failed"}

    try:
        space = fetch_space(connection, job["space_id"])
        if space is None:
            raise ReembedError("embedding space not found")
        spec = space.spec
        mark_running(connection, job["id"], continuation)
        if job["mode"] == "dry_run":
            _dry_run(connection, job, space, spec)
            return {"status": "succeeded"}
        return _rebuild(connection, job, space, spec, context, continuation, actor=actor_from_event(event))
    except Exception as e:  # noqa: BLE001 - recorded on the job, never re-raised
        rollback_quietly(connection)
        summary = error_summary(e) if not isinstance(e, (ReembedError, EmbeddingSpaceError)) else str(e)[:200]
        logger.error("Re-embed job %s failed: %s", job["id"], error_summary(e))
        try:
            finish_job(connection, job["id"], "failed", last_error=summary)
        except Exception as inner:  # noqa: BLE001
            rollback_quietly(connection)
            logger.error("Could not record failure of job %s: %s", job["id"], error_summary(inner))
        return {"status": "failed"}
