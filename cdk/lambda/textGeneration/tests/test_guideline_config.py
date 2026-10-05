"""
Unit tests for guideline-mode config loading (crud.fetch_guideline_config and
config.apply_guideline_config). No live database; run from textGeneration:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import config, crud  # noqa: E402


class ScriptedCursor:
    """Cursor that returns scripted results per execute() call."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append(sql)
        if self.conn.error:
            raise self.conn.error
        self._result = self.conn.results.pop(0) if self.conn.results else []

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


class ScriptedConnection:
    def __init__(self, results=None, error=None):
        self.results = list(results or [])
        self.error = error
        self.executed = []
        self.rollbacks = 0

    def cursor(self):
        return ScriptedCursor(self)

    def rollback(self):
        self.rollbacks += 1


class FetchGuidelineConfigTest(unittest.TestCase):
    def test_maps_mode_and_outline(self):
        conn = ScriptedConnection(results=[
            [("guideline",)],
            [
                ("doc-1", "guide.md", "Sent home early", "Child sent home early"),
                ("doc-1", "guide.md", "Transitions", "Renamed by admin"),
            ],
        ])
        result = crud.fetch_guideline_config(conn)
        self.assertEqual(result["mode"], "guideline")
        self.assertEqual(len(result["outline"]), 2)
        self.assertEqual(result["outline"][1]["label"], "Renamed by admin")
        self.assertEqual(result["outline"][0]["document_id"], "doc-1")

    def test_outline_query_prefers_override(self):
        conn = ScriptedConnection(results=[[("standard",)], []])
        crud.fetch_guideline_config(conn)
        outline_sql = conn.executed[1]
        self.assertIn("COALESCE(NULLIF(s.label_override, ''), s.auto_label)", outline_sql)
        self.assertIn("d.status = 'ready'", outline_sql)

    def test_unknown_mode_falls_back_to_standard(self):
        conn = ScriptedConnection(results=[[("weird",)], []])
        self.assertEqual(crud.fetch_guideline_config(conn)["mode"], "standard")

    def test_db_error_falls_back_and_rolls_back(self):
        conn = ScriptedConnection(error=RuntimeError('relation "guideline_config" does not exist'))
        result = crud.fetch_guideline_config(conn)
        self.assertEqual(result, {"mode": "standard", "outline": []})
        self.assertEqual(conn.rollbacks, 1)


class ApplyGuidelineConfigTest(unittest.TestCase):
    def tearDown(self):
        config.apply_guideline_config({"mode": "standard", "outline": []})

    def test_sets_globals(self):
        outline = [{"document_id": "d", "file_name": "f.md", "section_key": "k", "label": "L"}]
        config.apply_guideline_config({"mode": "guideline", "outline": outline})
        self.assertEqual(config.PROMPT_MODE, "guideline")
        self.assertEqual(config.GUIDELINE_OUTLINE, outline)

    def test_invalid_values_default_to_standard(self):
        config.apply_guideline_config({"mode": None, "outline": "bad"})
        self.assertEqual(config.PROMPT_MODE, "standard")
        self.assertEqual(config.GUIDELINE_OUTLINE, [])

    def test_default_is_standard(self):
        config.apply_guideline_config(None)
        self.assertEqual(config.PROMPT_MODE, "standard")


if __name__ == "__main__":
    unittest.main()
