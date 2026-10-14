"""
Unit tests for helpers/ingestion_lock.py and its use in the four ingestion entry points.
Run from knowledgeBase:  python -m unittest discover -s tests -p "test_ingestion_lock.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import sys
import types
import unittest
from datetime import datetime, timezone
from unittest import mock

import _embedding_fakes as fakes
from helpers import ingestion_lock as lock

# The entry points import process_document_batch (docx / lxml, not installed locally).
# Stub it only while they are imported, so other test modules still get the real one.
_missing = "helpers.process_document_batch" not in sys.modules
if _missing:
    _stub = types.ModuleType("helpers.process_document_batch")
    _stub.trigger_uploaded_document = mock.Mock()
    _stub.trigger_document_batch = mock.Mock()
    sys.modules["helpers.process_document_batch"] = _stub
try:
    from helpers import retry_ingestion_run as retry  # noqa: E402
    from helpers import stage_data_sources as stage  # noqa: E402
    from helpers import stage_data_sources_batch as batch  # noqa: E402
    from helpers import start_ingestion_job as start  # noqa: E402
finally:
    if _missing:
        sys.modules.pop("helpers.process_document_batch", None)

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
JOB_ID = "33333333-3333-4333-8333-333333333333"
LOCK_SQL = "FROM embedding_active_space"


def conn_with(row):
    """`row` = (cutover_locked, locked_at, job_id, expired) or None."""
    return fakes.ScriptedConnection({LOCK_SQL: [row] if row else []})


UNLOCKED = (False, None, None, False)
LOCKED = (True, NOW, JOB_ID, False)
EXPIRED = (True, NOW, JOB_ID, True)


class PgError(Exception):
    def __init__(self, pgcode):
        super().__init__("pg error")
        self.pgcode = pgcode


class LockStateTest(unittest.TestCase):
    def test_unlocked(self):
        self.assertFalse(lock.is_locked(conn_with(UNLOCKED)))

    def test_locked_inside_the_ttl(self):
        state = lock.lock_state(conn_with(LOCKED))
        self.assertTrue(state["locked"])
        self.assertEqual(state["job_id"], JOB_ID)

    def test_lock_older_than_the_ttl_counts_as_released_and_is_logged(self):
        with self.assertLogs(level="WARNING") as logs:
            state = lock.lock_state(conn_with(EXPIRED))
        self.assertFalse(state["locked"])
        self.assertTrue(state["expired"])
        self.assertIn("treated as released", "\n".join(logs.output))

    def test_the_ttl_is_applied_in_sql_with_the_shared_constant(self):
        conn = conn_with(UNLOCKED)
        lock.is_locked(conn)
        sql, params = conn.executed[0]
        self.assertIn("make_interval(secs => %s)", sql)
        self.assertEqual(params, (lock.LOCK_TTL_SECONDS,))
        self.assertEqual(lock.LOCK_TTL_SECONDS, 30 * 60)

    def test_missing_pointer_row_means_unlocked(self):
        self.assertFalse(lock.is_locked(conn_with(None)))

    def test_missing_table_is_unlocked_and_logs_a_warning(self):
        conn = conn_with(UNLOCKED)
        conn.fail_next(LOCK_SQL, PgError("42P01"))
        with self.assertLogs(level="WARNING") as logs:
            self.assertFalse(lock.is_locked(conn))
        self.assertIn("treating ingestion as unlocked", "\n".join(logs.output))
        self.assertEqual(conn.rollbacks, 1)   # the aborted transaction is ended

    def test_other_database_errors_propagate(self):
        conn = conn_with(UNLOCKED)
        conn.fail_next(LOCK_SQL, PgError("08006"))
        with self.assertRaises(PgError):
            lock.is_locked(conn)

    def test_reject_response_shape(self):
        response = lock.reject_if_locked({"headers": {}}, conn_with(LOCKED))
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(json.loads(response["body"]), {"error": lock.LOCK_MESSAGE, "code": "CUTOVER_LOCKED"})
        self.assertEqual(
            lock.LOCK_MESSAGE,
            "A search-index cutover is in progress. Syncing is paused for a few minutes; please try again shortly.",
        )
        self.assertIn("Content-Type", response["headers"])
        self.assertIsNone(lock.reject_if_locked({"headers": {}}, conn_with(UNLOCKED)))


EVENT = {"headers": {}, "requestContext": {}}

ENTRY_POINTS = {
    # Each call, with an empty request, stops at its own 400 validation once the lock check passes.
    "start_ingestion_job": lambda conn: start.start_ingestion_job(EVENT, {}, conn),
    "stage_data_sources": lambda conn: stage.stage_data_sources(EVENT, {}, conn),
    "stage_data_sources_batch": lambda conn: batch.stage_data_sources_batch(EVENT, {}, conn),
    "retry_ingestion_run": lambda conn: retry.retry_ingestion_run(EVENT, {}, conn, "44444444-4444-4444-8444-444444444444"),
}


class EntryPointTest(unittest.TestCase):
    def test_all_four_return_409_while_locked(self):
        for name, call in ENTRY_POINTS.items():
            with self.subTest(entry_point=name):
                conn = conn_with(LOCKED)
                response = call(conn)
                self.assertEqual(response["statusCode"], 409)
                self.assertEqual(json.loads(response["body"])["code"], "CUTOVER_LOCKED")
                # Nothing else ran: the only statement was the lock check.
                self.assertEqual(len(conn.executed), 1)

    def test_all_four_proceed_when_unlocked(self):
        for name, call in ENTRY_POINTS.items():
            with self.subTest(entry_point=name):
                response = call(conn_with(UNLOCKED))
                self.assertEqual(response["statusCode"], 400)   # their own validation, not the lock

    def test_all_four_proceed_when_the_lock_has_expired(self):
        for name, call in ENTRY_POINTS.items():
            with self.subTest(entry_point=name):
                self.assertEqual(call(conn_with(EXPIRED))["statusCode"], 400)

    def test_all_four_proceed_when_the_table_is_missing(self):
        for name, call in ENTRY_POINTS.items():
            with self.subTest(entry_point=name):
                conn = conn_with(UNLOCKED)
                conn.fail_next(LOCK_SQL, PgError("42P01"))
                self.assertEqual(call(conn)["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()
