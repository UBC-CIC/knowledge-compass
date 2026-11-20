"""
The database connection verifies the server certificate and hostname
(sslmode=verify-full against a CA bundle that exists), not just encryption.
psycopg2 and Powertools are stubbed; no database.

Run from the textGeneration dir:

    python -m unittest discover -s tests -p "test_db_tls.py" -v
"""

import importlib
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class DbTlsTests(unittest.TestCase):
    def test_connect_uses_verify_full_with_a_real_ca_bundle(self):
        psycopg2 = types.ModuleType("psycopg2")
        psycopg2.connect = mock.Mock()
        parameters = types.SimpleNamespace(get_secret=lambda *a, **k: {"username": "u", "password": "p", "dbname": "d"})
        utilities = types.ModuleType("aws_lambda_powertools.utilities")
        utilities.parameters = parameters
        stubs = {
            "psycopg2": psycopg2,
            "aws_lambda_powertools": types.ModuleType("aws_lambda_powertools"),
            "aws_lambda_powertools.utilities": utilities,
        }
        with mock.patch.dict(sys.modules, stubs), \
                mock.patch.dict(os.environ, {"SM_DB_CREDENTIALS": "s", "RDS_PROXY_ENDPOINT": "proxy.example"}):
            sys.modules.pop("helpers.db_connection", None)
            db_connection = importlib.import_module("helpers.db_connection")
            try:
                db_connection.get_db_connection()
            finally:
                sys.modules.pop("helpers.db_connection", None)

        kwargs = psycopg2.connect.call_args.kwargs
        self.assertEqual(kwargs["sslmode"], "verify-full")
        self.assertTrue(os.path.isfile(kwargs["sslrootcert"]))
        self.assertEqual(kwargs["host"], "proxy.example")


if __name__ == "__main__":
    unittest.main()
