"""
Tests for the service-wide daily message budget in
helpers/message_limits.reserve_daily_characters (global_limit, table
global_daily_usage, migration 036). The DB is an in-memory fake that emulates
the helper's statements with transaction rollback.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from datetime import date, datetime, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers.message_limits import GLOBAL_LIMIT_REASON, reserve_daily_characters  # noqa: E402

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
        conn = self.conn
        if "INTO daily_usage_requests" in sql:
            request_id, count = params
            if request_id in conn.requests:
                self._row = None
            else:
                conn.requests[request_id] = count
                self._row = (request_id,)
        elif "INTO global_daily_usage" in sql:
            usage_date, limit = params
            current = conn.global_usage.get(usage_date)
            if current is None:
                conn.global_usage[usage_date] = 1
                self._row = (1,)
            elif current + 1 <= limit:
                conn.global_usage[usage_date] = current + 1
                self._row = (current + 1,)
            else:
                self._row = None
        elif "INTO user_daily_usage" in sql:
            user_id, usage_date, count, limit = params
            key = (user_id, usage_date)
            if key not in conn.store:
                conn.store[key] = count
                self._row = (count,)
            elif conn.store[key] + count <= limit:
                conn.store[key] += count
                self._row = (conn.store[key],)
            else:
                self._row = None
        elif sql.lstrip().startswith("SELECT"):
            key = tuple(params)
            self._row = (conn.store[key],) if key in conn.store else None
        else:
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._row


class FakeConnection:
    """Working state plus a committed snapshot, so rollback() undoes
    uncommitted writes like a real transaction."""

    def __init__(self, store=None, global_usage=None):
        self.store = dict(store or {})
        self.requests = {}
        self.global_usage = dict(global_usage or {})
        self._snapshot()
        self.rollbacks = 0

    def _snapshot(self):
        self._committed = (dict(self.store), dict(self.requests), dict(self.global_usage))

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self._snapshot()

    def rollback(self):
        self.rollbacks += 1
        store, requests, global_usage = self._committed
        self.store, self.requests, self.global_usage = dict(store), dict(requests), dict(global_usage)


def reserve(conn, count=100, user=USER, request_id=None, global_limit=3, limit=10000, now=NOON):
    return reserve_daily_characters(user, count, conn, limit, now=now,
                                    request_id=request_id, global_limit=global_limit)


class GlobalDailyBudgetTests(unittest.TestCase):
    def test_counts_one_message_per_reservation_across_users(self):
        conn = FakeConnection()
        self.assertTrue(reserve(conn, user=USER)[0])
        self.assertTrue(reserve(conn, user=OTHER_USER)[0])
        self.assertEqual(conn.global_usage[DAY], 2)

    def test_exact_boundary_allowed_then_rejected_with_reason(self):
        conn = FakeConnection(global_usage={DAY: 2})
        allowed, usage = reserve(conn)
        self.assertTrue(allowed)
        self.assertNotIn("reason", usage)
        self.assertEqual(conn.global_usage[DAY], 3)

        allowed, usage = reserve(conn, user=OTHER_USER)
        self.assertFalse(allowed)
        self.assertEqual(usage["reason"], GLOBAL_LIMIT_REASON)
        self.assertEqual(conn.global_usage[DAY], 3)

    def test_rejection_rolls_back_user_count_and_request_claim(self):
        conn = FakeConnection(store={(USER, DAY): 500}, global_usage={DAY: 3})
        allowed, usage = reserve(conn, count=200, request_id="req-1")
        self.assertFalse(allowed)
        self.assertEqual(usage["reason"], GLOBAL_LIMIT_REASON)
        # Nothing from the rejected message is kept.
        self.assertEqual(conn.store[(USER, DAY)], 500)
        self.assertEqual(conn.requests, {})
        self.assertEqual(usage["used"], 500)
        self.assertGreaterEqual(conn.rollbacks, 1)

    def test_retried_request_id_is_not_counted_twice(self):
        conn = FakeConnection()
        self.assertTrue(reserve(conn, request_id="req-1")[0])
        self.assertTrue(reserve(conn, request_id="req-1")[0])
        self.assertEqual(conn.global_usage[DAY], 1)

    def test_retry_is_allowed_even_after_budget_is_spent(self):
        # The first attempt was counted; its retry must not be refused.
        conn = FakeConnection(global_usage={DAY: 2})
        self.assertTrue(reserve(conn, request_id="req-1")[0])
        self.assertEqual(conn.global_usage[DAY], 3)
        allowed, usage = reserve(conn, request_id="req-1")
        self.assertTrue(allowed)
        self.assertNotIn("reason", usage)
        self.assertEqual(conn.global_usage[DAY], 3)

    def test_user_limit_rejection_does_not_touch_global_budget(self):
        conn = FakeConnection(store={(USER, DAY): 9950})
        allowed, usage = reserve(conn, count=100)
        self.assertFalse(allowed)
        self.assertNotIn("reason", usage)
        self.assertEqual(conn.global_usage, {})

    def test_new_utc_day_has_a_fresh_budget(self):
        conn = FakeConnection(global_usage={DAY: 3})
        self.assertFalse(reserve(conn)[0])
        midnight = datetime(2026, 3, 2, 0, 0, tzinfo=timezone.utc)
        self.assertTrue(reserve(conn, now=midnight)[0])
        self.assertEqual(conn.global_usage[date(2026, 3, 2)], 1)

    def test_no_global_limit_skips_the_budget(self):
        conn = FakeConnection(global_usage={DAY: 3})
        self.assertTrue(reserve(conn, global_limit=None)[0])
        self.assertEqual(conn.global_usage[DAY], 3)


if __name__ == "__main__":
    unittest.main()
