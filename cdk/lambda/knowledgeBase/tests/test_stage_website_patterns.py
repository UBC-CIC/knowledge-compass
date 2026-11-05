"""
Staging a website validates its include/exclude patterns (finding
f-fd9e37e5): a pattern the crawler could not compile, or patterns that
exclude the seed itself, are a 400 and nothing is stored. DNS is faked; no
network is used.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_stage_website_patterns.py" -v
"""

import json
import socket
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

# Staging only needs trigger_uploaded_document from process_document_batch;
# stub it so these tests don't need docx/lxml installed locally (same as
# test_stage_url_safety.py).
if "helpers.process_document_batch" not in sys.modules:
    _stub = types.ModuleType("helpers.process_document_batch")
    _stub.trigger_uploaded_document = mock.Mock()
    sys.modules["helpers.process_document_batch"] = _stub

from helpers import stage_data_sources as stage  # noqa: E402

DNS = {"example.org": ["93.184.216.34"]}

INCLUDE = [r"^https://example\.org/science/"]
EXCLUDE = [r"^https://example\.org/science/private/"]


def fake_getaddrinfo(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    if host not in DNS:
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]]


class StageWebsitePatternTests(unittest.TestCase):
    def setUp(self):
        for patcher in (
            mock.patch.object(stage, "get_cors_headers", return_value={}),
            mock.patch("socket.getaddrinfo", fake_getaddrinfo),
            mock.patch.object(stage, "_existing_website_row_id", return_value=None),
            mock.patch.object(stage, "_insert_ingestion_run_row", return_value="run-1"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.connection = mock.MagicMock()

    def stage(self, name="https://example.org/science/", include=None, exclude=None):
        body = {"type": "website", "name": name}
        if include is not None:
            body["include_patterns"] = include
        if exclude is not None:
            body["exclude_patterns"] = exclude
        with mock.patch.object(stage, "_insert_data_source_row", return_value="ds-1") as insert:
            response = stage._stage_website(
                {}, body, self.connection, created_by="admin@example.org", created_by_user_id="u1",
            )
        return response, insert

    def test_malformed_pattern_is_a_400_and_nothing_is_stored(self):
        for include, exclude in (
            (["[unclosed"], []), ([], ["(a"]), ([42], []), (["ok"], "nope"),
            ([], [r"^(a+)+$"]),  # catastrophic backtracking (scan-b594378e)
        ):
            with self.subTest(include=include, exclude=exclude):
                self.connection.reset_mock()
                response, insert = self.stage(include=include, exclude=exclude)
                self.assertEqual(response["statusCode"], 400)
                self.assertTrue(json.loads(response["body"])["error"])
                insert.assert_not_called()
                self.connection.commit.assert_not_called()

    def test_seed_outside_its_own_patterns_is_a_400(self):
        for include, exclude in ((INCLUDE, []), ([], [r"^https://example\.org/"])):
            with self.subTest(include=include, exclude=exclude):
                response, insert = self.stage(name="https://example.org/", include=include, exclude=exclude)
                self.assertEqual(response["statusCode"], 400)
                self.assertIn("website URL", json.loads(response["body"])["error"])
                insert.assert_not_called()

    def test_valid_patterns_are_stored(self):
        response, insert = self.stage(include=INCLUDE, exclude=EXCLUDE)
        self.assertEqual(response["statusCode"], 200, response["body"])
        self.assertEqual(insert.call_args.kwargs["include_patterns"], INCLUDE)
        self.assertEqual(insert.call_args.kwargs["exclude_patterns"], EXCLUDE)

    def test_no_patterns_store_null(self):
        response, insert = self.stage()
        self.assertEqual(response["statusCode"], 200, response["body"])
        self.assertIsNone(insert.call_args.kwargs["include_patterns"])
        self.assertIsNone(insert.call_args.kwargs["exclude_patterns"])


if __name__ == "__main__":
    unittest.main()
