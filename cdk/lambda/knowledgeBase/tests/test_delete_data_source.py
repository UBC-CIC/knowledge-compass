"""
Unit tests for helpers/delete_data_source.py: a website delete removes the
pages its crawls created inside the same locked transaction, and reports the
counts. The database and S3 are faked.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_delete_data_source.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import unittest
from unittest import mock

from _embedding_fakes import ScriptedConnection
from helpers import delete_data_source as dds

DS_ID = "11111111-1111-4111-8111-111111111111"
SEED = "https://example.org"

FETCH = "SELECT id, name, type, metadata FROM data_sources"


def body_of(response):
    return json.loads(response["body"])


def connection(row, owned=("p1", "p2"), shared=1, unowned=()):
    return ScriptedConnection({
        FETCH: [row] if row else [],
        "USING web_source_owners o": [(i,) for i in owned],
        "SELECT count(*) FROM web_source_owners": [(shared,)],
        "SELECT s.id, s.url FROM sources s": list(unowned),
        "SELECT name FROM data_sources": [],
        "WHERE s.id = ANY(%s::uuid[])": lambda params: [(i,) for i in params[0]],
    })


def website_row():
    return (DS_ID, SEED, "website", {})


def document_row():
    return (DS_ID, "doc.pdf", "document", {"s3_bucket": "bucket", "s3_key": "docs/doc.pdf"})


class DeleteDataSourceTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(dds, "delete_s3_objects", return_value=[])
        self.delete_s3 = patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, conn):
        return dds.delete_data_source({"headers": {}}, {}, conn, DS_ID)

    def test_website_delete_locks_then_deletes_pages_then_the_data_source_in_one_commit(self):
        conn = connection(website_row(), unowned=[("legacy", "https://example.org/old")])
        response = self.call(conn)

        self.assertEqual(response["statusCode"], 200)
        body = body_of(response)
        self.assertEqual(body["message"], "Data source deleted.")
        self.assertEqual(body["action"], "deleted")
        self.assertEqual(body["data_source_id"], DS_ID)
        self.assertEqual(body["deleted_data_source_ids"], [DS_ID])
        self.assertEqual(body["warnings"], [])
        self.assertEqual(body["deleted_page_count"], 3)
        self.assertEqual(body["retained_shared_page_count"], 1)
        self.assertEqual((conn.commits, conn.rollbacks), (1, 0))

        statements = [sql for sql, _ in conn.executed]

        def first(fragment):
            return next(i for i, sql in enumerate(statements) if fragment in sql)

        self.assertIn("FOR UPDATE", statements[first(FETCH)])
        order = [first(FETCH), first("USING web_source_owners o"), first("WHERE s.id = ANY(%s::uuid[])"),
                 first("DELETE FROM ingestion_runs"), first("DELETE FROM data_sources")]
        self.assertEqual(order, sorted(order))

    def test_old_seed_only_delete_is_gone(self):
        conn = connection(website_row())
        self.call(conn)
        self.assertEqual([s for s, _ in conn.executed if "url = %s" in s], [])

    def test_page_deletion_failure_rolls_back_and_reports_500(self):
        conn = connection(website_row())
        conn.fail_next("USING web_source_owners o", RuntimeError("db error"))
        response = self.call(conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(body_of(response), {"error": "Failed to delete data source"})
        self.assertEqual((conn.commits, conn.rollbacks), (0, 1))
        self.assertFalse(any("DELETE FROM data_sources" in s for s, _ in conn.executed))
        self.delete_s3.assert_not_called()

    def test_not_found_is_404(self):
        conn = connection(None)
        response = self.call(conn)
        self.assertEqual(response["statusCode"], 404)
        self.assertEqual(conn.commits, 0)

    def test_document_delete_does_not_touch_website_pages_and_reports_zero_counts(self):
        conn = connection(document_row())
        with mock.patch.object(dds, "delete_website_pages") as pages:
            response = self.call(conn)
        pages.assert_not_called()
        body = body_of(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual((body["deleted_page_count"], body["retained_shared_page_count"]), (0, 0))
        self.delete_s3.assert_called_once_with([("bucket", "docs/doc.pdf")])


if __name__ == "__main__":
    unittest.main()
