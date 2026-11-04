"""
Unit tests for helpers/retry_ingestion_run.py: retrying failed sources and
re-crawling completed websites.
Run from knowledgeBase:  python -m unittest discover -s tests -p "test_retry_ingestion_run.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import unittest
from unittest import mock

import _embedding_fakes as fakes
from helpers import retry_ingestion_run as retry

DS_ID = "44444444-4444-4444-8444-444444444444"
LATEST_RUN_ID = "55555555-5555-4555-8555-555555555555"
NEW_RUN_ID = "66666666-6666-4666-8666-666666666666"

EVENT = {
    "headers": {},
    "requestContext": {"authorizer": {"userId": "admin-sub", "email": "admin@example.org"}},
}

TYPE_SQL = "SELECT type FROM data_sources"
LATEST_SQL = "FROM ingestion_runs WHERE data_source_id"
INSERT_SQL = "INSERT INTO ingestion_runs"


def conn_for(source_type, latest_status):
    responses = {
        TYPE_SQL: [(source_type,)] if source_type else [],
        LATEST_SQL: [(LATEST_RUN_ID, latest_status)] if latest_status else [],
        INSERT_SQL: [(NEW_RUN_ID,)],
    }
    return fakes.ScriptedConnection(responses)


class RetryIngestionRunTest(unittest.TestCase):
    def setUp(self):
        patches = [
            mock.patch.object(retry, "reject_if_locked", return_value=None),
            mock.patch.object(retry, "get_or_create_admin_user_id", return_value="user-1"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def call(self, conn):
        response = retry.retry_ingestion_run(EVENT, {}, conn, DS_ID)
        return response["statusCode"], json.loads(response["body"])

    def inserted_metadata(self, conn):
        inserts = conn.sql_with(INSERT_SQL)
        self.assertEqual(len(inserts), 1)
        return json.loads(inserts[0][1][1])

    def test_completed_website_is_queued_for_recrawl(self):
        conn = conn_for("website", "completed")
        status, body = self.call(conn)
        self.assertEqual(status, 200)
        self.assertEqual(body["action"], "recrawl_queued")
        self.assertEqual(body["pending_ingestion_run_id"], NEW_RUN_ID)
        self.assertIn("re-crawl", body["message"])
        self.assertEqual(
            self.inserted_metadata(conn),
            {"action": "manual_recrawl", "retry_of_ingestion_run_id": LATEST_RUN_ID},
        )

    def test_failed_source_is_still_retried(self):
        for source_type in ("website", "document", "csv"):
            with self.subTest(source_type=source_type):
                conn = conn_for(source_type, "failed")
                status, body = self.call(conn)
                self.assertEqual(status, 200)
                self.assertEqual(body["action"], "retry_queued")
                self.assertEqual(self.inserted_metadata(conn)["action"], "manual_retry")

    def test_completed_non_website_is_refused(self):
        for source_type in ("document", "csv", "markdown", "video"):
            with self.subTest(source_type=source_type):
                conn = conn_for(source_type, "completed")
                status, body = self.call(conn)
                self.assertEqual(status, 409)
                self.assertEqual(body["current_status"], "completed")
                self.assertEqual(conn.sql_with(INSERT_SQL), [])

    def test_in_flight_website_is_refused(self):
        for latest_status in ("pending", "queued", "running", None):
            with self.subTest(latest_status=latest_status):
                conn = conn_for("website", latest_status)
                status, body = self.call(conn)
                self.assertEqual(status, 409)
                self.assertEqual(body["current_status"], latest_status)
                self.assertEqual(conn.sql_with(INSERT_SQL), [])

    def test_missing_data_source_is_404(self):
        conn = conn_for(None, None)
        status, _ = self.call(conn)
        self.assertEqual(status, 404)
        self.assertEqual(conn.sql_with(INSERT_SQL), [])


if __name__ == "__main__":
    unittest.main()
