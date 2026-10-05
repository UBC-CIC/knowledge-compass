"""
Unit tests for helpers/guideline_retrieval.py. Embedding and DB are mocked.
Run from textGeneration:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import guideline_retrieval as gr  # noqa: E402
from helpers.retrieval import to_public_source  # noqa: E402


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))
        if self.conn.error:
            raise self.conn.error
        if "WITH g AS MATERIALIZED" in sql:
            self._rows = self.conn.candidates
        else:
            docs, keys = params
            self._rows = [r for r in self.conn.chunks if r[0] in docs and r[1] in keys]

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, candidates=None, chunks=None, error=None):
        self.candidates = candidates or []
        self.chunks = chunks or []
        self.error = error
        self.executed = []
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def rollback(self):
        self.rollbacks += 1


def chunk(doc, key, idx, body, label=None):
    return (doc, key, idx, body, label or f"{key} label", f"Journey > {key}", f"{doc}.md")


CHUNKS = [
    chunk("d1", "Sent home", 0, "Keep a dated record."),
    chunk("d1", "Sent home", 1, "Ask for reasons in writing."),
    chunk("d1", "Transitions", 2, "Plan the move early."),
    chunk("d2", "Reduced day", 0, "Ask how long it will last."),
    chunk("d3", "window-1", 0, "first window"),
    chunk("d3", "window-2", 1, "second window"),
    chunk("d3", "window-3", 2, "third window"),
    chunk("d3", "window-4", 3, "fourth window"),
]


def run(conn, query="my child keeps getting sent home early", **kwargs):
    with mock.patch.object(gr, "embed_query", return_value=[0.1, 0.2]) as embed:
        result = gr.retrieve_guideline_sections(query, conn, "us-east-1", **kwargs)
    return result, embed


class GuidelineRetrievalTest(unittest.TestCase):
    def test_groups_sections_across_documents_in_score_order(self):
        conn = FakeConnection(
            candidates=[("d1", "Sent home", 0.9), ("d1", "Sent home", 0.8), ("d2", "Reduced day", 0.7)],
            chunks=CHUNKS,
        )
        results, _ = run(conn)
        self.assertEqual([r["metadata"]["section_key"] for r in results], ["Sent home", "Reduced day"])
        self.assertEqual(results[0]["content"], "Keep a dated record.\n\nAsk for reasons in writing.")
        self.assertEqual(results[0]["title"], "Sent home label")
        self.assertEqual(results[0]["source_type"], "guideline")
        self.assertEqual(results[0]["url"], "")
        self.assertEqual(results[1]["metadata"]["document_id"], "d2")
        print("\nMatched sections:", [(r["title"], r["content"]) for r in results])

    def test_max_sections(self):
        conn = FakeConnection(
            candidates=[("d1", "Sent home", 0.9), ("d2", "Reduced day", 0.8), ("d1", "Transitions", 0.7)],
            chunks=CHUNKS,
        )
        results, _ = run(conn, max_sections=2)
        self.assertEqual(len(results), 2)

    def test_word_cap(self):
        long_body = " ".join(["word"] * 50)
        conn = FakeConnection(
            candidates=[("d1", "A", 0.9), ("d1", "B", 0.8)],
            chunks=[chunk("d1", "A", 0, long_body), chunk("d1", "B", 1, long_body)],
        )
        results, _ = run(conn, max_words=60)
        total = sum(len(r["content"].replace("…", "").split()) for r in results)
        self.assertLessEqual(total, 60)
        self.assertEqual(len(results), 2)
        self.assertTrue(results[1]["content"].endswith("…"))

    def test_previous_section_is_kept_first(self):
        conn = FakeConnection(
            candidates=[("d2", "Reduced day", 0.9), ("d1", "Transitions", 0.8), ("d1", "Sent home", 0.1)],
            chunks=CHUNKS,
        )
        previous = {"document_id": "d1", "section_key": "Sent home", "label": "Child sent home early"}
        results, embed = run(conn, previous_section=previous, max_sections=2)
        self.assertEqual([r["metadata"]["section_key"] for r in results], ["Sent home", "Reduced day"])
        self.assertIn("Child sent home early", embed.call_args[0][0])

    def test_previous_section_absent_from_candidates_is_still_loaded(self):
        conn = FakeConnection(candidates=[("d2", "Reduced day", 0.9)], chunks=CHUNKS)
        previous = {"document_id": "d1", "section_key": "Transitions", "label": "Moving schools"}
        results, _ = run(conn, previous_section=previous)
        self.assertEqual(results[0]["metadata"]["section_key"], "Transitions")

    def test_removed_previous_section_is_skipped(self):
        conn = FakeConnection(candidates=[("d2", "Reduced day", 0.9)], chunks=CHUNKS)
        previous = {"document_id": "gone", "section_key": "Old", "label": "Old"}
        results, _ = run(conn, previous_section=previous)
        self.assertEqual([r["metadata"]["section_key"] for r in results], ["Reduced day"])

    def test_window_expansion(self):
        conn = FakeConnection(candidates=[("d3", "window-2", 0.9)], chunks=CHUNKS)
        results, _ = run(conn)
        self.assertEqual(results[0]["content"], "first window\n\nsecond window\n\nthird window")

    def test_sql_filters_to_guideline_sources(self):
        conn = FakeConnection(candidates=[("d1", "Sent home", 0.9)], chunks=CHUNKS)
        run(conn)
        for sql, _ in conn.executed:
            self.assertIn("s.metadata->>'kb_role' = 'guideline'", sql)
            self.assertIn("d.status = 'ready'", sql)

    def test_db_error_returns_empty_and_rolls_back(self):
        conn = FakeConnection(error=RuntimeError("db down"))
        results, _ = run(conn)
        self.assertEqual(results, [])
        self.assertEqual(conn.rollbacks, 1)

    def test_embed_error_returns_empty(self):
        conn = FakeConnection()
        with mock.patch.object(gr, "embed_query", side_effect=RuntimeError("bedrock")):
            self.assertEqual(gr.retrieve_guideline_sections("q", conn, "us-east-1"), [])
        self.assertEqual(conn.executed, [])

    def test_no_candidates(self):
        results, _ = run(FakeConnection())
        self.assertEqual(results, [])

    def test_public_projection_has_no_link(self):
        conn = FakeConnection(candidates=[("d1", "Sent home", 0.9)], chunks=CHUNKS)
        results, _ = run(conn)
        public = to_public_source(results[0])
        self.assertEqual(public["url"], "")
        self.assertEqual(public["source_type"], "guideline")


if __name__ == "__main__":
    unittest.main()
