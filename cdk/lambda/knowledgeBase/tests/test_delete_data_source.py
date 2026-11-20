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


def admin_event():
    return {
        "headers": {},
        "requestContext": {
            "requestId": "req-1",
            "authorizer": {"userId": "admin-sub", "email": "admin@example.org"},
        },
    }


def website_row():
    return (DS_ID, SEED, "website", {})


def document_row():
    return (DS_ID, "doc.pdf", "document", {"s3_bucket": "bucket", "s3_key": "docs/doc.pdf"})


class DeleteDataSourceTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(dds, "delete_s3_objects", return_value=[])
        self.delete_s3 = patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, conn, event=None):
        return dds.delete_data_source(event or admin_event(), {}, conn, DS_ID)

    # ── admin audit (finding f-0d57a9d0) ──

    def test_success_writes_one_audit_row_before_the_commit(self):
        conn = connection(document_row())
        commit_at = []
        conn.commit = lambda: commit_at.append(len(conn.executed))
        response = self.call(conn)
        self.assertEqual(response["statusCode"], 200)

        audits = [(i, p) for i, (sql, p) in enumerate(conn.executed) if "INSERT INTO admin_audit" in sql]
        self.assertEqual(len(audits), 1)
        index, params = audits[0]
        self.assertEqual(len(commit_at), 1)
        self.assertLess(index, commit_at[0], "audit insert is inside the committed transaction")
        sub, email, action, target, request_id = params
        self.assertEqual((sub, email, action, request_id),
                         ("admin-sub", "admin@example.org", "data_source.delete", "req-1"))
        target = json.loads(target)
        self.assertEqual(target["data_source_id"], DS_ID)
        self.assertEqual(target["type"], "document")
        self.assertEqual(target["deleted_data_source_ids"], [DS_ID])
        self.assertIn("source_urls", target)
        self.assertEqual(target["deleted_page_count"], 0)

    def test_success_log_line_names_the_actor_and_removed_ids(self):
        conn = connection(website_row())
        with self.assertLogs(level="INFO") as logs:
            self.call(conn)
        audit_lines = [json.loads(r.getMessage()) for r in logs.records
                       if r.getMessage().startswith('{"audit": "admin_action"')]
        self.assertEqual(len(audit_lines), 1)
        line = audit_lines[0]
        self.assertEqual(line["action"], "data_source.delete")
        self.assertEqual(line["actor_sub"], "admin-sub")
        self.assertEqual(line["actor_email"], "admin@example.org")
        self.assertEqual(line["request_id"], "req-1")
        self.assertEqual(line["target"]["deleted_data_source_ids"], [DS_ID])
        self.assertEqual(line["target"]["deleted_page_count"], 2)

    def test_missing_authorizer_identity_is_401_before_any_query(self):
        for event in ({"headers": {}}, {"requestContext": {"authorizer": {"email": "admin@example.org"}}},
                      {"body": json.dumps({"actor": {"sub": "forged"}}), "requestContext": {}}):
            conn = connection(document_row())
            response = self.call(conn, event)
            self.assertEqual(response["statusCode"], 401)
            self.assertEqual(body_of(response), {"error": "Unauthorized"})
            self.assertEqual(conn.executed, [])
            self.assertEqual((conn.commits, conn.rollbacks), (0, 0))
        self.delete_s3.assert_not_called()

    def test_audit_insert_failure_rolls_back_and_reports_500(self):
        conn = connection(document_row())
        conn.fail_next("INSERT INTO admin_audit", RuntimeError("audit write failed"))
        response = self.call(conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual((conn.commits, conn.rollbacks), (0, 1))
        self.delete_s3.assert_not_called()

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
