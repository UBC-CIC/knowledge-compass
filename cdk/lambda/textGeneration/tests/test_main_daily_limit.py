"""
Tests for the daily character limit in main.handler: the allowance is
reserved after the session ownership check and before the `start` event and
any generation, and an over-limit message gets the existing terminal `error`
event (WebSocket) / HTTP 429 (REST). The service-wide daily message budget
(GLOBAL_DAILY_LIMIT_EXCEEDED) uses the same path. Generation and the DB are
mocked.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import json
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

# psycopg2 / aws_lambda_powertools are not installed locally; main only needs
# get_db_connection, which every test patches.
if "helpers.db_connection" not in sys.modules:
    _stub = types.ModuleType("helpers.db_connection")
    _stub.get_db_connection = lambda: None
    sys.modules["helpers.db_connection"] = _stub

import main  # noqa: E402

USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"
QUERY = "hello there"
USAGE = {"used": 9990, "limit": 10000, "remaining": 10, "reset_at": "2026-03-02T00:00:00+00:00"}
EXHAUSTED = {"used": 10000, "limit": 10000, "remaining": 0, "reset_at": "2026-03-02T00:00:00+00:00"}
PARTIAL = {"used": 9000, "limit": 10000, "remaining": 1000, "reset_at": "2026-03-02T00:00:00+00:00"}


class FakeWsClient:
    def __init__(self):
        self.payloads = []

    def post_to_connection(self, ConnectionId, Data):
        self.payloads.append(json.loads(Data))


def make_event(query=QUERY):
    return {
        "requestContext": {
            "connectionId": "conn-1", "domainName": "d", "stage": "s",
            "authorizer": {"userId": USER},
        },
        "pathParameters": {"id": SESSION},
        "body": json.dumps({"query": query}),
    }


class MainDailyLimitTests(unittest.TestCase):
    def setUp(self):
        self.ws = FakeWsClient()
        self.conn = object()
        self.reserve = mock.MagicMock(return_value=(True, USAGE))
        self.get_response = mock.MagicMock(return_value={"response": "hi", "sources_used": [], "sessionId": SESSION})
        self.ownership = mock.MagicMock(return_value=True)
        patches = [
            mock.patch.object(main, "_get_ws_client", return_value=(self.ws, "conn-1")),
            mock.patch.object(main, "get_cors_headers", return_value={}),
            mock.patch.object(main, "get_db_connection", return_value=self.conn),
            mock.patch.object(main, "validate_session_ownership", self.ownership),
            mock.patch.object(main.config, "load_config"),
            mock.patch.object(main, "claim_generation_slot", return_value=True),
            mock.patch.object(main, "release_generation_slot"),
            mock.patch.object(main, "reserve_daily_characters", self.reserve),
            mock.patch.object(main, "get_response", self.get_response),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def types_sent(self):
        return [p["type"] for p in self.ws.payloads]

    def test_over_limit_sends_error_and_skips_generation(self):
        self.reserve.return_value = (False, EXHAUSTED)
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 429)
        self.get_response.assert_not_called()
        self.assertEqual(self.types_sent(), ["error"])
        payload = self.ws.payloads[0]
        self.assertEqual(payload["error"], main.DAILY_LIMIT_ERROR)
        self.assertEqual(payload["message"], "You've reached today's message limit. Please come back tomorrow.")
        self.assertEqual(payload["character_usage"], EXHAUSTED)

        body = json.loads(result["body"])
        self.assertEqual(body["error"], main.DAILY_LIMIT_ERROR)
        self.assertEqual(body["message"], main.DAILY_LIMIT_MESSAGE)
        self.assertEqual(body["character_usage"], EXHAUSTED)

    def test_overshoot_with_allowance_left_asks_for_shorter_message(self):
        # 9,000 used + a message that doesn't fit: 1,000 characters remain, so
        # the user is told to shorten it, not that the day's allowance is gone.
        self.reserve.return_value = (False, PARTIAL)
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 429)
        self.get_response.assert_not_called()
        self.assertEqual(self.types_sent(), ["error"])
        payload = self.ws.payloads[0]
        expected = ("This message is longer than the 1,000 characters you have left today. "
                    "Please try a shorter message.")
        self.assertEqual(payload["error"], main.DAILY_LIMIT_ERROR)
        self.assertEqual(payload["message"], expected)
        self.assertEqual(payload["character_usage"], PARTIAL)

        body = json.loads(result["body"])
        self.assertEqual(body["error"], main.DAILY_LIMIT_ERROR)
        self.assertEqual(body["message"], expected)
        self.assertEqual(body["character_usage"], PARTIAL)

    def test_message_larger_than_whole_allowance_is_not_called_exhausted(self):
        # Daily limit set below the per-message limit: a fresh user (used 0)
        # gets the "shorter message" text, not "reached today's limit".
        self.reserve.return_value = (False, {"used": 0, "limit": 5, "remaining": 5,
                                             "reset_at": "2026-03-02T00:00:00+00:00"})
        main.handler(make_event())

        self.assertNotEqual(self.ws.payloads[0]["message"], main.DAILY_LIMIT_MESSAGE)
        self.assertIn("5 characters you have left today", self.ws.payloads[0]["message"])

    def test_under_limit_reserves_message_length_then_generates(self):
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 200)
        self.reserve.assert_called_once_with(USER, len(QUERY), self.conn, main.config.MAX_CHARACTERS_PER_DAY,
                                             request_id=None,
                                             global_limit=main.config.MAX_MESSAGES_PER_DAY_GLOBAL)
        self.get_response.assert_called_once()
        sent = self.types_sent()
        self.assertIn("start", sent)
        self.assertIn("complete", sent)
        self.assertLess(sent.index("start"), sent.index("complete"))

    def test_lambda_request_id_is_passed_for_idempotency(self):
        context = types.SimpleNamespace(aws_request_id="req-abc")
        main.handler(make_event(), context)

        self.assertEqual(self.reserve.call_args.kwargs["request_id"], "req-abc")

    def test_reservation_happens_after_ownership_check(self):
        self.ownership.return_value = False
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 403)
        self.reserve.assert_not_called()
        self.get_response.assert_not_called()

    def test_too_long_message_is_not_counted(self):
        result = main.handler(make_event("x" * (main.config.MAX_CHARACTERS_PER_USER_MESSAGE + 1)))

        self.assertEqual(result["statusCode"], 400)
        self.reserve.assert_not_called()

    def _with_loaded_cap(self, cap):
        """load_config applies `cap` the way a DB read would, before the check."""
        original = main.config.MAX_CHARACTERS_PER_USER_MESSAGE

        def load(_conn):
            main.config.MAX_CHARACTERS_PER_USER_MESSAGE = cap

        self.addCleanup(setattr, main.config, "MAX_CHARACTERS_PER_USER_MESSAGE", original)
        return mock.patch.object(main.config, "load_config", side_effect=load)

    def test_length_check_uses_the_cap_loaded_for_this_request(self):
        # Cold container: the module global is still the hard-coded 2000 until
        # load_config returns. A lower administrator cap must bind this request.
        main.config.MAX_CHARACTERS_PER_USER_MESSAGE = 2000
        with self._with_loaded_cap(100):
            result = main.handler(make_event("x" * 150))

        self.assertEqual(result["statusCode"], 400)
        self.assertIn("100", json.loads(result["body"])["error"])
        self.reserve.assert_not_called()
        self.get_response.assert_not_called()

    def test_raised_cap_accepts_a_message_over_the_hardcoded_default(self):
        main.config.MAX_CHARACTERS_PER_USER_MESSAGE = 2000
        query = "x" * 3000
        with self._with_loaded_cap(4000):
            result = main.handler(make_event(query))

        self.assertEqual(result["statusCode"], 200)
        self.get_response.assert_called_once()
        self.assertEqual(self.get_response.call_args.kwargs["query"], query)

    def test_global_budget_spent_sends_busy_error_and_skips_generation(self):
        self.reserve.return_value = (False, {**USAGE, "reason": main.GLOBAL_LIMIT_REASON})
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 429)
        self.get_response.assert_not_called()
        self.assertEqual(self.types_sent(), ["error"])
        payload = self.ws.payloads[0]
        self.assertEqual(payload["error"], "GLOBAL_DAILY_LIMIT_EXCEEDED")
        self.assertEqual(payload["message"], "The assistant is very busy today. Please try again tomorrow.")
        # Per-user usage is not part of the service-wide error.
        self.assertNotIn("character_usage", payload)

        body = json.loads(result["body"])
        self.assertEqual(body["error"], "GLOBAL_DAILY_LIMIT_EXCEEDED")
        self.assertEqual(body["message"], main.GLOBAL_DAILY_LIMIT_MESSAGE)
        self.assertNotIn("character_usage", body)

    def test_global_budget_comes_from_settings(self):
        with mock.patch.object(main.config, "MAX_MESSAGES_PER_DAY_GLOBAL", 7):
            main.handler(make_event())

        self.assertEqual(self.reserve.call_args.kwargs["global_limit"], 7)

    def test_reservation_error_fails_closed(self):
        self.reserve.side_effect = RuntimeError("db down")
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 500)
        self.assertEqual(json.loads(result["body"])["error"], "Internal server error")
        self.get_response.assert_not_called()
        self.assertEqual(self.types_sent(), ["error"])


if __name__ == "__main__":
    unittest.main()
