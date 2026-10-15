"""
Tests for the one-in-flight-generation-per-user limit: the helpers
claim_generation_slot / release_generation_slot (table
user_inflight_generations, migration 037) against an in-memory fake that
emulates the helper's statements, and main.handler's use of them (claimed
after the session ownership check and before the daily reservation, released
on every exit path). Generation and the DB are mocked in the handler tests.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import json
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# psycopg2 / aws_lambda_powertools are not installed locally; main only needs
# get_db_connection, which every test patches.
if "helpers.db_connection" not in sys.modules:
    _stub = types.ModuleType("helpers.db_connection")
    _stub.get_db_connection = lambda: None
    sys.modules["helpers.db_connection"] = _stub

import main  # noqa: E402
from helpers.message_limits import claim_generation_slot, release_generation_slot  # noqa: E402

USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c"
SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"
STALE_WINDOW = timedelta(seconds=90)
T0 = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)


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
        conn.executed.append(sql)
        if conn.fail_executes > 0:
            conn.fail_executes -= 1
            raise RuntimeError("db error")
        if "INSERT INTO user_inflight_generations" in sql:
            user_id, request_id = params
            held = conn.slots.get(user_id)
            if (held is None
                    or held[1] < conn.now - STALE_WINDOW
                    or held[0] == request_id):
                conn.slots[user_id] = (request_id, conn.now)
                self._row = (request_id,)
            else:
                self._row = None
        elif "DELETE FROM user_inflight_generations" in sql:
            user_id, request_id = params
            held = conn.slots.get(user_id)
            if held and held[0] == request_id:
                del conn.slots[user_id]
            self._row = None
        else:
            raise AssertionError(f"unexpected SQL: {sql}")

    def fetchone(self):
        return self._row


class FakeConnection:
    """Working state plus a committed snapshot, so rollback() undoes
    uncommitted writes like a real transaction."""

    def __init__(self, slots=None, now=T0, fail_executes=0):
        self.slots = dict(slots or {})
        self.now = now
        self.fail_executes = fail_executes
        self.executed = []
        self.commits = 0
        self.rollbacks = 0
        self._committed = dict(self.slots)

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1
        self._committed = dict(self.slots)

    def rollback(self):
        self.rollbacks += 1
        self.slots = dict(self._committed)


class GenerationSlotHelperTests(unittest.TestCase):
    def test_first_claim_succeeds_and_is_committed(self):
        conn = FakeConnection()
        self.assertTrue(claim_generation_slot(USER, "req-1", conn))
        self.assertEqual(conn.slots[USER][0], "req-1")
        self.assertEqual(conn.commits, 1)

    def test_parallel_request_is_rejected_while_slot_is_held(self):
        conn = FakeConnection()
        self.assertTrue(claim_generation_slot(USER, "req-1", conn))
        conn.now = T0 + timedelta(seconds=30)
        self.assertFalse(claim_generation_slot(USER, "req-2", conn))
        self.assertEqual(conn.slots[USER], ("req-1", T0))

    def test_other_users_are_independent(self):
        conn = FakeConnection()
        self.assertTrue(claim_generation_slot(USER, "req-1", conn))
        self.assertTrue(claim_generation_slot(OTHER_USER, "req-2", conn))

    def test_same_request_id_can_reclaim_its_slot(self):
        # A retried invocation keeps its aws_request_id.
        conn = FakeConnection()
        self.assertTrue(claim_generation_slot(USER, "req-1", conn))
        self.assertTrue(claim_generation_slot(USER, "req-1", conn))

    def test_slot_within_stale_window_is_not_taken_over(self):
        conn = FakeConnection(slots={USER: ("req-old", T0)}, now=T0 + timedelta(seconds=89))
        self.assertFalse(claim_generation_slot(USER, "req-new", conn))

    def test_stale_slot_is_taken_over(self):
        # Older than 90 seconds (above the 60 second Lambda timeout): the
        # holder crashed or timed out without releasing.
        conn = FakeConnection(slots={USER: ("req-old", T0)}, now=T0 + timedelta(seconds=91))
        self.assertTrue(claim_generation_slot(USER, "req-new", conn))
        self.assertEqual(conn.slots[USER][0], "req-new")

    def test_claim_sql_is_one_atomic_upsert_with_90_second_window(self):
        conn = FakeConnection()
        claim_generation_slot(USER, "req-1", conn)
        sql = " ".join(conn.executed[0].split())
        self.assertIn("ON CONFLICT (user_id) DO UPDATE", sql)
        self.assertIn("started_at < now() - interval '90 seconds'", sql)
        self.assertIn("request_id = EXCLUDED.request_id", sql)
        self.assertIn("RETURNING", sql)
        self.assertEqual(len(conn.executed), 1)

    def test_claim_db_error_rolls_back_and_raises(self):
        conn = FakeConnection(fail_executes=1)
        with self.assertRaises(RuntimeError):
            claim_generation_slot(USER, "req-1", conn)
        self.assertEqual(conn.rollbacks, 1)
        self.assertEqual(conn.slots, {})

    def test_release_frees_the_slot_for_the_next_message(self):
        conn = FakeConnection()
        claim_generation_slot(USER, "req-1", conn)
        release_generation_slot(USER, "req-1", conn)
        self.assertEqual(conn.slots, {})
        self.assertTrue(claim_generation_slot(USER, "req-2", conn))

    def test_release_only_deletes_its_own_claim(self):
        # req-1 went stale and req-2 took over; req-1 finishing late must not
        # free req-2's slot.
        conn = FakeConnection(slots={USER: ("req-2", T0)})
        release_generation_slot(USER, "req-1", conn)
        self.assertEqual(conn.slots[USER][0], "req-2")

    def test_release_recovers_from_an_aborted_transaction(self):
        conn = FakeConnection(slots={USER: ("req-1", T0)}, fail_executes=1)
        release_generation_slot(USER, "req-1", conn)
        self.assertEqual(conn.slots, {})
        self.assertEqual(conn.rollbacks, 1)

    def test_release_never_raises(self):
        conn = FakeConnection(slots={USER: ("req-1", T0)}, fail_executes=5)
        with self.assertLogs(level="ERROR"):
            release_generation_slot(USER, "req-1", conn)


class FakeWsClient:
    def __init__(self):
        self.payloads = []

    def post_to_connection(self, ConnectionId, Data):
        self.payloads.append(json.loads(Data))


def make_event(query="hello there"):
    return {
        "requestContext": {
            "connectionId": "conn-1", "domainName": "d", "stage": "s",
            "authorizer": {"userId": USER},
        },
        "pathParameters": {"id": SESSION},
        "body": json.dumps({"query": query}),
    }


USAGE = {"used": 10, "limit": 10000, "remaining": 9990, "reset_at": "2026-03-02T00:00:00+00:00"}


class MainInflightLimitTests(unittest.TestCase):
    def setUp(self):
        self.ws = FakeWsClient()
        self.conn = object()
        self.calls = []
        self.claim = mock.MagicMock(return_value=True,
                                    side_effect=lambda *a: self.calls.append("claim") or True)
        self.release = mock.MagicMock(side_effect=lambda *a: self.calls.append("release"))
        self.reserve = mock.MagicMock(side_effect=lambda *a, **k: self.calls.append("reserve") or (True, USAGE))
        self.get_response = mock.MagicMock(return_value={"response": "hi", "sources_used": [], "sessionId": SESSION})
        self.ownership = mock.MagicMock(return_value=True)
        patches = [
            mock.patch.object(main, "_get_ws_client", return_value=(self.ws, "conn-1")),
            mock.patch.object(main, "get_cors_headers", return_value={}),
            mock.patch.object(main, "get_db_connection", return_value=self.conn),
            mock.patch.object(main, "validate_session_ownership", self.ownership),
            mock.patch.object(main, "fetch_service_status", return_value={"status": "normal", "message": None}),
            mock.patch.object(main.config, "load_config"),
            mock.patch.object(main, "claim_generation_slot", self.claim),
            mock.patch.object(main, "release_generation_slot", self.release),
            mock.patch.object(main, "reserve_daily_characters", self.reserve),
            mock.patch.object(main, "get_response", self.get_response),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def types_sent(self):
        return [p["type"] for p in self.ws.payloads]

    def test_parallel_message_gets_error_event_and_is_not_counted(self):
        self.claim.side_effect = None
        self.claim.return_value = False
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 429)
        self.reserve.assert_not_called()
        self.get_response.assert_not_called()
        self.release.assert_not_called()
        self.assertEqual(self.types_sent(), ["error"])
        payload = self.ws.payloads[0]
        self.assertEqual(payload["error"], "GENERATION_IN_PROGRESS")
        self.assertEqual(payload["message"], main.GENERATION_IN_PROGRESS_MESSAGE)

        body = json.loads(result["body"])
        self.assertEqual(body["error"], "GENERATION_IN_PROGRESS")
        self.assertEqual(body["message"], main.GENERATION_IN_PROGRESS_MESSAGE)

    def test_slot_is_claimed_before_reservation_and_released_after(self):
        context = types.SimpleNamespace(aws_request_id="req-abc")
        result = main.handler(make_event(), context)

        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(self.calls, ["claim", "reserve", "release"])
        self.claim.assert_called_once_with(USER, "req-abc", self.conn)
        self.release.assert_called_once_with(USER, "req-abc", self.conn)
        self.assertIn("complete", self.types_sent())

    def test_without_lambda_context_a_fresh_request_id_is_used(self):
        main.handler(make_event())
        main.handler(make_event())

        first, second = (c.args[1] for c in self.claim.call_args_list)
        self.assertTrue(first)
        self.assertNotEqual(first, second)
        # Each request releases the id it claimed.
        self.assertEqual([c.args[1] for c in self.release.call_args_list], [first, second])

    def test_slot_is_released_when_daily_limit_rejects(self):
        self.reserve.side_effect = None
        self.reserve.return_value = (False, {**USAGE, "remaining": 0})
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 429)
        self.release.assert_called_once()

    def test_slot_is_released_when_generation_fails(self):
        self.get_response.side_effect = RuntimeError("bedrock down")
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 500)
        self.release.assert_called_once()
        self.assertEqual(self.types_sent(), ["start", "error"])

    def test_no_claim_before_session_ownership_check_passes(self):
        self.ownership.return_value = False
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 403)
        self.claim.assert_not_called()
        self.release.assert_not_called()

    def test_claim_error_fails_closed(self):
        self.claim.side_effect = RuntimeError("db down")
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 500)
        self.reserve.assert_not_called()
        self.get_response.assert_not_called()
        self.release.assert_not_called()
        self.assertEqual(self.types_sent(), ["error"])


if __name__ == "__main__":
    unittest.main()
