"""
Uploaded sources share sources.url with crawled pages. Helpers that mutate a
row by url must also match source_type, and staging must refuse a video or
document link that is already a crawled page. The database is faked.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_upload_source_namespace.py" -v
"""

import json
import socket
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

# Vendored python-docx needs a linux lxml. This test only calls _upsert_source.
if "docx" not in sys.modules:
    _docx = types.ModuleType("docx")
    _docx.Document = object
    sys.modules["docx"] = _docx

from _embedding_fakes import ScriptedConnection
from helpers import upload_identity
from helpers.process_document_batch import _upsert_source

TYPE_PREDICATE = "source_type = ANY(ARRAY['document', 'video']::source_type[])"


def _sql(conn, fragment):
    return conn.sql_with(fragment)[0][0]


class UploadIdentityTypeGuardTests(unittest.TestCase):
    def test_delete_rename_and_citation_updates_match_upload_types_only(self):
        conn = ScriptedConnection(rowcounts={"UPDATE sources": 1, "DELETE FROM sources": 1})
        upload_identity.rename_source_url(conn, old_url="upload://document/a.pdf", new_url="upload://document/b.pdf")
        upload_identity.rename_source(conn, url="upload://document/b.pdf", name="Handbook")
        upload_identity.set_citation_url(conn, url="upload://document/b.pdf", citation_url="https://example.org/a.pdf")
        upload_identity.set_citation_url(conn, url="upload://document/b.pdf", citation_url=None)
        upload_identity.delete_unreferenced_source(conn, url="upload://document/a.pdf")

        for sql, _params in conn.executed:
            self.assertIn(TYPE_PREDICATE, sql)

    def test_rename_source_url_does_not_run_when_the_url_is_unchanged(self):
        conn = ScriptedConnection()
        upload_identity.rename_source_url(conn, old_url="https://example.org/page", new_url="https://example.org/page")
        self.assertEqual(conn.executed, [])


class DocumentUpsertTypeGuardTests(unittest.TestCase):
    def test_upsert_refuses_to_adopt_a_non_document_row(self):
        conn = ScriptedConnection({"INSERT INTO sources": []})
        with self.assertRaises(RuntimeError) as raised:
            _upsert_source(conn, url="https://example.org/page", name="Handbook")
        self.assertIn("non-document", str(raised.exception))
        sql = _sql(conn, "INSERT INTO sources")
        self.assertIn("WHERE sources.source_type = 'document'::source_type", sql)
        self.assertNotIn("source_type = EXCLUDED.source_type", sql)

    def test_upsert_returns_the_document_row_it_refreshed(self):
        conn = ScriptedConnection({"INSERT INTO sources": [("src-1",)]})
        self.assertEqual(
            _upsert_source(conn, url="upload://document/handbook.pdf", name="Handbook", metadata={"citation_url": "https://example.org/h.pdf"}),
            "src-1",
        )


class SourceTypeLookupTests(unittest.TestCase):
    def test_lookup_is_an_exact_url_match(self):
        from helpers import stage_data_sources as stage

        conn = ScriptedConnection({"SELECT source_type": [("web",)]})
        self.assertEqual(stage._source_type_at_url(conn, "https://example.org/page"), "web")
        sql, params = conn.executed[0]
        self.assertIn("WHERE url = %s", sql)
        self.assertEqual(params, ("https://example.org/page",))

    def test_lookup_returns_none_when_the_url_is_free(self):
        from helpers import stage_data_sources as stage

        self.assertIsNone(stage._source_type_at_url(ScriptedConnection(), "https://example.org/new"))
        self.assertIsNone(stage._source_type_at_url(ScriptedConnection(), ""))


class StagedLinkCollisionTests(unittest.TestCase):
    """The public-URL check resolves DNS; the collision itself is the fake row."""

    def setUp(self):
        from helpers import stage_data_sources as stage

        self.stage = stage
        for patcher in (
            mock.patch.object(stage, "get_cors_headers", return_value={}),
            mock.patch("socket.getaddrinfo", _public_dns),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_video_collision_query_uses_the_stored_url_string(self):
        conn = ScriptedConnection({"SELECT source_type": [("web",)]})
        with mock.patch.object(self.stage, "head_etag") as head, \
                mock.patch.object(self.stage, "start_transcription_job") as transcribe:
            response = self.stage._stage_video(
                {},
                {
                    "video_file_name": "talk.mp4",
                    "video_s3_bucket": "bucket",
                    "video_s3_key": "uploads/video/talk.mp4",
                    "video_url": "https://example.org/page",
                },
                conn, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(json.loads(response["body"])["existing_source_type"], "web")
        self.assertEqual(conn.executed[0][1], ("https://example.org/page",))
        head.assert_not_called()
        transcribe.assert_not_called()
        self.assertEqual(conn.commits, 0)


def _public_dns(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port or 0))]


if __name__ == "__main__":
    unittest.main()
