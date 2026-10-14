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
    def test_override_wins(self):
        self.assertEqual(config.resolve_prompt_mode("standard", "guideline"), "guideline")
        self.assertEqual(config.resolve_prompt_mode("guideline", "standard"), "standard")

    def test_no_override_uses_global(self):
        self.assertEqual(config.resolve_prompt_mode("guideline", None), "guideline")
        self.assertEqual(config.resolve_prompt_mode("standard", None), "standard")

    def test_invalid_values_fall_back(self):
        self.assertEqual(config.resolve_prompt_mode("guideline", "admin"), "guideline")
        self.assertEqual(config.resolve_prompt_mode("bogus", None), "standard")
        self.assertEqual(config.resolve_prompt_mode(None, ""), "standard")


class OverrideRoutingTest(ChatModeTestBase):
    reply = GUIDELINE_REPLY

    def _guideline_path_taken(self):
        return self.patches["retrieve_guideline_sections"].called

    def _reset(self):
        for m in self.patches.values():
            m.reset_mock()

    def test_guideline_override_in_standard_global(self):
        self.patches["get_prompt_mode_override"].return_value = "guideline"
        result, _ = self.respond("standard")
        self.assertTrue(self._guideline_path_taken())
        self.patches["route_turn"].assert_not_called()
        self.assertEqual(result["phase"], "SUGGESTION")
        self.patches["save_routing_state"].assert_not_called()
        self.assertEqual(config.PROMPT_MODE, "standard")

    def test_standard_override_in_guideline_global(self):
        self.patches["get_prompt_mode_override"].return_value = "standard"
        self.respond("guideline")
        self.assertFalse(self._guideline_path_taken())
        self.patches["route_turn"].assert_called_once()
        self.assertEqual(config.PROMPT_MODE, "guideline")

    def test_null_override_uses_global(self):
        self.patches["get_prompt_mode_override"].return_value = None
        self.respond("guideline")
        self.assertTrue(self._guideline_path_taken())
        self._reset()
        self.respond("standard")
        self.assertFalse(self._guideline_path_taken())

    def test_override_does_not_leak_to_next_session(self):
        # An eval session in guideline mode, then a normal session on the same
        # warm container: the normal one must follow the (standard) global.
        self.patches["get_prompt_mode_override"].return_value = "guideline"
        self.respond("standard")
        self.assertTrue(self._guideline_path_taken())

        self._reset()
        self.patches["get_prompt_mode_override"].return_value = None
        self.respond("standard")
        self.assertFalse(self._guideline_path_taken())
        self.patches["route_turn"].assert_called_once()
        self.assertEqual(config.PROMPT_MODE, "standard")

    def test_override_is_read_for_the_turns_session(self):
        self.respond("standard")
        args = self.patches["get_prompt_mode_override"].call_args.args
        self.assertEqual(args[1], "s1")


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
