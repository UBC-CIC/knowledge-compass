"""
Document uploads must carry a public http(s) link: it is the only way public
users can open a cited document. Validation runs before any S3 or DB access.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_stage_document_url.py" -v
"""

import json
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

# Staging only needs trigger_uploaded_document from process_document_batch;
# stub it so these validation tests don't need docx/lxml installed locally.
if "helpers.process_document_batch" not in sys.modules:
    _stub = types.ModuleType("helpers.process_document_batch")
    _stub.trigger_uploaded_document = mock.Mock()
    sys.modules["helpers.process_document_batch"] = _stub

from helpers import stage_data_sources as stage  # noqa: E402


def body(**overrides):
    return {
        "type": "document",
        "document_file_name": "handbook.pdf",
        "document_s3_bucket": "bucket",
        "document_s3_key": "uploads/document/1_handbook.pdf",
        **overrides,
    }


class StageDocumentUrlTests(unittest.TestCase):
    def setUp(self):
        cors = mock.patch.object(stage, "get_cors_headers", return_value={})
        cors.start()
        self.addCleanup(cors.stop)
        head = mock.patch.object(stage, "head_etag", side_effect=AssertionError("S3 must not be called"))
        head.start()
        self.addCleanup(head.stop)

    def stage(self, request_body):
        return stage._stage_document(
            {}, request_body, mock.Mock(), created_by="admin@example.org", created_by_user_id="u1"
        )

    def assert_rejected(self, response):
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("document_url is required", json.loads(response["body"])["error"])

    def test_missing_link_is_rejected(self):
        self.assert_rejected(self.stage(body()))

    def test_blank_link_is_rejected(self):
        self.assert_rejected(self.stage(body(document_url="   ")))

    def test_non_http_link_is_rejected(self):
        self.assert_rejected(self.stage(body(document_url="s3://bucket/key.pdf")))

    def test_http_link_passes_validation(self):
        # Gets past URL validation and reaches the S3 existence check.
        with mock.patch.object(stage, "head_etag", side_effect=RuntimeError("missing")):
            response = self.stage(body(document_url="https://example.org/handbook.pdf"))
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("does not exist in S3", json.loads(response["body"])["error"])


if __name__ == "__main__":
    unittest.main()
