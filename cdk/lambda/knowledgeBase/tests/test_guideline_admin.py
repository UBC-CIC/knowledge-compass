"""
Unit tests for helpers/guideline_admin.py (guideline-mode admin API).
S3, Lambda and the DB are mocked. Run from knowledgeBase:

    python -m unittest discover -s tests -v
"""

import _setup  # noqa: F401  (must be first)
from _setup import TEST_INVOKE_TOKEN

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
                                {"file_name": "guide.pptx", "content_type": "application/octet-stream"})
        self.assertEqual(response["statusCode"], 400)
        self.s3.generate_presigned_url.assert_not_called()

    def test_rejects_wrong_content_type_for_pdf(self):
        response, _ = self.call(_event("POST", "/admin/guideline/upload-url"),
                                {"file_name": "guide.pdf", "content_type": "text/html"})
        self.assertEqual(response["statusCode"], 400)


class RegisterDocumentTest(AdminTestBase):
    def test_new_document_starts_worker(self):
        conn = FakeConnection({"INSERT INTO guideline_documents": [(DOC_ID,)]})
        response, conn = self.call(_event("POST", "/admin/guideline/documents"),
                                   {"s3_key": KEY, "file_name": "guide.md"}, conn)
        self.assertEqual(response["statusCode"], 202)
        insert = conn.sql_with("INSERT INTO guideline_documents")[0]
        self.assertEqual(insert[1][2], "admin@example.org")
        payload = json.loads(self.lam.invoke.call_args.kwargs["Payload"])
        self.assertEqual(payload, {"task": "process_guideline_document", "document_id": DOC_ID,
                                   "invoke_token": TEST_INVOKE_TOKEN})
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


class WordAndPdfTest(AdminTestBase):
    DOCX_KEY = "uploads/guideline/44444444-4444-4444-4444-444444444444.docx"
    PDF_KEY = "uploads/guideline/55555555-5555-5555-5555-555555555555.pdf"

    def test_upload_urls_keep_the_real_extension(self):
        cases = [
            ("Guide.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx",
             "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            ("Guide.pdf", "application/pdf", ".pdf", "application/pdf"),
            ("Guide.md", "", ".md", "text/markdown"),
        ]
        for name, client_type, extension, stored_type in cases:
            response, _ = self.call(_event("POST", "/admin/guideline/upload-url"),
                                    {"file_name": name, "content_type": client_type})
            self.assertEqual(response["statusCode"], 200, name)
            body = _body(response)
            self.assertTrue(body["key"].endswith(extension), name)
            self.assertEqual(body["contentType"], stored_type)

    def test_register_word_and_pdf(self):
        self.s3.head_object.return_value = {"ContentLength": 5 * 1024 * 1024}
        for key, name in ((self.DOCX_KEY, "Guide.docx"), (self.PDF_KEY, "Guide.pdf")):
            conn = FakeConnection({"INSERT INTO guideline_documents": [(DOC_ID,)]})
            response, _ = self.call(_event("POST", "/admin/guideline/documents"),
                                    {"s3_key": key, "file_name": name}, conn)
            self.assertEqual(response["statusCode"], 202, name)

    def test_markdown_still_capped_at_1mb(self):
        self.s3.head_object.return_value = {"ContentLength": 2 * 1024 * 1024}
        response, _ = self.call(_event("POST", "/admin/guideline/documents"),
                                {"s3_key": KEY, "file_name": "guide.md"})
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("1 MB", _body(response)["error"])

    def test_pdf_capped_at_10mb(self):
        self.s3.head_object.return_value = {"ContentLength": 10 * 1024 * 1024 + 1}
        response, _ = self.call(_event("POST", "/admin/guideline/documents"),
                                {"s3_key": self.PDF_KEY, "file_name": "guide.pdf"})
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("10 MB", _body(response)["error"])

    def test_name_must_match_stored_type(self):
        response, _ = self.call(_event("POST", "/admin/guideline/documents"),
                                {"s3_key": self.PDF_KEY, "file_name": "guide.md"})
        self.assertEqual(response["statusCode"], 400)
        self.lam.invoke.assert_not_called()

    def test_other_types_rejected(self):
        for name, ctype in (("guide.doc", "application/msword"), ("guide.txt", "text/plain"), ("guide.exe", "")):
            response, _ = self.call(_event("POST", "/admin/guideline/upload-url"),
                                    {"file_name": name, "content_type": ctype})
            self.assertEqual(response["statusCode"], 400, name)


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
        self.assertEqual(payload, {"task": "reembed_guideline_sections", "section_ids": [SECTION_ID],
                                   "invoke_token": TEST_INVOKE_TOKEN})

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
            "FROM guideline_documents": [(DOC_ID, "guide.md", "ready", None, 1, "a@x.org", "t", "t", None)],
            "FROM guideline_sections": [(SECTION_ID, DOC_ID, "A > B", "A > B", "Auto", "Override", "Sum")],
        })
        response, _ = self.call(_event("GET", "/admin/guideline"), conn=conn)
        body = _body(response)
        self.assertEqual(body["mode"], "guideline")
        self.assertEqual(body["documents"][0]["sections"][0]["label"], "Override")
        self.assertIsNone(body["documents"][0]["journey_id"])

    def test_register_attaches_a_journey(self):
        journey = "99999999-9999-9999-9999-999999999999"
        conn = FakeConnection({
            "FROM journeys WHERE id": [(1,)],
            "INSERT INTO guideline_documents": [(DOC_ID,)],
        })
        response, conn = self.call(
            _event("POST", "/admin/guideline/documents"),
            {"s3_key": KEY, "file_name": "guide.md", "journey_id": journey},
            conn,
        )
        self.assertEqual(response["statusCode"], 202)
        self.assertEqual(conn.sql_with("INSERT INTO guideline_documents")[0][1][3], journey)

    def test_unknown_journey_is_rejected(self):
        response, conn = self.call(
            _event("POST", "/admin/guideline/documents"),
            {"s3_key": KEY, "file_name": "guide.md", "journey_id": DOC_ID},
        )
        self.assertEqual(response["statusCode"], 404)
        self.lam.invoke.assert_not_called()
        self.assertFalse(conn.sql_with("INSERT INTO guideline_documents"))


if __name__ == "__main__":
    unittest.main()
