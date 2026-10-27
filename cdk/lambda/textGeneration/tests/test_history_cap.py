"""
Unit tests for the conversation-history cap in crud.fetch_recent_messages
(finding A-06). No database. Run from textGeneration:

    python -m unittest tests.test_history_cap -v
"""

import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers import crud  # noqa: E402
from helpers.crud import HISTORY_MESSAGES, MAX_HISTORY_CHARS, fetch_recent_messages  # noqa: E402

T0 = datetime.datetime(2026, 10, 27, 12, 0, 0)


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.params = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        self.params = params

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.cur = FakeCursor(rows)

    def cursor(self):
        return self.cur


def rows(*messages):
    """(sender, content) pairs, oldest first, as the SQL returns them."""
    return [(s, c, T0 + datetime.timedelta(minutes=i)) for i, (s, c) in enumerate(messages)]


def fetch(*messages):
    return fetch_recent_messages(FakeConnection(rows(*messages)), "session-1")


class HistoryCapTests(unittest.TestCase):
    def test_short_history_is_unchanged(self):
        history = fetch(("user", "hi"), ("AI", "hello"), ("user", "my son"), ("AI", "tell me more"))
        self.assertEqual([m["content"] for m in history], ["hi", "hello", "my son", "tell me more"])

    def test_query_asks_for_the_message_window(self):
        conn = FakeConnection([])
        fetch_recent_messages(conn, "session-1")
        self.assertEqual(conn.cur.params, ("session-1", HISTORY_MESSAGES))

    def test_oldest_turns_are_dropped_to_fit(self):
        big = "x" * (MAX_HISTORY_CHARS // 2)
        history = fetch(("user", "old question"), ("AI", big), ("user", "newer"), ("AI", big))
        # The newest AI answer fits, "newer" fits; the older big answer does not.
        self.assertEqual([m["content"] for m in history], ["newer", big])
        self.assertLessEqual(sum(len(m["content"]) for m in history), MAX_HISTORY_CHARS)

    def test_history_still_starts_with_a_user_turn(self):
        big = "y" * MAX_HISTORY_CHARS
        history = fetch(("user", big), ("AI", "a1"), ("user", "q2"), ("AI", "a2"))
        # The budget keeps a1, q2, a2; a1 is an AI message, so it is dropped too.
        self.assertEqual([m["content"] for m in history], ["q2", "a2"])

    def test_kept_history_is_contiguous(self):
        big = "x" * MAX_HISTORY_CHARS
        history = fetch(("user", "a"), ("AI", "b"), ("user", big), ("AI", "c"))
        # "big" does not fit after "c", so nothing older than "c" is kept, even
        # though "a" and "b" would fit on their own.
        self.assertEqual([m["content"] for m in history], [])

    def test_oversized_newest_message_leaves_no_history(self):
        history = fetch(("user", "a"), ("AI", "x" * (MAX_HISTORY_CHARS + 1)))
        self.assertEqual(history, [])

    def test_exactly_at_budget_is_kept(self):
        half = "x" * (MAX_HISTORY_CHARS // 2)
        history = fetch(("user", half), ("AI", half))
        self.assertEqual(len(history), 2)

    def test_empty_content_counts_as_zero(self):
        history = fetch(("user", "q"), ("AI", None), ("user", "q2"), ("AI", "a2"))
        self.assertEqual(len(history), 4)

    def test_log_has_counts_only(self):
        secret = "my child's diagnosis " + "x" * MAX_HISTORY_CHARS
        with self.assertLogs(crud.logger, level="INFO") as logs:
            fetch(("user", secret), ("AI", "short"), ("user", "q"), ("AI", "a"))
        self.assertEqual(logs.output, ["INFO:helpers.crud:History capped: dropped 1 of 4 messages"])


if __name__ == "__main__":
    unittest.main()
