"""
Unit tests for helpers/bedrock_clients.py. No AWS access: building a client
does not make a network call. Run from the textGeneration dir:

    py -3 -m unittest discover -s tests -p "test_*.py"
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import bedrock_clients  # noqa: E402


class BedrockRuntimeClientTests(unittest.TestCase):
    def setUp(self):
        bedrock_clients._clients.clear()

    def tearDown(self):
        bedrock_clients._clients.clear()

    def test_one_client_per_region_is_reused(self):
        with mock.patch.object(bedrock_clients.boto3, "client", side_effect=lambda *a, **k: mock.Mock()) as make:
            a = bedrock_clients.bedrock_runtime("ca-central-1")
            self.assertIs(a, bedrock_clients.bedrock_runtime("ca-central-1"))
            b = bedrock_clients.bedrock_runtime("us-east-1")
        self.assertIsNot(a, b)
        self.assertEqual(make.call_count, 2)
        make.assert_any_call("bedrock-runtime", region_name="ca-central-1")
        make.assert_any_call("bedrock-runtime", region_name="us-east-1")


if __name__ == "__main__":
    unittest.main()
