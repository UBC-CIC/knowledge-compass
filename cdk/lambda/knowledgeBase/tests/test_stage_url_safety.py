"""
SSRF guard on staged URLs: a website name is the crawl seed the in-VPC crawler
opens, so it must be a public http(s) URL; video/document links are published
as citations and get the same check. DNS is faked; no network is used.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_stage_url_safety.py" -v
"""

import json
import socket
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

# Staging only needs trigger_uploaded_document from process_document_batch;
# stub it so these tests don't need docx/lxml installed locally.
if "helpers.process_document_batch" not in sys.modules:
    _stub = types.ModuleType("helpers.process_document_batch")
    _stub.trigger_uploaded_document = mock.Mock()
    sys.modules["helpers.process_document_batch"] = _stub

from helpers import stage_data_sources as stage  # noqa: E402

DNS = {
    "example.org": ["93.184.216.34"],
    "www.youtube.com": ["142.250.80.46"],
    "internal.example.org": ["10.0.0.5"],
}


def fake_getaddrinfo(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    if host not in DNS:
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]]


class _Base(unittest.TestCase):
    def setUp(self):
        for patcher in (
            mock.patch.object(stage, "get_cors_headers", return_value={}),
            mock.patch("socket.getaddrinfo", fake_getaddrinfo),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.connection = mock.MagicMock()


class StageWebsiteUrlSafetyTests(_Base):
    def stage(self, name):
        return stage._stage_website(
            {}, {"type": "website", "name": name}, self.connection,
            created_by="admin@example.org", created_by_user_id="u1",
        )

    def test_unsafe_seeds_are_rejected_before_db_access(self):
        for name in (
            "file:///etc/passwd",
            "http://169.254.170.2/v2/credentials",
            "http://127.0.0.1/",
            "http://10.0.0.8/",
            "http://user:pass@example.org/",
            "ftp://example.org/",
            "javascript:alert(1)",
            "https://internal.example.org/",
            "https://unknown.invalid/",
            123,
        ):
            with self.subTest(name=name):
                self.connection.reset_mock()
                response = self.stage(name)
                self.assertEqual(response["statusCode"], 400)
                error = json.loads(response["body"])["error"]
                self.assertTrue(error)
                self.assertNotIn("10.0.0.5", error)
                self.connection.cursor.assert_not_called()
                self.connection.commit.assert_not_called()

    def test_blocked_hostname_does_not_echo_resolved_address(self):
        response = self.stage("https://internal.example.org/")
        error = json.loads(response["body"])["error"]
        self.assertIn("private, loopback, link-local or reserved", error)
        self.assertNotIn("10.0.0.5", error)

    def test_public_seed_is_stored_normalized(self):
        with mock.patch.object(stage, "_existing_website_row_id", return_value=None) as existing, \
                mock.patch.object(stage, "_insert_data_source_row", return_value="ds-1") as insert_ds, \
                mock.patch.object(stage, "_insert_ingestion_run_row", return_value="run-1"):
            response = self.stage("  HTTPS://Example.org  ")
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(insert_ds.call_args.kwargs["name"], "https://example.org/")
        self.assertEqual(
            existing.call_args.kwargs["names"], ["https://example.org/", "HTTPS://Example.org"]
        )
        self.connection.commit.assert_called_once()

    def test_duplicate_returns_normalized_name(self):
        with mock.patch.object(stage, "_existing_website_row_id", return_value="ds-0"):
            response = self.stage("https://example.org")
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(json.loads(response["body"])["name"], "https://example.org/")

    def test_duplicate_check_queries_all_spellings(self):
        cursor = self.connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = None
        stage._existing_website_row_id(self.connection, names=["https://example.org/", "https://example.org"])
        sql, params = cursor.execute.call_args.args
        self.assertIn("name = ANY(%s)", sql)
        self.assertEqual(params, ("website", ["https://example.org/", "https://example.org"]))


class StageVideoAndDocumentUrlSafetyTests(_Base):
    def setUp(self):
        super().setUp()
        # Collision checks hit the database; these tests cover URL shape only.
        patcher = mock.patch.object(stage, "_source_type_at_url", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_private_video_url_is_rejected_before_s3_and_transcribe(self):
        with mock.patch.object(stage, "head_etag") as head, \
                mock.patch.object(stage, "start_transcription_job") as transcribe:
            response = stage._stage_video(
                {},
                {
                    "video_file_name": "talk.mp4",
                    "video_s3_bucket": "bucket",
                    "video_s3_key": "uploads/video/talk.mp4",
                    "video_url": "http://169.254.169.254/latest",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(
            json.loads(response["body"])["error"],
            "video_url must be a public http(s) URL used for citations and deep-links",
        )
        head.assert_not_called()
        transcribe.assert_not_called()

    def test_video_url_colliding_with_a_crawled_page_is_rejected(self):
        with mock.patch.object(stage, "_source_type_at_url", return_value="web") as lookup, \
                mock.patch.object(stage, "head_etag") as head, \
                mock.patch.object(stage, "start_transcription_job") as transcribe:
            response = stage._stage_video(
                {},
                {
                    "video_file_name": "talk.mp4",
                    "video_s3_bucket": "bucket",
                    "video_s3_key": "uploads/video/talk.mp4",
                    "video_url": "https://www.youtube.com/watch?v=x",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 409)
        body = json.loads(response["body"])
        self.assertEqual(
            body["error"],
            "video_url is already a crawled web page and cannot be used as a video source",
        )
        self.assertEqual(body["existing_source_type"], "web")
        self.assertEqual(body["video_url"], "https://www.youtube.com/watch?v=x")
        lookup.assert_called_once_with(self.connection, "https://www.youtube.com/watch?v=x")
        head.assert_not_called()
        transcribe.assert_not_called()
        self.connection.commit.assert_not_called()

    def test_video_url_colliding_with_a_document_source_is_rejected(self):
        with mock.patch.object(stage, "_source_type_at_url", return_value="document"), \
                mock.patch.object(stage, "head_etag") as head, \
                mock.patch.object(stage, "start_transcription_job") as transcribe:
            response = stage._stage_video(
                {},
                {
                    "video_file_name": "talk.mp4",
                    "video_s3_bucket": "bucket",
                    "video_s3_key": "uploads/video/talk.mp4",
                    "video_url": "https://www.youtube.com/watch?v=x",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 409)
        self.assertIn("another source", json.loads(response["body"])["error"])
        head.assert_not_called()
        transcribe.assert_not_called()

    def test_video_url_already_used_by_a_video_is_not_a_conflict(self):
        with mock.patch.object(stage, "_source_type_at_url", return_value="video"), \
                mock.patch.object(stage, "head_etag", side_effect=RuntimeError("missing")), \
                mock.patch.object(stage, "start_transcription_job") as transcribe:
            response = stage._stage_video(
                {},
                {
                    "video_file_name": "talk.mp4",
                    "video_s3_bucket": "bucket",
                    "video_s3_key": "uploads/video/talk.mp4",
                    "video_url": "https://www.youtube.com/watch?v=x",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("does not exist in S3", json.loads(response["body"])["error"])
        transcribe.assert_not_called()

    def test_document_url_colliding_with_a_crawled_page_is_rejected(self):
        with mock.patch.object(stage, "_source_type_at_url", return_value="web") as lookup, \
                mock.patch.object(stage, "head_etag") as head:
            response = stage._stage_document(
                {},
                {
                    "document_file_name": "handbook.pdf",
                    "document_s3_bucket": "bucket",
                    "document_s3_key": "uploads/document/handbook.pdf",
                    "document_url": "https://example.org/handbook.pdf",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 409)
        body = json.loads(response["body"])
        self.assertEqual(
            body["error"],
            "document_url is already a crawled web page and cannot be used as a citation",
        )
        self.assertEqual(body["document_url"], "https://example.org/handbook.pdf")
        lookup.assert_called_once_with(self.connection, "https://example.org/handbook.pdf")
        head.assert_not_called()
        self.connection.commit.assert_not_called()

    def test_public_video_url_passes_validation(self):
        with mock.patch.object(stage, "head_etag", side_effect=RuntimeError("missing")), \
                mock.patch.object(stage, "start_transcription_job") as transcribe:
            response = stage._stage_video(
                {},
                {
                    "video_file_name": "talk.mp4",
                    "video_s3_bucket": "bucket",
                    "video_s3_key": "uploads/video/talk.mp4",
                    "video_url": "https://www.youtube.com/watch?v=x",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("does not exist in S3", json.loads(response["body"])["error"])
        transcribe.assert_not_called()

    def test_loopback_document_url_is_rejected(self):
        with mock.patch.object(stage, "head_etag") as head:
            response = stage._stage_document(
                {},
                {
                    "document_file_name": "handbook.pdf",
                    "document_s3_bucket": "bucket",
                    "document_s3_key": "uploads/document/handbook.pdf",
                    "document_url": "http://127.0.0.1/a.pdf",
                },
                self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("document_url is required", json.loads(response["body"])["error"])
        head.assert_not_called()


if __name__ == "__main__":
    unittest.main()
