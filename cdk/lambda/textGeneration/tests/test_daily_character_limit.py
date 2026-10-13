"""
Tests for helpers/message_limits.reserve_daily_characters: the per-user daily
character allowance (UTC calendar day, table user_daily_usage, migration 034).
The DB is an in-memory fake that emulates the helper's two statements.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers.message_limits import reserve_daily_characters  # noqa: E402

USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c"
NOON = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
DAY = date(2026, 3, 1)


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._row = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        if self.conn.raise_on_execute:
            raise RuntimeError("db down")
        store = self.conn.store
        if "INTO daily_usage_requests" in sql:
            request_id, count = params
            if request_id in self.conn.requests:
                self._row = None
            else:
                self.conn.requests[request_id] = count
                self._row = (request_id,)
        elif sql.lstrip().startswith("INSERT"):
            user_id, usage_date, count, limit = params
            key = (user_id, usage_date)
            if key not in store:
                store[key] = count
                self._row = (count,)
            elif store[key] + count <= limit:
                store[key] += count
                self._row = (store[key],)
            else:
                self._row = None
        elif sql.lstrip().startswith("SELECT"):
            key = tuple(params)
            self._row = (store[key],) if key in store else None
        else:
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._row


class FakeConnection:
    """Working state (`store`, `requests`) plus a committed snapshot, so
    rollback() undoes uncommitted writes like a real transaction."""

    def __init__(self, store=None, raise_on_execute=False):
        self.store = dict(store or {})
        self.requests = {}
        self._committed = (dict(self.store), {})
        self.raise_on_execute = raise_on_execute
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1
        self._committed = (dict(self.store), dict(self.requests))

    def rollback(self):
        self.rollbacks += 1
        self.store, self.requests = dict(self._committed[0]), dict(self._committed[1])


class ReserveDailyCharactersTests(unittest.TestCase):
    def test_under_limit_allowed(self):
        conn = FakeConnection()
        allowed, usage = reserve_daily_characters(USER, 2000, conn, 10000, now=NOON)
        self.assertTrue(allowed)
        self.assertEqual(usage["used"], 2000)
        self.assertEqual(usage["remaining"], 8000)
        self.assertEqual(usage["limit"], 10000)
        self.assertEqual(conn.store[(USER, DAY)], 2000)
        self.assertGreaterEqual(conn.commits, 1)

    def test_exact_boundary_allowed(self):
        conn = FakeConnection({(USER, DAY): 9000})
        allowed, usage = reserve_daily_characters(USER, 1000, conn, 10000, now=NOON)
        self.assertTrue(allowed)
        self.assertEqual(usage["used"], 10000)
        self.assertEqual(usage["remaining"], 0)

    def test_over_limit_rejected_and_not_counted(self):
        conn = FakeConnection({(USER, DAY): 9500})
        allowed, usage = reserve_daily_characters(USER, 501, conn, 10000, now=NOON)
        self.assertFalse(allowed)
        self.assertEqual(conn.store[(USER, DAY)], 9500)
        self.assertEqual(usage["used"], 9500)
        self.assertEqual(usage["remaining"], 500)

    def test_single_message_larger_than_limit_rejected_without_write(self):
        conn = FakeConnection()
        allowed, usage = reserve_daily_characters(USER, 1001, conn, 1000, now=NOON)
        self.assertFalse(allowed)
        self.assertEqual(conn.store, {})
        self.assertEqual(usage["used"], 0)
        self.assertEqual(usage["remaining"], 1000)

    def test_new_utc_day_resets(self):
        conn = FakeConnection()
        late = datetime(2026, 3, 1, 23, 59, 59, tzinfo=timezone.utc)
        self.assertTrue(reserve_daily_characters(USER, 10000, conn, 10000, now=late)[0])
        self.assertFalse(reserve_daily_characters(USER, 1, conn, 10000, now=late)[0])

        midnight = datetime(2026, 3, 2, 0, 0, 0, tzinfo=timezone.utc)
        allowed, usage = reserve_daily_characters(USER, 1, conn, 10000, now=midnight)
        self.assertTrue(allowed)
        self.assertEqual(usage["used"], 1)
        self.assertEqual(usage["reset_at"], "2026-03-03T00:00:00+00:00")
        self.assertEqual(conn.store[(USER, DAY)], 10000)

    def test_reset_at_is_next_utc_midnight(self):
        _, usage = reserve_daily_characters(USER, 10, FakeConnection(), 10000, now=NOON)
        self.assertEqual(usage["reset_at"], "2026-03-02T00:00:00+00:00")

    def test_non_utc_now_uses_utc_date(self):
        conn = FakeConnection()
        eastern = datetime(2026, 3, 1, 20, 0, tzinfo=timezone(timedelta(hours=-5)))
        reserve_daily_characters(USER, 10, conn, 10000, now=eastern)
        self.assertEqual(list(conn.store), [(USER, date(2026, 3, 2))])

    def test_counter_increments_across_messages(self):
        conn = FakeConnection()
        for count in (1000, 2500, 500):
            self.assertTrue(reserve_daily_characters(USER, count, conn, 10000, now=NOON)[0])
        self.assertEqual(conn.store[(USER, DAY)], 4000)

        allowed, usage = reserve_daily_characters(OTHER_USER, 300, conn, 10000, now=NOON)
        self.assertTrue(allowed)
        self.assertEqual(usage["used"], 300)
        self.assertEqual(conn.store[(USER, DAY)], 4000)

    def test_retried_request_id_is_not_counted_twice(self):
        conn = FakeConnection()
        first = reserve_daily_characters(USER, 1500, conn, 10000, now=NOON, request_id="req-1")
        retry = reserve_daily_characters(USER, 1500, conn, 10000, now=NOON, request_id="req-1")
        self.assertTrue(first[0])
        self.assertTrue(retry[0])
        self.assertEqual(retry[1]["used"], 1500)
        self.assertEqual(conn.store[(USER, DAY)], 1500)
        # Only the request id and the count are kept.
        self.assertEqual(conn.requests, {"req-1": 1500})

    def test_distinct_request_ids_both_count(self):
        conn = FakeConnection()
        self.assertTrue(reserve_daily_characters(USER, 1500, conn, 10000, now=NOON, request_id="req-1")[0])
        allowed, usage = reserve_daily_characters(USER, 2000, conn, 10000, now=NOON, request_id="req-2")
        self.assertTrue(allowed)
        self.assertEqual(usage["used"], 3500)
        self.assertEqual(conn.store[(USER, DAY)], 3500)

    def test_rejected_request_leaves_no_claim(self):
        # An over-limit message rolls back its claim, so its retry is checked
        # again (and still rejected) instead of being waved through.
        conn = FakeConnection({(USER, DAY): 9500})
        self.assertFalse(reserve_daily_characters(USER, 501, conn, 10000, now=NOON, request_id="req-1")[0])
        self.assertEqual(conn.requests, {})
        self.assertEqual(conn.store[(USER, DAY)], 9500)
        self.assertFalse(reserve_daily_characters(USER, 501, conn, 10000, now=NOON, request_id="req-1")[0])
        self.assertEqual(conn.store[(USER, DAY)], 9500)

    def test_db_error_rolls_back_and_raises(self):
        conn = FakeConnection(raise_on_execute=True)
        with self.assertRaises(RuntimeError):
            reserve_daily_characters(USER, 10, conn, 10000, now=NOON)
        self.assertEqual(conn.rollbacks, 1)


if __name__ == "__main__":
    unittest.main()
