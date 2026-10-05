"""
Unit tests for helpers/guideline_admin.py (guideline-mode admin API).
S3, Lambda and the DB are mocked. Run from knowledgeBase:

    python -m unittest discover -s tests -v
"""

import _setup  # noqa: F401  (must be first)

import json
import os
import sys
import types
import unittest
from unittest import mock

try:  # pragma: no cover - depends on the local interpreter
    import docx  # noqa: F401
except Exception:  # noqa: BLE001
    _docx = types.ModuleType("docx")
    _docx.Document = object
    sys.modules["docx"] = _docx

from helpers import guideline_admin as ga  # noqa: E402

DOC_ID = "11111111-1111-1111-1111-111111111111"
SECTION_ID = "22222222-2222-2222-2222-222222222222"
KEY = "uploads/guideline/33333333-3333-3333-3333-333333333333.md"


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._result = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))
        self._result = self.conn.respond(sql, params)

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


class FakeConnection:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def respond(self, sql, params):
        for fragment, rows in self.responses.items():
            if fragment in sql:
                return rows
        return []

    def sql_with(self, fragment):
        return [(sql, p) for sql, p in self.executed if fragment in sql]


def _event(method, path, resource=None, path_id=None, email="admin@example.org"):
    return {
        "httpMethod": method,
        "path": path,
        "resource": resource or path,
        "pathParameters": {"id": path_id} if path_id else None,
        "requestContext": {"authorizer": {"email": email}},
        "headers": {},
    }


def _body(response):
    return json.loads(response["body"])


class AdminTestBase(unittest.TestCase):
    def setUp(self):
        os.environ["KNOWLEDGE_BASE_BUCKET_NAME"] = "bucket"
        self.s3 = mock.Mock()
        self.s3.generate_presigned_url.return_value = "https://signed"
        self.s3.head_object.return_value = {"ContentLength": 500}
        self.lam = mock.Mock()
        patches = [
            mock.patch.object(ga, "_s3_client", return_value=self.s3),
            mock.patch.object(ga, "_lambda_client", return_value=self.lam),
            mock.patch.object(ga, "LAMBDA_FUNCTION_NAME", "kb-fn"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(os.environ.pop, "KNOWLEDGE_BASE_BUCKET_NAME", None)

    def call(self, event, body=None, conn=None):
        conn = conn or FakeConnection()
        return ga.handle_guideline_request(event, body or {}, conn), conn


class RoutingTest(unittest.TestCase):
    def test_matches_only_guideline_routes(self):
        self.assertTrue(ga.is_guideline_route(_event("GET", "/admin/guideline")))
        self.assertTrue(ga.is_guideline_route(_event("PATCH", f"/prod/admin/guideline/sections/{SECTION_ID}",
                                                     resource="/admin/guideline/sections/{id}")))
        self.assertFalse(ga.is_guideline_route(_event("GET", "/admin/data_sources")))
        self.assertFalse(ga.is_guideline_route(_event("POST", "/admin/guideline")))


class UploadUrlTest(AdminTestBase):
    def test_markdown_gets_server_generated_key(self):
        response, _ = self.call(_event("POST", "/admin/guideline/upload-url"),
                                {"file_name": "../My guide.md", "content_type": "text/markdown"})
        self.assertEqual(response["statusCode"], 200)
        body = _body(response)
        self.assertRegex(body["key"], r"^uploads/guideline/[0-9a-f-]{36}\.md$")
        params = self.s3.generate_presigned_url.call_args.kwargs["Params"]
        self.assertEqual(params["ContentType"], "text/markdown")

    def test_rejects_other_extensions(self):
        response, _ = self.call(_event("POST", "/admin/guideline/upload-url"),
                                {"file_name": "guide.pdf", "content_type": "application/pdf"})
        self.assertEqual(response["statusCode"], 400)
        self.s3.generate_presigned_url.assert_not_called()


class RegisterDocumentTest(AdminTestBase):
    def test_new_document_starts_worker(self):
        conn = FakeConnection({"INSERT INTO guideline_documents": [(DOC_ID,)]})
        response, conn = self.call(_event("POST", "/admin/guideline/documents"),
                                   {"s3_key": KEY, "file_name": "guide.md"}, conn)
        self.assertEqual(response["statusCode"], 202)
        insert = conn.sql_with("INSERT INTO guideline_documents")[0]
        self.assertEqual(insert[1][2], "admin@example.org")
        payload = json.loads(self.lam.invoke.call_args.kwargs["Payload"])
        self.assertEqual(payload, {"task": "process_guideline_document", "document_id": DOC_ID})
        self.assertEqual(self.lam.invoke.call_args.kwargs["InvocationType"], "Event")

    def test_rejects_keys_outside_prefix(self):
        for key in ("uploads/markdown/x.md", "uploads/guideline/../secret.md", ""):
            response, _ = self.call(_event("POST", "/admin/guideline/documents"),
                                    {"s3_key": key, "file_name": "guide.md"})
            self.assertEqual(response["statusCode"], 400, key)
        self.lam.invoke.assert_not_called()

    def test_rejects_large_file(self):
        self.s3.head_object.return_value = {"ContentLength": ga.MAX_FILE_BYTES + 1}
        response, _ = self.call(_event("POST", "/admin/guideline/documents"),
                                {"s3_key": KEY, "file_name": "guide.md"})
        self.assertEqual(response["statusCode"], 400)
        self.s3.delete_object.assert_called_once()

    def test_replace_reuses_row_and_removes_old_object(self):
        conn = FakeConnection({
            "SELECT s3_key FROM guideline_documents": [("uploads/guideline/old.md",)],
            "UPDATE guideline_documents": [(DOC_ID,)],
        })
        response, conn = self.call(_event("POST", "/admin/guideline/documents"),
                                   {"s3_key": KEY, "file_name": "guide.md", "replace_document_id": DOC_ID}, conn)
        self.assertEqual(response["statusCode"], 202)
        self.assertFalse(conn.sql_with("INSERT INTO guideline_documents"))
        self.s3.delete_object.assert_called_once_with(Bucket="bucket", Key="uploads/guideline/old.md")

    def test_body_email_is_ignored(self):
        conn = FakeConnection({"INSERT INTO guideline_documents": [(DOC_ID,)]})
        event = _event("POST", "/admin/guideline/documents", email=None)
        self.call(event, {"s3_key": KEY, "file_name": "guide.md", "created_by": "spoof@example.org"}, conn)
        self.assertIsNone(conn.sql_with("INSERT INTO guideline_documents")[0][1][2])


class DeleteDocumentTest(AdminTestBase):
    def test_deletes_source_and_document(self):
        conn = FakeConnection({"SELECT s3_key FROM guideline_documents": [(KEY,)]})
        response, conn = self.call(_event("DELETE", f"/admin/guideline/documents/{DOC_ID}",
                                          resource="/admin/guideline/documents/{id}", path_id=DOC_ID), conn=conn)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(conn.sql_with("DELETE FROM sources")[0][1], (f"guideline://doc/{DOC_ID}",))
        self.assertTrue(conn.sql_with("DELETE FROM guideline_documents"))
        self.s3.delete_object.assert_called_once_with(Bucket="bucket", Key=KEY)

    def test_invalid_id(self):
        response, _ = self.call(_event("DELETE", "/admin/guideline/documents/abc",
                                       resource="/admin/guideline/documents/{id}", path_id="abc"))
        self.assertEqual(response["statusCode"], 400)


class RenameSectionTest(AdminTestBase):
    def _event(self):
        return _event("PATCH", f"/admin/guideline/sections/{SECTION_ID}",
                      resource="/admin/guideline/sections/{id}", path_id=SECTION_ID)

    def test_rename_triggers_reembed(self):
        conn = FakeConnection({"UPDATE guideline_sections": [(SECTION_ID, "Auto")]})
        response, conn = self.call(self._event(), {"label": "  Sent   home early "}, conn)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(conn.sql_with("UPDATE guideline_sections")[0][1][0], "Sent home early")
        payload = json.loads(self.lam.invoke.call_args.kwargs["Payload"])
        self.assertEqual(payload, {"task": "reembed_guideline_sections", "section_ids": [SECTION_ID]})

    def test_empty_label_resets(self):
        conn = FakeConnection({"UPDATE guideline_sections": [(SECTION_ID, "Auto")]})
        response, conn = self.call(self._event(), {"label": ""}, conn)
        self.assertIsNone(conn.sql_with("UPDATE guideline_sections")[0][1][0])
        self.assertEqual(_body(response)["label"], "Auto")

    def test_label_too_long(self):
        response, _ = self.call(self._event(), {"label": "x" * (ga.MAX_LABEL_CHARS + 1)})
        self.assertEqual(response["statusCode"], 400)
        self.lam.invoke.assert_not_called()


class ModeTest(AdminTestBase):
    def test_valid_mode(self):
        response, conn = self.call(_event("PUT", "/admin/guideline/mode"), {"mode": "guideline"})
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(conn.sql_with("INSERT INTO guideline_config")[0][1], ("guideline", "admin@example.org"))
        self.assertEqual(conn.commits, 1)

    def test_invalid_mode(self):
        response, conn = self.call(_event("PUT", "/admin/guideline/mode"), {"mode": "other"})
        self.assertEqual(response["statusCode"], 400)
        self.assertFalse(conn.executed)


class StateTest(AdminTestBase):
    def test_groups_sections_under_documents(self):
        conn = FakeConnection({
            "FROM guideline_config": [("guideline", "a@x.org", "2026-01-01")],
            "FROM guideline_documents": [(DOC_ID, "guide.md", "ready", None, 1, "a@x.org", "t", "t")],
            "FROM guideline_sections": [(SECTION_ID, DOC_ID, "A > B", "A > B", "Auto", "Override", "Sum")],
        })
        response, _ = self.call(_event("GET", "/admin/guideline"), conn=conn)
        body = _body(response)
        self.assertEqual(body["mode"], "guideline")
        self.assertEqual(body["documents"][0]["sections"][0]["label"], "Override")


if __name__ == "__main__":
    unittest.main()
