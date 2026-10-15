"""
Tests for the maintenance banner / read-only fallback (migration 034):
crud.fetch_service_status (its own 30 s cache, safe fallback) and the read-only
rejection in main.handler. No AWS, no database.
"""

import importlib
import importlib.util
import json
import os
import sys
import types
import unittest
from unittest import mock

_TG = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _TG)

from helpers import crud  # noqa: E402


class Cursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append(" ".join(sql.split()))
        if self.conn.error:
            raise self.conn.error

    def fetchone(self):
        return self.conn.row


class Conn:
    def __init__(self, row=("normal", None), error=None):
        self.row = row
        self.error = error
        self.executed = []
        self.rollbacks = 0

    def cursor(self):
        return Cursor(self)

    def rollback(self):
        self.rollbacks += 1


class FetchServiceStatusTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        patch = mock.patch.object(crud, "_service_status_clock", lambda: self.now)
        patch.start()
        self.addCleanup(patch.stop)
        crud._service_status_cache.update(value=None, at=0.0)
        self.addCleanup(lambda: crud._service_status_cache.update(value=None, at=0.0))

    def test_reads_status_and_message(self):
        conn = Conn(("banner", "Planned work tonight."))
        self.assertEqual(crud.fetch_service_status(conn), {"status": "banner", "message": "Planned work tonight."})
        self.assertIn("FROM system_settings", conn.executed[0])
        self.assertIn("service_status, service_message", conn.executed[0])

    def test_unknown_status_or_blank_message_is_normalised(self):
        self.assertEqual(crud.fetch_service_status(Conn(("weird", "x"))), {"status": "normal", "message": "x"})
        crud._service_status_cache.update(value=None, at=0.0)
        self.assertEqual(crud.fetch_service_status(Conn(("read_only", "   "))), {"status": "read_only", "message": None})

    def test_no_row_means_normal(self):
        self.assertEqual(crud.fetch_service_status(Conn(None)), {"status": "normal", "message": None})

    def test_result_is_cached_for_30_seconds_then_refreshed(self):
        conn = Conn(("read_only", "Paused"))
        crud.fetch_service_status(conn)
        conn.row = ("normal", None)

        self.now += crud.SERVICE_STATUS_TTL_SECONDS - 1
        self.assertEqual(crud.fetch_service_status(conn)["status"], "read_only")   # still cached
        self.assertEqual(len(conn.executed), 1)

        self.now += 1   # exactly at the TTL: expired
        self.assertEqual(crud.fetch_service_status(conn)["status"], "normal")
        self.assertEqual(len(conn.executed), 2)

    def test_ttl_is_its_own_short_cache_not_the_300_second_config_ttl(self):
        import helpers.config as config
        self.assertEqual(crud.SERVICE_STATUS_TTL_SECONDS, 30)
        self.assertLess(crud.SERVICE_STATUS_TTL_SECONDS, config.CONFIG_TTL_SECONDS)

    def test_callers_cannot_change_the_cached_value(self):
        conn = Conn(("banner", "Hello"))
        first = crud.fetch_service_status(conn)
        first["status"] = "read_only"
        self.assertEqual(crud.fetch_service_status(conn)["status"], "banner")

    def test_database_failure_falls_back_to_normal_rolls_back_and_warns(self):
        conn = Conn(error=RuntimeError('relation "system_settings" does not exist; password=hunter2'))
        with self.assertLogs(level="WARNING") as logs:
            result = crud.fetch_service_status(conn)
        self.assertEqual(result, {"status": "normal", "message": None})
        self.assertEqual(conn.rollbacks, 1)
        joined = "\n".join(logs.output)
        self.assertIn("RuntimeError", joined)
        self.assertNotIn("hunter2", joined)   # class name only

    def test_a_failed_read_is_not_cached_so_the_next_call_retries(self):
        conn = Conn(error=RuntimeError("down"))
        with self.assertLogs(level="WARNING"):
            crud.fetch_service_status(conn)
        conn.error = None
        conn.row = ("read_only", "Paused")
        self.assertEqual(crud.fetch_service_status(conn)["status"], "read_only")


class MainReadOnlyTests(unittest.TestCase):
    """main.handler refuses a new turn in read_only mode with the standard `error` event."""

    @classmethod
    def setUpClass(cls):
        stubs = {}
        for name in ("psycopg2", "aws_lambda_powertools", "aws_lambda_powertools.utilities"):
            try:
                importlib.import_module(name)
            except ImportError:
                stubs[name] = types.ModuleType(name)
        if "aws_lambda_powertools.utilities" in stubs:
            stubs["aws_lambda_powertools.utilities"].parameters = types.SimpleNamespace()
            stubs.setdefault("aws_lambda_powertools", types.ModuleType("aws_lambda_powertools"))
        with mock.patch.dict(sys.modules, stubs):
            spec = importlib.util.spec_from_file_location("textgen_main_service_status", os.path.join(_TG, "main.py"))
            cls.main = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.main)

    def _invoke(self, status, message=None, ownership=True):
        posted = []

        class WsClient:
            def post_to_connection(self, ConnectionId, Data):
                posted.append(json.loads(Data))

        # The acting user comes only from the verified token (requestContext.authorizer).
        event = {
            "requestContext": {"authorizer": {"userId": "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"}},
            "body": json.dumps({"query": "a private question", "chat_session_id": "abc"}),
        }
        m = self.main
        get_response = mock.Mock(return_value={"response": "ok", "sources_used": [], "sessionId": "abc"})
        load_config = mock.Mock()
        with mock.patch.object(m, "_get_ws_client", return_value=(WsClient(), "conn-1")), \
                mock.patch.object(m, "get_db_connection", return_value=mock.Mock()), \
                mock.patch.object(m, "validate_session_ownership", return_value=ownership), \
                mock.patch.object(m, "sanitize_session_id", side_effect=lambda s: s), \
                mock.patch.object(m, "fetch_service_status", return_value={"status": status, "message": message}), \
                mock.patch.object(m.config, "load_config", load_config), \
                mock.patch.object(m, "claim_generation_slot", return_value=True), \
                mock.patch.object(m, "release_generation_slot"), \
                mock.patch.object(m, "reserve_daily_characters", return_value=(True, {})), \
                mock.patch.object(m, "get_response", get_response):
            response = m.handler(event)
        return response, posted, get_response, load_config

    def test_read_only_rejects_a_turn_with_the_error_event_and_never_calls_get_response(self):
        response, posted, get_response, load_config = self._invoke("read_only", "We are back at 3 pm.")
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(json.loads(response["body"]), {"error": "SERVICE_READ_ONLY"})
        self.assertEqual([p["type"] for p in posted], ["error"])   # no `start`, no `chunk`
        self.assertEqual(posted[0]["error"], "SERVICE_READ_ONLY")
        self.assertEqual(posted[0]["message"], "We are back at 3 pm.")
        get_response.assert_not_called()
        load_config.assert_not_called()

    def test_read_only_without_a_message_uses_the_default_text(self):
        _, posted, get_response, _ = self._invoke("read_only", None)
        self.assertEqual(posted[0]["message"], "Chat is temporarily read-only. Please try again later.")
        get_response.assert_not_called()

    def test_the_query_text_is_never_echoed_back(self):
        response, posted, _, _ = self._invoke("read_only", "Paused")
        self.assertNotIn("a private question", json.dumps(posted) + response["body"])

    def test_normal_and_banner_pass_through(self):
        for status, message in (("normal", None), ("banner", "Planned work tonight.")):
            with self.subTest(status=status):
                response, posted, get_response, _ = self._invoke(status, message)
                self.assertEqual(response["statusCode"], 200)
                get_response.assert_called_once()
                self.assertEqual(posted[0]["type"], "start")
                self.assertEqual(posted[-1]["type"], "complete")

    def test_ownership_is_checked_before_the_status_is_revealed(self):
        response, posted, get_response, _ = self._invoke("read_only", "Paused", ownership=False)
        self.assertEqual(response["statusCode"], 403)
        self.assertEqual(posted[0]["error"], "Unauthorized access to chat session")
        get_response.assert_not_called()


if __name__ == "__main__":
    unittest.main()
