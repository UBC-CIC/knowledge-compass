"""
Tests for the public chat kill switch (helpers/kill_switch.py) and its use in
main.handler: a "false" parameter refuses the turn with the existing terminal
`error` event (WebSocket) / HTTP 429 (REST) before any DB or Bedrock work; the
value is cached for 60 s; an SSM error fails open. SSM, the DB and generation
are mocked.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import json
import logging
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# psycopg2 / aws_lambda_powertools are not installed locally; main only needs
# get_db_connection, which every test patches.
if "helpers.db_connection" not in sys.modules:
    _stub = types.ModuleType("helpers.db_connection")
    _stub.get_db_connection = lambda: None
    sys.modules["helpers.db_connection"] = _stub

import main  # noqa: E402
from helpers import kill_switch  # noqa: E402

PARAM = "/KCVerify-ApiStack/PublicChatEnabled"
USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"


class FakeSsm:
    def __init__(self, value="true", error=None):
        self.value = value
        self.error = error
        self.calls = []

    def get_parameter(self, Name):
        self.calls.append(Name)
        if self.error is not None:
            raise self.error
        return {"Parameter": {"Name": Name, "Value": self.value}}


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


class KillSwitchTestCase(unittest.TestCase):
    def setUp(self):
        self.ssm = FakeSsm()
        self.clock = FakeClock()
        patches = [
            mock.patch.dict(os.environ, {"PUBLIC_CHAT_ENABLED_PARAM": PARAM}),
            mock.patch.object(kill_switch, "_get_ssm_client", return_value=self.ssm),
            mock.patch.object(kill_switch, "_clock", self.clock),
            mock.patch.dict(kill_switch._cache, {"value": None, "at": 0.0}),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class IsPublicChatEnabledTests(KillSwitchTestCase):
    def test_true_is_enabled(self):
        self.assertTrue(kill_switch.is_public_chat_enabled())
        self.assertEqual(self.ssm.calls, [PARAM])

    def test_false_is_paused(self):
        for value in ("false", "FALSE", " False \n"):
            with self.subTest(value=value):
                kill_switch._cache.update({"value": None, "at": 0.0})
                self.ssm.value = value
                self.assertFalse(kill_switch.is_public_chat_enabled())

    def test_any_other_value_is_enabled(self):
        for value in ("", "0", "off", "paused", "no"):
            with self.subTest(value=value):
                kill_switch._cache.update({"value": None, "at": 0.0})
                self.ssm.value = value
                self.assertTrue(kill_switch.is_public_chat_enabled())

    def test_missing_env_var_is_enabled_without_ssm_call(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertTrue(kill_switch.is_public_chat_enabled())
        self.assertEqual(self.ssm.calls, [])

    def test_value_is_cached_for_60_seconds(self):
        self.ssm.value = "false"
        self.assertFalse(kill_switch.is_public_chat_enabled())

        # Flipped back in SSM, but the cached value holds within the TTL.
        self.ssm.value = "true"
        self.clock.now += 59
        self.assertFalse(kill_switch.is_public_chat_enabled())
        self.assertEqual(len(self.ssm.calls), 1)

        # After the TTL the new value is read.
        self.clock.now += 2
        self.assertTrue(kill_switch.is_public_chat_enabled())
        self.assertEqual(len(self.ssm.calls), 2)

    def test_ssm_error_fails_open_and_is_not_cached(self):
        self.ssm.error = RuntimeError("secret detail user@example.com")
        with self.assertLogs(level=logging.WARNING) as logs:
            self.assertTrue(kill_switch.is_public_chat_enabled())

        # Only the error class name is logged, never the message.
        output = "\n".join(logs.output)
        self.assertIn("RuntimeError", output)
        self.assertNotIn("secret detail", output)
        self.assertNotIn("user@example.com", output)

        # Not cached: once SSM recovers, the next call reads the real value.
        self.ssm.error = None
        self.ssm.value = "false"
        self.assertFalse(kill_switch.is_public_chat_enabled())
        self.assertEqual(len(self.ssm.calls), 2)

    def test_client_creation_error_fails_open(self):
        with mock.patch.object(kill_switch, "_get_ssm_client", side_effect=RuntimeError("no region")):
            with self.assertLogs(level=logging.WARNING):
                self.assertTrue(kill_switch.is_public_chat_enabled())


class FakeWsClient:
    def __init__(self):
        self.payloads = []

    def post_to_connection(self, ConnectionId, Data):
        self.payloads.append(json.loads(Data))


def make_event():
    return {
        "requestContext": {
            "connectionId": "conn-1", "domainName": "d", "stage": "s",
            "authorizer": {"userId": USER},
        },
        "pathParameters": {"id": SESSION},
        "body": json.dumps({"query": "hello there"}),
    }


class MainKillSwitchTests(KillSwitchTestCase):
    def setUp(self):
        super().setUp()
        self.ws = FakeWsClient()
        self.get_db_connection = mock.MagicMock(return_value=object())
        self.get_response = mock.MagicMock(return_value={"response": "hi", "sources_used": [], "sessionId": SESSION})
        patches = [
            mock.patch.object(main, "_get_ws_client", return_value=(self.ws, "conn-1")),
            mock.patch.object(main, "get_cors_headers", return_value={}),
            mock.patch.object(main, "get_db_connection", self.get_db_connection),
            mock.patch.object(main, "validate_session_ownership", return_value=True),
            mock.patch.object(main, "fetch_service_status", return_value={"status": "normal", "message": None}),
            mock.patch.object(main.config, "load_config"),
            mock.patch.object(main, "claim_generation_slot", return_value=True),
            mock.patch.object(main, "release_generation_slot"),
            mock.patch.object(main, "reserve_daily_characters", return_value=(True, {})),
            mock.patch.object(main, "get_response", self.get_response),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_paused_sends_error_before_any_db_or_bedrock_work(self):
        self.ssm.value = "false"
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 429)
        self.get_db_connection.assert_not_called()
        self.get_response.assert_not_called()

        self.assertEqual([p["type"] for p in self.ws.payloads], ["error"])
        payload = self.ws.payloads[0]
        self.assertEqual(payload["error"], "PUBLIC_CHAT_PAUSED")
        self.assertEqual(payload["message"], main.PUBLIC_CHAT_PAUSED_MESSAGE)

        body = json.loads(result["body"])
        self.assertEqual(body["error"], "PUBLIC_CHAT_PAUSED")
        self.assertEqual(body["message"], main.PUBLIC_CHAT_PAUSED_MESSAGE)

    def test_enabled_generates_normally(self):
        result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 200)
        self.get_response.assert_called_once()
        sent = [p["type"] for p in self.ws.payloads]
        self.assertEqual(sent, ["start", "complete"])

    def test_ssm_error_does_not_take_chat_down(self):
        self.ssm.error = RuntimeError("ssm down")
        with self.assertLogs(level=logging.WARNING):
            result = main.handler(make_event())

        self.assertEqual(result["statusCode"], 200)
        self.get_response.assert_called_once()


if __name__ == "__main__":
    unittest.main()
