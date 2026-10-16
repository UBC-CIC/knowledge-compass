import logging
from datetime import datetime, timezone, timedelta, time
import helpers.config as config

logger = logging.getLogger(__name__)

# usage["reason"] on a rejection caused by the service-wide daily message
# budget (global_daily_usage, migration 036) rather than the user's own
# character allowance. Per-user rejections carry no reason key.
GLOBAL_LIMIT_REASON = "global_daily_messages"


def claim_generation_slot(user_id: str, request_id: str, db_connection) -> bool:
    """
    Claims the user's single in-flight generation slot (table
    user_inflight_generations, migration 037) for `request_id`.

    One atomic INSERT ... ON CONFLICT (user_id) DO UPDATE ... WHERE statement:
    the row is taken over only when the held slot is stale (older than 90
    seconds, above the 60 second textGeneration Lambda timeout, so a live
    generation is never displaced) or already belongs to the same request id
    (a retried invocation), so two parallel requests
    from one user cannot both claim it. Only the request id and start time are
    stored, never message text.

    Raises on DB errors (after rolling back) so the caller fails closed.

    Returns:
        True if this request now holds the slot, False if another generation
        for the user is still in flight.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO user_inflight_generations (user_id, request_id, started_at)
                VALUES (%s, %s, now())
                ON CONFLICT (user_id) DO UPDATE
                   SET request_id = EXCLUDED.request_id,
                       started_at = now()
                 WHERE user_inflight_generations.started_at < now() - interval '90 seconds'
                    OR user_inflight_generations.request_id = EXCLUDED.request_id
                RETURNING request_id
                """,
                (user_id, request_id),
            )
            claimed = cur.fetchone() is not None
        db_connection.commit()
        return claimed
    except Exception as e:
        db_connection.rollback()
        logger.error("Generation slot claim failed: %s", type(e).__name__)
        raise


def release_generation_slot(user_id: str, request_id: str, db_connection) -> None:
    """
    Releases the slot claimed by `request_id`. Deletes only this request's own
    row, so a slot that was taken over as stale is left alone.

    Never raises: it runs in a `finally`. If the connection is in an aborted
    transaction (a DB error during generation), it rolls back and tries once
    more; if that fails too, the slot expires after the stale window.
    """
    for attempt in range(2):
        try:
            with db_connection.cursor() as cur:
                cur.execute(
                    """
                    DELETE FROM user_inflight_generations
                    WHERE user_id = %s AND request_id = %s
                    """,
                    (user_id, request_id),
                )
            db_connection.commit()
            return
        except Exception as e:
            try:
                db_connection.rollback()
            except Exception:
                pass
            if attempt == 1:
                logger.error("Generation slot release failed: %s", type(e).__name__)


def reserve_daily_characters(
    user_id: str,
    char_count: int,
    db_connection,
    limit: int,
    now: datetime | None = None,
    request_id: str | None = None,
    global_limit: int | None = None,
) -> tuple[bool, dict]:
    """
    Atomically counts `char_count` characters against the user's allowance for
    the current UTC calendar day (table user_daily_usage, migration 034).

    The message is allowed only if the new total stays within `limit`; a
    rejected message is not counted (never truncated). The check and the
    increment are one INSERT ... ON CONFLICT DO UPDATE ... WHERE statement, so
    concurrent messages from the same user cannot both slip past the limit.
    Only counts are stored, never message text.

    `request_id` (the Lambda aws_request_id, unchanged across async retries)
    makes the reservation idempotent: it is claimed in daily_usage_requests
    with ON CONFLICT DO NOTHING in the same transaction as the increment. A
    request id that was already counted is allowed again without counting; a
    rejected message rolls back its claim so nothing is left behind. Without a
    request id the reservation is counted every time.

    `global_limit` (system_settings.max_messages_per_day_global) caps how many
    messages all public users together can send per UTC day. In the same
    transaction, after the request-id claim and the per-user increment, the
    day's row in global_daily_usage is incremented with an atomic
    INSERT ... ON CONFLICT DO UPDATE ... WHERE messages + 1 <= limit. If the
    budget is spent the whole transaction rolls back (claim and per-user
    count included) and usage["reason"] is GLOBAL_LIMIT_REASON. A retried
    request id is not counted again. None skips the global budget.

    Raises on DB errors (after rolling back) so the caller fails closed.

    Returns:
        (allowed: bool, usage: {used, limit, remaining, reset_at})
    """
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    usage_date = now_utc.date()
    reset_at = datetime.combine(usage_date + timedelta(days=1), time.min, tzinfo=timezone.utc).isoformat()

    def usage(used: int) -> dict:
        return {
            "used": used,
            "limit": limit,
            "remaining": max(0, limit - used),
            "reset_at": reset_at,
        }

    def current_used(cur) -> int:
        cur.execute(
            """
            SELECT characters_sent
            FROM user_daily_usage
            WHERE user_id = %s AND usage_date = %s
            """,
            (user_id, usage_date),
        )
        row = cur.fetchone()
        return (row[0] or 0) if row else 0

    try:
        with db_connection.cursor() as cur:
            # A single message bigger than the whole allowance can never fit;
            # reject it without writing a row.
            if char_count > limit:
                used = current_used(cur)
                db_connection.commit()
                return False, usage(used)

            if request_id:
                # Concurrent claims of the same id block on the primary key
                # until the first transaction commits or rolls back.
                cur.execute(
                    """
                    INSERT INTO daily_usage_requests (request_id, characters_reserved)
                    VALUES (%s, %s)
                    ON CONFLICT (request_id) DO NOTHING
                    RETURNING request_id
                    """,
                    (request_id, char_count),
                )
                if cur.fetchone() is None:
                    # Retry of a request that was already counted (rejected
                    # requests never keep a claim): allow without counting.
                    used = current_used(cur)
                    db_connection.commit()
                    return True, usage(used)

            cur.execute(
                """
                INSERT INTO user_daily_usage (user_id, usage_date, characters_sent, updated_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (user_id, usage_date) DO UPDATE
                   SET characters_sent = user_daily_usage.characters_sent + EXCLUDED.characters_sent,
                       updated_at = now()
                 WHERE user_daily_usage.characters_sent + EXCLUDED.characters_sent <= %s
                RETURNING characters_sent
                """,
                (user_id, usage_date, char_count, limit),
            )
            row = cur.fetchone()
            if not row:
                # The conflict update's WHERE failed: this message would exceed
                # the limit. Roll back so the request-id claim (if any) is
                # undone too.
                db_connection.rollback()
                used = current_used(cur)
                db_connection.commit()
                return False, usage(used)
            used = row[0]

            if global_limit is not None:
                # Last statement before commit, so the single hot row per day
                # is locked for as short a time as possible.
                cur.execute(
                    """
                    INSERT INTO global_daily_usage (usage_date, messages, updated_at)
                    VALUES (%s, 1, now())
                    ON CONFLICT (usage_date) DO UPDATE
                       SET messages = global_daily_usage.messages + 1,
                           updated_at = now()
                     WHERE global_daily_usage.messages + 1 <= %s
                    RETURNING messages
                    """,
                    (usage_date, global_limit),
                )
                if cur.fetchone() is None:
                    # Service-wide budget spent: undo the claim and the
                    # per-user count so nothing from this message is kept.
                    db_connection.rollback()
                    used = current_used(cur)
                    db_connection.commit()
                    return False, {**usage(used), "reason": GLOBAL_LIMIT_REASON}

            db_connection.commit()
            return True, usage(used)

    except Exception as e:
        db_connection.rollback()
        logger.error("Daily character reservation failed: %s", type(e).__name__)
        raise


def reserve_daily_message(user_id: str, db_connection, limit: int | None = None) -> tuple[bool, dict]:
    """
    Atomically counts one message against the user's rolling 24-hour allowance
    (users.messages_sent / messages_window_started_at).

    The check and the increment are one conditional UPDATE ... RETURNING: it
    succeeds only if the window has expired (the count restarts at 1 and the
    window at now()) or messages_sent is still below `limit`. Postgres re-checks
    the WHERE against the latest row version under concurrent updates, so
    parallel messages cannot overshoot the limit.

    Fails closed: a user without a users row is refused and nothing is written
    (users rows are created only by POST /user), and a DB error rolls back and
    refuses. Never logs the user id.

    Returns:
        (allowed: bool, usage: {messages_sent, limit, remaining, reset_at}),
        or (False, {"error": ...}) on a DB error.
    """
    if limit is None:
        limit = config.MAX_MESSAGES_PER_DAY
    now_utc = datetime.now(timezone.utc)

    def usage(messages_sent: int, window_start) -> dict:
        if window_start is None:
            window_start = now_utc
        if window_start.tzinfo is None:
            window_start = window_start.replace(tzinfo=timezone.utc)
        return {
            "messages_sent": messages_sent,
            "limit": limit,
            "remaining": max(0, limit - messages_sent),
            "reset_at": (window_start + timedelta(hours=24)).isoformat(),
        }

    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                UPDATE users
                   SET messages_sent = CASE
                         WHEN messages_window_started_at <= now() - interval '24 hours' THEN 1
                         ELSE COALESCE(messages_sent, 0) + 1
                       END,
                       messages_window_started_at = CASE
                         WHEN messages_window_started_at <= now() - interval '24 hours' THEN now()
                         ELSE messages_window_started_at
                       END
                 WHERE id = %s
                   AND (messages_window_started_at <= now() - interval '24 hours'
                        OR COALESCE(messages_sent, 0) < %s)
                RETURNING messages_sent, messages_window_started_at
                """,
                (user_id, limit),
            )
            row = cur.fetchone()
            if row:
                db_connection.commit()
                return True, usage(row[0] or 0, row[1])

            # Either the user is at the limit or has no users row at all.
            cur.execute(
                """
                SELECT COALESCE(messages_sent, 0), messages_window_started_at
                FROM users
                WHERE id = %s
                """,
                (user_id,),
            )
            row = cur.fetchone()
            db_connection.commit()
            if row:
                return False, usage(row[0] or 0, row[1])
            return False, {
                "messages_sent": limit,
                "limit": limit,
                "remaining": 0,
                "reset_at": (now_utc + timedelta(hours=24)).isoformat(),
            }

    except Exception as e:
        try:
            db_connection.rollback()
        except Exception:
            pass
        logger.error("Daily message reservation failed: %s", type(e).__name__)
        return False, {"error": "Unable to verify message limits from DB."}
