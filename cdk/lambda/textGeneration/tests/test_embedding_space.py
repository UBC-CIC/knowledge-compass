"""
Tests for helpers/embedding_space.py (the fail-loud embedding space checks),
crud.fetch_active_space, and the 503 `error` event in main.py. No AWS, no
database: cursors are scripted and time.monotonic is patched.
"""

import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import types
import unittest
from unittest import mock

_TG = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _TG)

from helpers import crud, embedding_space as es  # noqa: E402

SPACE_ID = "11111111-1111-4111-8111-111111111111"


def row(**overrides):
    base = {
        "id": SPACE_ID, "name": "cohere-v3-1024", "provider": "cohere_v3", "model_id": "cohere.embed-english-v3",
        "invoke_target": "cohere.embed-english-v3", "dimensions": 1024, "version": "1", "status": "active",
        "min_score": 0.4, "split_threshold": 0.6, "settings": {}, "cutover_locked": False,
    }
    base.update(overrides)
    return base


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))
        if self.conn.index_error:
            raise self.conn.index_error

    def fetchone(self):
        return (1,) if self.conn.index_present else None


class FakeConnection:
    def __init__(self, index_present=True, index_error=None):
        self.index_present = index_present
        self.index_error = index_error
        self.executed = []
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def rollback(self):
        self.rollbacks += 1


class EmbeddingSpaceTestCase(unittest.TestCase):
    """Fresh cache, scripted registry, scripted probe, controllable clock."""

    def setUp(self):
        es.reset_cache()
        self.addCleanup(es.reset_cache)
        self.clock = [1000.0]
        self.fetch = mock.Mock(side_effect=lambda conn, space_id=None: row())
        self.probe = mock.Mock(side_effect=lambda text, spec, region=None: [0.0] * spec.dimensions)
        for patcher in (
            mock.patch.object(es.time, "monotonic", lambda: self.clock[0]),
            mock.patch.object(es.crud, "fetch_active_space", self.fetch),
            mock.patch.object(es.embeddings, "embed_query", self.probe),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def failing_call(self, code, **kwargs):
        """Run get_active_space expecting `code`; return the EMF dicts printed and the ERROR log lines."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertLogs("helpers.embedding_space", level="ERROR") as logs:
            with self.assertRaises(es.EmbeddingSpaceError) as raised:
                es.get_active_space(kwargs.pop("conn", FakeConnection()), **kwargs)
        self.assertEqual(raised.exception.code, code)
        emf = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        return emf, logs.output


class HealthyPathTests(EmbeddingSpaceTestCase):
    def test_returns_the_space_and_probes_once(self):
        space = es.get_active_space(FakeConnection())
        self.assertEqual((space.name, space.dimensions, space.min_score), ("cohere-v3-1024", 1024, 0.4))
        self.assertEqual(self.probe.call_count, 1)
        self.assertEqual(self.probe.call_args.args[0], "health check")

    def test_cache_hit_within_60_seconds(self):
        conn = FakeConnection()
        es.get_active_space(conn)
        self.clock[0] += 59
        es.get_active_space(conn)
        self.assertEqual(self.fetch.call_count, 1)

    def test_refresh_after_60_seconds_rechecks_but_reuses_a_recent_probe(self):
        conn = FakeConnection()
        es.get_active_space(conn)
        self.clock[0] += 61
        es.get_active_space(conn)
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(self.probe.call_count, 1)  # same space/version, probed < 15 min ago
        self.assertEqual(sum("pg_indexes" in sql for sql, _ in conn.executed), 2)  # index re-checked

    def test_probe_repeats_after_15_minutes_or_a_version_change(self):
        conn = FakeConnection()
        es.get_active_space(conn)
        self.clock[0] += 15 * 60 + 1
        es.get_active_space(conn)
        self.assertEqual(self.probe.call_count, 2)
        self.clock[0] += 61
        self.fetch.side_effect = lambda c, space_id=None: row(version="2")
        es.get_active_space(conn)
        self.assertEqual(self.probe.call_count, 3)

    def test_force_bypasses_the_cache(self):
        conn = FakeConnection()
        es.get_active_space(conn)
        es.get_active_space(conn, force=True)
        self.assertEqual(self.fetch.call_count, 2)

    def test_pointer_flip_is_picked_up_on_refresh(self):
        conn = FakeConnection()
        self.assertEqual(es.get_active_space(conn).name, "cohere-v3-1024")
        self.fetch.side_effect = lambda c, space_id=None: row(
            id="22222222-2222-4222-8222-222222222222", name="titan-v2-512", provider="titan_v2",
            invoke_target="amazon.titan-embed-text-v2:0", dimensions=512,
        )
        self.clock[0] += 61
        self.assertEqual(es.get_active_space(conn).name, "titan-v2-512")

    def test_override_is_never_cached_and_allows_building_spaces(self):
        conn = FakeConnection()
        self.fetch.side_effect = lambda c, space_id=None: row(status="building")
        es.get_active_space(conn, space_id=SPACE_ID)
        es.get_active_space(conn, space_id=SPACE_ID)
        self.assertEqual(self.fetch.call_count, 2)
        self.assertEqual(self.fetch.call_args.args[1], SPACE_ID)
        # The pointer path was not cached by the overrides.
        self.fetch.side_effect = lambda c, space_id=None: row()
        es.get_active_space(conn)
        self.assertEqual(self.fetch.call_count, 3)

    def test_spec_applies_space_settings(self):
        space = es.ActiveSpace.from_row(row(provider="titan_v2", dimensions=512, settings={"max_chars": 500, "concurrency": 3}))
        self.assertEqual((space.spec.max_chars, space.spec.concurrency, space.spec.dimensions), (500, 3, 512))


class ConsistencyCheckTests(EmbeddingSpaceTestCase):
    """Every check logs ERROR (space name and code only) and emits an EMF metric line."""

    def assert_reported(self, code, emf, logs, space_name="cohere-v3-1024"):
        self.assertEqual(len(emf), 1, emf)
        directive = emf[0]["_aws"]["CloudWatchMetrics"][0]
        self.assertEqual(directive["Namespace"], "KnowledgeCompass/Embeddings")
        self.assertEqual(directive["Metrics"][0]["Name"], "EmbeddingSpaceCheckFailed")
        self.assertIn([], directive["Dimensions"])        # the alarm uses the un-dimensioned aggregate
        self.assertIn(["Code"], directive["Dimensions"])
        self.assertEqual(emf[0]["Code"], code)
        self.assertEqual(emf[0]["EmbeddingSpaceCheckFailed"], 1)
        self.assertEqual(len(logs), 1)
        self.assertIn(f"space={space_name}", logs[0])
        self.assertIn(f"code={code}", logs[0])

    def test_missing_pointer_row(self):
        self.fetch.side_effect = lambda c, space_id=None: None
        emf, logs = self.failing_call("NO_ACTIVE_SPACE")
        self.assert_reported("NO_ACTIVE_SPACE", emf, logs, space_name="-")
        self.probe.assert_not_called()

    def test_inactive_space_behind_the_pointer(self):
        for status in ("building", "validated", "retired", "purged"):
            es.reset_cache()
            self.fetch.side_effect = lambda c, space_id=None, s=status: row(status=s)
            emf, logs = self.failing_call("SPACE_NOT_ACTIVE")
            self.assert_reported("SPACE_NOT_ACTIVE", emf, logs)

    def test_unknown_provider(self):
        self.fetch.side_effect = lambda c, space_id=None: row(provider="mystery")
        emf, logs = self.failing_call("UNKNOWN_PROVIDER")
        self.assert_reported("UNKNOWN_PROVIDER", emf, logs)

    def test_dimension_the_adapter_does_not_allow(self):
        self.fetch.side_effect = lambda c, space_id=None: row(provider="titan_v2", dimensions=768)
        emf, logs = self.failing_call("DIMENSION_NOT_ALLOWED")
        self.assert_reported("DIMENSION_NOT_ALLOWED", emf, logs)

    def test_missing_partial_index(self):
        emf, logs = self.failing_call("INDEX_MISSING", conn=FakeConnection(index_present=False))
        self.assert_reported("INDEX_MISSING", emf, logs)
        self.probe.assert_not_called()

    def test_index_query_error_rolls_back_and_reports(self):
        conn = FakeConnection(index_error=RuntimeError("boom"))
        emf, logs = self.failing_call("INDEX_CHECK_FAILED", conn=conn)
        self.assert_reported("INDEX_CHECK_FAILED", emf, logs)
        self.assertEqual(conn.rollbacks, 1)

    def test_probe_returns_the_wrong_dimension(self):
        self.probe.side_effect = lambda text, spec, region=None: [0.0] * 512
        emf, logs = self.failing_call("PROBE_DIMENSION_MISMATCH")
        self.assert_reported("PROBE_DIMENSION_MISMATCH", emf, logs)

    def test_probe_call_fails(self):
        self.probe.side_effect = RuntimeError("AccessDeniedException")
        emf, logs = self.failing_call("PROBE_FAILED")
        self.assert_reported("PROBE_FAILED", emf, logs)

    def test_registry_unreadable_with_nothing_cached(self):
        self.fetch.side_effect = RuntimeError("db down")
        emf, logs = self.failing_call("REGISTRY_UNREADABLE")
        self.assert_reported("REGISTRY_UNREADABLE", emf, logs, space_name="-")

    def test_override_with_unusable_status_or_missing_space(self):
        self.fetch.side_effect = lambda c, space_id=None: row(status="retired")
        emf, logs = self.failing_call("SPACE_STATUS_INVALID", space_id=SPACE_ID)
        self.assert_reported("SPACE_STATUS_INVALID", emf, logs)
        self.fetch.side_effect = lambda c, space_id=None: None
        emf, logs = self.failing_call("SPACE_NOT_FOUND", space_id=SPACE_ID)
        self.assert_reported("SPACE_NOT_FOUND", emf, logs, space_name="-")

    def test_failures_never_serve_a_stale_space(self):
        conn = FakeConnection()
        es.get_active_space(conn)
        self.clock[0] += 61
        self.fetch.side_effect = lambda c, space_id=None: row(status="retired")
        with contextlib.redirect_stdout(io.StringIO()), self.assertLogs("helpers.embedding_space", level="ERROR"):
            with self.assertRaises(es.EmbeddingSpaceError):
                es.get_active_space(conn)

    def test_failure_is_remembered_for_15_seconds_without_re_reporting(self):
        self.fetch.side_effect = lambda c, space_id=None: row(provider="mystery")
        emf, _ = self.failing_call("UNKNOWN_PROVIDER")
        self.assertEqual(len(emf), 1)
        self.clock[0] += 10
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(es.EmbeddingSpaceError) as raised:
            es.get_active_space(FakeConnection())
        self.assertEqual(raised.exception.code, "UNKNOWN_PROVIDER")
        self.assertEqual(out.getvalue(), "")                  # no second metric
        self.assertEqual(self.fetch.call_count, 1)            # no registry re-read
        self.clock[0] += 6                                    # > 15 s: checked again, and fixed
        self.fetch.side_effect = lambda c, space_id=None: row()
        self.assertEqual(es.get_active_space(FakeConnection()).name, "cohere-v3-1024")

    def test_transient_registry_error_keeps_the_previous_good_space(self):
        conn = FakeConnection()
        es.get_active_space(conn)
        self.clock[0] += 61
        self.fetch.side_effect = RuntimeError("db blip")
        with self.assertLogs("helpers.embedding_space", level="WARNING"):
            self.assertEqual(es.get_active_space(conn).name, "cohere-v3-1024")


class IndexNameTests(unittest.TestCase):
    def test_python_rule_matches_the_migration(self):
        migration = os.path.join(_TG, "..", "db_setup", "migrations", "032_embedding_spaces.js")
        with open(migration, encoding="utf-8") as handle:
            sql = handle.read()
        self.assertIn("'idx_ce_hnsw_' || replace(p_space_id::text, '-', '')", sql)
        self.assertEqual(es.index_name(SPACE_ID), "idx_ce_hnsw_11111111111141118111111111111111")
        self.assertLessEqual(len(es.index_name(SPACE_ID)), 63)  # Postgres identifier limit


class FetchActiveSpaceTests(unittest.TestCase):
    class Cursor:
        def __init__(self, conn):
            self.conn = conn

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, sql, params=None):
            self.conn.executed.append((sql, params))
            if self.conn.error:
                raise self.conn.error

        def fetchone(self):
            return self.conn.row

    class Conn:
        def __init__(self, row=None, error=None):
            self.row, self.error, self.executed, self.rollbacks = row, error, [], 0

        def cursor(self):
            return FetchActiveSpaceTests.Cursor(self)

        def rollback(self):
            self.rollbacks += 1

    DB_ROW = (SPACE_ID, "cohere-v3-1024", "cohere_v3", "cohere.embed-english-v3", "cohere.embed-english-v3",
              1024, "1", "active", "0.400", "0.600", {"batch_size": 50}, False)

    def test_maps_the_pointer_row(self):
        conn = self.Conn(self.DB_ROW)
        result = crud.fetch_active_space(conn)
        self.assertEqual(result["id"], SPACE_ID)
        self.assertEqual((result["min_score"], result["split_threshold"]), (0.4, 0.6))
        self.assertEqual(result["settings"], {"batch_size": 50})
        self.assertFalse(result["cutover_locked"])
        sql = conn.executed[0][0]
        self.assertIn("FROM embedding_active_space a", sql)

    def test_override_reads_that_space_but_never_a_purged_one(self):
        conn = self.Conn(self.DB_ROW)
        crud.fetch_active_space(conn, SPACE_ID)
        sql, params = conn.executed[0]
        self.assertIn("s.status <> 'purged'", sql)
        self.assertEqual(params, (SPACE_ID,))

    def test_null_scores_and_json_settings_string(self):
        db_row = self.DB_ROW[:8] + (None, None, '{"max_chars": 100}', True)
        result = crud.fetch_active_space(self.Conn(db_row))
        self.assertEqual((result["min_score"], result["split_threshold"]), (None, None))
        self.assertEqual(result["settings"], {"max_chars": 100})
        self.assertTrue(result["cutover_locked"])

    def test_missing_row_returns_none(self):
        self.assertIsNone(crud.fetch_active_space(self.Conn(None)))

    def test_sql_errors_roll_back_and_are_raised_not_defaulted(self):
        conn = self.Conn(error=RuntimeError('relation "embedding_spaces" does not exist'))
        with self.assertRaises(RuntimeError):
            crud.fetch_active_space(conn)
        self.assertEqual(conn.rollbacks, 1)


class MainEmbeddingSpaceErrorTests(unittest.TestCase):
    """main.handler turns EmbeddingSpaceError into the existing `error` event."""

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
            spec = importlib.util.spec_from_file_location("textgen_main_under_test", os.path.join(_TG, "main.py"))
            cls.main = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.main)

    def _invoke(self, error):
        posted = []

        class WsClient:
            def post_to_connection(self, ConnectionId, Data):
                posted.append(json.loads(Data))

        # The acting user comes only from the verified token (requestContext.authorizer).
        event = {
            "requestContext": {"authorizer": {"userId": "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"}},
            "body": json.dumps({"query": "hello", "chat_session_id": "abc"}),
        }
        m = self.main
        with mock.patch.object(m, "_get_ws_client", return_value=(WsClient(), "conn-1")), \
                mock.patch.object(m, "get_db_connection", return_value=mock.Mock()), \
                mock.patch.object(m, "validate_session_ownership", return_value=True), \
                mock.patch.object(m, "sanitize_session_id", side_effect=lambda s: s), \
                mock.patch.object(m.config, "load_config"), \
                mock.patch.object(m, "claim_generation_slot", return_value=True), \
                mock.patch.object(m, "release_generation_slot"), \
                mock.patch.object(m, "reserve_daily_characters", return_value=(True, {})), \
                mock.patch.object(m, "get_response", side_effect=error):
            response = m.handler(event)
        return response, posted

    def test_embedding_space_error_returns_503_and_an_error_event(self):
        with self.assertLogs(level="ERROR") as logs:
            response, posted = self._invoke(es.EmbeddingSpaceError("INDEX_MISSING", "internal detail"))
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(json.loads(response["body"]), {"error": "EMBEDDING_SPACE_UNAVAILABLE"})
        self.assertEqual([p["type"] for p in posted], ["start", "error"])
        self.assertEqual(posted[1]["error"], "EMBEDDING_SPACE_UNAVAILABLE")
        self.assertEqual(posted[1]["message"], "The assistant is temporarily unavailable. Please try again shortly.")
        # No internal detail or code reaches the client; the log carries only the code.
        self.assertNotIn("internal detail", json.dumps(posted))
        self.assertNotIn("INDEX_MISSING", json.dumps(posted))
        joined = "\n".join(logs.output)
        self.assertIn("code=INDEX_MISSING", joined)
        self.assertNotIn("internal detail", joined)

    def test_other_errors_still_return_500(self):
        with self.assertLogs(level="ERROR"):
            response, posted = self._invoke(RuntimeError("boom"))
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(posted[-1]["type"], "error")


if __name__ == "__main__":
    unittest.main()
