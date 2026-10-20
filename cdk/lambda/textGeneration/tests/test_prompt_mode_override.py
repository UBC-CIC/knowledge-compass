"""
Per-session prompt mode override (migration 035, evaluation harness).
config.resolve_prompt_mode is the single resolution point; the global
config.PROMPT_MODE must never change per request. Run from textGeneration:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from helpers import config, crud  # noqa: E402
from test_chat_guideline_mode import ChatModeTestBase, GUIDELINE_REPLY  # noqa: E402


class ResolvePromptModeTest(unittest.TestCase):
    def test_switch_is_retired(self):
        # Journey documents and typed text share one path. Neither the global
        # mode nor a session override selects a second pipeline.
        for global_mode in ("standard", "guideline", "bogus", None):
            for override in ("guideline", "standard", "admin", None, ""):
                self.assertEqual(config.resolve_prompt_mode(global_mode, override), "standard")


class OverrideRoutingTest(ChatModeTestBase):
    reply = GUIDELINE_REPLY

    def test_session_override_does_not_skip_the_router(self):
        result, _ = self.respond("guideline")
        self.patches["route_turn"].assert_called_once()
        self.patches["retrieve_guideline_sections"].assert_not_called()
        self.assertEqual(result["phase"], "SUGGESTION")
        self.patches["save_routing_state"].assert_called_once()
        self.assertEqual(config.PROMPT_MODE, "guideline")


class _Cursor:
    def __init__(self, row=None, error=None):
        self.row, self.error = row, error

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        if self.error:
            raise self.error
        self.sql, self.params = sql, params

    def fetchone(self):
        return self.row


class _Conn:
    def __init__(self, cursor):
        self._cursor = cursor
        self.rolled_back = False

    def cursor(self):
        return self._cursor

    def rollback(self):
        self.rolled_back = True


class GetPromptModeOverrideTest(unittest.TestCase):
    def test_returns_valid_override(self):
        cur = _Cursor(row=("guideline",))
        self.assertEqual(crud.get_prompt_mode_override(_Conn(cur), "s1"), "guideline")
        self.assertEqual(cur.params, ("s1",))

    def test_null_and_unknown_values_are_none(self):
        for row in [None, (None,), ("other",)]:
            self.assertIsNone(crud.get_prompt_mode_override(_Conn(_Cursor(row=row)), "s1"))

    def test_missing_column_rolls_back_and_returns_none(self):
        conn = _Conn(_Cursor(error=Exception('column "prompt_mode_override" does not exist')))
        with mock.patch.object(crud.logger, "error"):
            self.assertIsNone(crud.get_prompt_mode_override(conn, "s1"))
        self.assertTrue(conn.rolled_back)


if __name__ == "__main__":
    unittest.main()
