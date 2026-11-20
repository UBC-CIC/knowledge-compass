"""
Unit tests for kc_shared/cors.py (shared layer, used by both Lambdas): every
misconfiguration or SSM failure must fail closed, never to a wildcard.
Run from textGeneration:  python -m unittest discover -s tests -p "test_cors.py"
"""

import os
import sys
import unittest
from unittest import mock

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

from kc_shared import cors  # noqa: E402

PARAM = "/test/API/AllowedOrigins"
APP = "https://app.example.test"


def _event(origin):
    return {"headers": {"origin": origin}}


def _ssm(value=None, error=None):
    client = mock.Mock()
    if error:
        client.get_parameter.side_effect = error
    else:
        client.get_parameter.return_value = {"Parameter": {"Value": value}}
    return client


class CorsTests(unittest.TestCase):
    def setUp(self):
        cors.cached_allowed_origins = None
        self.env = mock.patch.dict(os.environ, {"ALLOWED_ORIGIN_PARAM": PARAM}, clear=False)
        self.env.start()
        os.environ.pop("CORS_ALLOWED_METHODS", None)
        self.addCleanup(self.env.stop)
        print_patch = mock.patch("builtins.print")
        print_patch.start()
        self.addCleanup(print_patch.stop)

    def test_unset_param_fails_closed(self):
        del os.environ["ALLOWED_ORIGIN_PARAM"]
        with mock.patch.object(cors.boto3, "client") as client:
            headers = cors.get_cors_headers(_event("https://evil.example"))
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        client.assert_not_called()

    def test_ssm_failure_fails_closed_and_is_not_cached(self):
        with mock.patch.object(cors.boto3, "client", return_value=_ssm(error=Exception("Throttling"))):
            self.assertNotIn("Access-Control-Allow-Origin", cors.get_cors_headers(_event(APP)))
        self.assertIsNone(cors.cached_allowed_origins)
        with mock.patch.object(cors.boto3, "client", return_value=_ssm(APP)):
            self.assertEqual(cors.get_cors_headers(_event(APP))["Access-Control-Allow-Origin"], APP)

    def test_wildcard_entries_are_ignored(self):
        with mock.patch.object(cors.boto3, "client", return_value=_ssm(f"*, {APP}/ , https://*.example.test")):
            foreign = cors.get_cors_headers(_event("https://evil.example"))
            allowed = cors.get_cors_headers({"headers": {"Origin": APP}})
        self.assertNotIn("Access-Control-Allow-Origin", foreign)
        self.assertEqual(allowed["Access-Control-Allow-Origin"], APP)
        self.assertEqual(allowed["Vary"], "Origin")

    def test_methods_come_from_env_plus_options(self):
        cors.cached_allowed_origins = [APP]
        self.assertEqual(cors.get_cors_headers(_event(APP))["Access-Control-Allow-Methods"], "OPTIONS")
        with mock.patch.dict(os.environ, {"CORS_ALLOWED_METHODS": "POST"}):
            self.assertEqual(cors.get_cors_headers(_event(APP))["Access-Control-Allow-Methods"], "POST,OPTIONS")

    def test_missing_headers_do_not_crash(self):
        cors.cached_allowed_origins = [APP]
        self.assertNotIn("Access-Control-Allow-Origin", cors.get_cors_headers({"headers": None}))
        self.assertNotIn("Access-Control-Allow-Origin", cors.get_cors_headers(None))


if __name__ == "__main__":
    unittest.main()
