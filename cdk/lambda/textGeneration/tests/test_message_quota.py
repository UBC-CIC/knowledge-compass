"""
Tests for the daily message quota (finding f-175a7b55): the rolling 24-hour
message count is checked and incremented in one atomic statement, a caller
without a users row is refused (nothing is created), a made-up session is
refused, and the acting identity always comes from the token, never the body.

The DB is an in-memory fake that emulates the reservation SQL.

Run from the textGeneration dir:

    py -m unittest discover -s tests -v
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
from helpers import chat, crud, message_limits  # noqa: E402
from helpers.message_limits import reserve_daily_message  # noqa: E402

USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c"
SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"
LIMIT = 3
DAY = timedelta(hours=24)


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.row = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self.conn.executed.append((" ".join(sql.split()), params))
        if self.conn.error:
            raise self.conn.error
        users = self.conn.users
        now = self.conn.now
        text = " ".join(sql.split())
        if text.startswith("UPDATE users"):
            user_id, limit = params
            if user_id not in users:
                self.row = None
                return
            sent, started = users[user_id]
            expired = started <= now - DAY
            if not (expired or (sent or 0) < limit):
                self.row = None
                return
            users[user_id] = (1, now) if expired else ((sent or 0) + 1, started)
            self.row = users[user_id]
        elif text.startswith("SELECT"):
            (user_id,) = params
            self.row = users.get(user_id)
            if self.row:
                self.row = ((self.row[0] or 0), self.row[1])
        else:
            raise AssertionError(f"unexpected SQL: {text}")

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, users=None, now=None, error=None):
        self.users = dict(users or {})
        self.now = now or datetime.now(timezone.utc)
        self.error = error
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class ReserveDailyMessageTests(unittest.TestCase):
    def test_missing_users_row_is_refused_and_nothing_written(self):
        conn = FakeConnection()
        allowed, usage = reserve_daily_message(USER, conn, LIMIT)

        self.assertFalse(allowed)
        self.assertEqual(usage["remaining"], 0)
        self.assertEqual(usage["limit"], LIMIT)
        self.assertEqual(set(usage), {"messages_sent", "limit", "remaining", "reset_at"})
        self.assertEqual(conn.users, {})
        self.assertFalse(any(sql.upper().startswith("INSERT") for sql, _ in conn.executed))

    def test_fresh_window_counts_first_message(self):
        conn = FakeConnection(users={USER: (0, datetime.now(timezone.utc))})
        allowed, usage = reserve_daily_message(USER, conn, LIMIT)

        self.assertTrue(allowed)
        self.assertEqual(conn.users[USER][0], 1)
        self.assertEqual(usage["messages_sent"], 1)
        self.assertEqual(usage["remaining"], LIMIT - 1)
        self.assertEqual(conn.commits, 1)

    def test_at_limit_is_refused_without_incrementing(self):
        started = datetime.now(timezone.utc) - timedelta(hours=1)
        conn = FakeConnection(users={USER: (LIMIT, started)})
        allowed, usage = reserve_daily_message(USER, conn, LIMIT)

        self.assertFalse(allowed)
        self.assertEqual(conn.users[USER][0], LIMIT)
        self.assertEqual(usage["messages_sent"], LIMIT)
        self.assertEqual(usage["remaining"], 0)
        self.assertEqual(usage["reset_at"], (started + DAY).isoformat())

    def test_last_message_allowed_then_refused_no_overshoot(self):
        conn = FakeConnection(users={USER: (LIMIT - 1, datetime.now(timezone.utc))})

        self.assertTrue(reserve_daily_message(USER, conn, LIMIT)[0])
        results = [reserve_daily_message(USER, conn, LIMIT)[0] for _ in range(5)]

        self.assertEqual(results, [False] * 5)
        self.assertEqual(conn.users[USER][0], LIMIT)

    def test_expired_window_restarts_at_one(self):
        now = datetime.now(timezone.utc)
        for started in (now - DAY - timedelta(seconds=1), now - DAY):
            with self.subTest(started=started):
                conn = FakeConnection(users={USER: (LIMIT, started)}, now=now)
                allowed, usage = reserve_daily_message(USER, conn, LIMIT)

                self.assertTrue(allowed)
                self.assertEqual(conn.users[USER], (1, now))
                self.assertEqual(usage["messages_sent"], 1)
                self.assertEqual(usage["reset_at"], (now + DAY).isoformat())

    def test_db_error_refuses_and_rolls_back(self):
        conn = FakeConnection(error=RuntimeError(f"boom {USER}"))
        allowed, usage = reserve_daily_message(USER, conn, LIMIT)

        self.assertFalse(allowed)
        self.assertEqual(usage, {"error": "Unable to verify message limits from DB."})
        self.assertEqual(conn.rollbacks, 1)

    def test_single_conditional_update_statement(self):
        conn = FakeConnection(users={USER: (0, datetime.now(timezone.utc))})
        reserve_daily_message(USER, conn, LIMIT)

        self.assertEqual(len(conn.executed), 1)
        sql, params = conn.executed[0]
        self.assertTrue(sql.startswith("UPDATE users"))
        self.assertIn("RETURNING messages_sent", sql)
        self.assertIn("COALESCE(messages_sent, 0) < %s", sql.split("WHERE", 1)[1])
        self.assertEqual(params, (USER, LIMIT))

    def test_limit_defaults_to_config(self):
        conn = FakeConnection(users={USER: (0, datetime.now(timezone.utc))})
        with mock.patch.object(message_limits.config, "MAX_MESSAGES_PER_DAY", 7):
            _, usage = reserve_daily_message(USER, conn)

        self.assertEqual(usage["limit"], 7)
        self.assertEqual(conn.executed[0][1], (USER, 7))

    def test_user_id_never_logged(self):
        with self.assertLogs(message_limits.logger, level="ERROR") as logs:
            reserve_daily_message(USER, FakeConnection(error=RuntimeError(f"boom {USER}")), LIMIT)
        self.assertNotIn(USER, "\n".join(logs.output))


class GetResponseQuotaTests(unittest.TestCase):
    def test_refused_quota_returns_existing_shape_and_skips_guardrail(self):
        usage = {"messages_sent": LIMIT, "limit": LIMIT, "remaining": 0, "reset_at": "x"}
        guardrail = mock.MagicMock()
        with mock.patch.object(chat, "reserve_daily_message", return_value=(False, usage)), \
                mock.patch.object(chat, "invoke_guardrail", guardrail):
            result = chat.get_response("hi", "r", "r", SESSION, USER, FakeConnection())

        self.assertTrue(result["message_limit_exceeded"])
        self.assertEqual(result["response"], "Daily message limit exceeded. Please try again tomorrow.")
        self.assertEqual(result["message_usage"], usage)
        guardrail.assert_not_called()


class ImplicitCreatorsRemovedTests(unittest.TestCase):
    def test_no_implicit_row_creators_or_split_quota(self):
        for name in ("ensure_user_exists", "ensure_session_exists"):
            self.assertFalse(hasattr(crud, name), name)
            self.assertFalse(hasattr(chat, name), name)
        for name in ("check_limit", "record_message_sent"):
            self.assertFalse(hasattr(message_limits, name), name)


class FakeWsClient:
    def __init__(self):
        self.payloads = []

    def post_to_connection(self, ConnectionId, Data):
        self.payloads.append(json.loads(Data))


class SessionRowCursor:
    """chat_sessions lookup that finds no row."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        pass

    def fetchone(self):
        return None


class MissingSessionConnection:
    def cursor(self):
        return SessionRowCursor()

    def commit(self):
        pass

    def rollback(self):
        pass


def make_event(body, authorizer_user=USER):
    authorizer = {"userId": authorizer_user} if authorizer_user is not None else {}
    return {
        "requestContext": {
            "connectionId": "conn-1", "domainName": "d", "stage": "s",
            "authorizer": authorizer,
        },
        "pathParameters": {"id": SESSION},
        "body": json.dumps(body),
    }


class HandlerIdentityTests(unittest.TestCase):
    def setUp(self):
        self.ws = FakeWsClient()
        self.conn = MissingSessionConnection()
        self.get_response = mock.MagicMock(return_value={"response": "hi", "sources_used": [], "sessionId": SESSION})
        self.reserve = mock.MagicMock(return_value=(True, {"used": 1, "limit": 10, "remaining": 9, "reset_at": "x"}))
        self.claim = mock.MagicMock(return_value=True)
        self.ownership = mock.MagicMock(return_value=True)
        patches = [
            mock.patch.object(main, "_get_ws_client", return_value=(self.ws, "conn-1")),
            mock.patch.object(main, "get_cors_headers", return_value={}),
            mock.patch.object(main, "get_db_connection", return_value=self.conn),
            mock.patch.object(main, "fetch_service_status", return_value={"status": "normal", "message": None}),
            mock.patch.object(main.config, "load_config"),
            mock.patch.object(main, "claim_generation_slot", self.claim),
            mock.patch.object(main, "release_generation_slot"),
            mock.patch.object(main, "reserve_daily_characters", self.reserve),
            mock.patch.object(main, "get_response", self.get_response),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def nothing_ran(self):
        self.get_response.assert_not_called()
        self.reserve.assert_not_called()
        self.claim.assert_not_called()

    def test_body_user_id_mismatch_is_403(self):
        with mock.patch.object(main, "validate_session_ownership", self.ownership):
            result = main.handler(make_event({"query": "hi", "user_id": OTHER_USER}))

        self.assertEqual(result["statusCode"], 403)
        self.ownership.assert_not_called()
        self.nothing_ran()
        self.assertEqual([p["type"] for p in self.ws.payloads], ["error"])

    def test_token_identity_is_the_acting_user(self):
        for body in ({"query": "hi"}, {"query": "hi", "user_id": USER}):
            with self.subTest(body=body):
                self.get_response.reset_mock()
                self.reserve.reset_mock()
                self.claim.reset_mock()
                with mock.patch.object(main, "validate_session_ownership", self.ownership):
                    result = main.handler(make_event(body))

                self.assertEqual(result["statusCode"], 200)
                self.assertEqual(self.get_response.call_args.kwargs["user_id"], USER)
                self.assertEqual(self.reserve.call_args.args[0], USER)
                self.assertEqual(self.claim.call_args.args[0], USER)

    def test_body_user_id_without_token_identity_is_401(self):
        with mock.patch.object(main, "validate_session_ownership", self.ownership):
            result = main.handler(make_event({"query": "hi", "user_id": USER}, authorizer_user=None))

        self.assertEqual(result["statusCode"], 401)
        self.ownership.assert_not_called()
        self.nothing_ran()

    def test_missing_session_is_refused_before_any_work(self):
        # Real validate_session_ownership against a DB with no such session.
        result = main.handler(make_event({"query": "hi"}))

        self.assertEqual(result["statusCode"], 403)
        self.assertEqual(json.loads(result["body"])["error"], "Unauthorized access to chat session")
        self.nothing_ran()
        self.assertEqual([p["type"] for p in self.ws.payloads], ["error"])


if __name__ == "__main__":
    unittest.main()
