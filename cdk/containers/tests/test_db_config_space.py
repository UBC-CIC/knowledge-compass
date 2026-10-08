"""
db_config.get_active_embedding_space / spec_from_space (migration 032).
psycopg2 is stubbed; no database, no AWS. Run from cdk/:

    py -3 -m unittest discover -s containers/tests -p "test_*.py"
"""

import importlib.util
import os
import sys
import types
import unittest
from unittest import mock

_CONTAINERS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _load_db_config():
    path = os.path.join(_CONTAINERS, "common", "db_config.py")
    spec = importlib.util.spec_from_file_location("kc_db_config_under_test", path)
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {"psycopg2": types.ModuleType("psycopg2")}):
        spec.loader.exec_module(module)
    return module


db_config = _load_db_config()


class Cursor:
    def __init__(self, row):
        self.row, self.executed = row, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append(sql)

    def fetchone(self):
        return self.row


class Conn:
    def __init__(self, row):
        self.cur = Cursor(row)

    def cursor(self):
        return self.cur


ROW = ("33333333-3333-4333-8333-333333333333", "titan-v2-1024", "titan_v2", "amazon.titan-embed-text-v2:0",
       "amazon.titan-embed-text-v2:0", 1024, "1", "active", "0.350", None, '{"concurrency": 4}')


class ActiveSpaceTests(unittest.TestCase):
    def test_reads_the_pointer_and_maps_the_columns(self):
        conn = Conn(ROW)
        space = db_config.get_active_embedding_space(conn)
        self.assertEqual(space["name"], "titan-v2-1024")
        self.assertEqual((space["min_score"], space["split_threshold"]), (0.35, None))
        self.assertEqual(space["settings"], {"concurrency": 4})
        self.assertIn("FROM embedding_active_space a", conn.cur.executed[0])

    def test_no_active_space_is_a_config_error(self):
        with self.assertRaises(db_config.ConfigError):
            db_config.get_active_embedding_space(Conn(None))

    def test_spec_from_space_applies_settings_and_adapter_defaults(self):
        spec = db_config.spec_from_space(db_config.get_active_embedding_space(Conn(ROW)))
        self.assertEqual((spec.provider, spec.dimensions, spec.concurrency, spec.max_chars), ("titan_v2", 1024, 4, 8000))

    def test_spec_from_space_rejects_a_dimension_the_provider_does_not_allow(self):
        row = ROW[:5] + (768,) + ROW[6:]
        with self.assertRaises(ValueError):
            db_config.spec_from_space(db_config.get_active_embedding_space(Conn(row)))

    def test_env_embed_settings_remain_as_deprecated_fallbacks(self):
        self.assertEqual(db_config.get_embed_model_id(), db_config.DEFAULT_EMBED_MODEL_ID)
        self.assertEqual(db_config.get_embed_batch_size(), 96)
        self.assertIn("DEPRECATED", db_config.get_embed_model_id.__doc__)
        self.assertIn("DEPRECATED", db_config.get_embed_batch_size.__doc__)


if __name__ == "__main__":
    unittest.main()
