"""
Unit tests for helpers/retrieval.py (pgvector retrieval, Phase 2).

These tests mock the Bedrock embedding call and the DB cursor, so they run with
no AWS access and no live database. Run from the textGeneration dir:

    python -m unittest discover -s tests -v

or:

    python -m pytest tests/test_retrieval.py
"""

import os
import sys
import unittest
from unittest import mock

# Make `helpers` importable when running from the textGeneration directory.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import retrieval  # noqa: E402


# ── Test doubles ──────────────────────────────────────────────────────────────

class FakeCursor:
    """Minimal context-manager cursor returning a fixed row set."""

    def __init__(self, rows):
        self._rows = rows
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def fetchall(self):
        return self._rows


class PagingCursor(FakeCursor):
    """Cursor that honors LIMIT/OFFSET parameters over an in-memory row list."""

    def execute(self, sql, params=None):
        super().execute(sql, params)
        if params is None:  # SAVEPOINT / SET LOCAL statements
            return
        limit, offset = params[-2], params[-1]
        self._page = self._rows[offset: offset + limit]

    def fetchall(self):
        return self._page


class RejectingSettingCursor(FakeCursor):
    """Cursor that rejects one SET LOCAL statement, like pgvector < 0.8.0."""

    def __init__(self, rows, rejected_fragment):
        super().__init__(rows)
        self._rejected = rejected_fragment

    def execute(self, sql, params=None):
        super().execute(sql, params)
        if self._rejected in sql:
            raise RuntimeError("unrecognized configuration parameter")


class FakeConnection:
    def __init__(self, rows):
        self._rows = rows
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self._rows)

    def rollback(self):
        self.rollbacks += 1


class FailingConnection:
    def __init__(self):
        self.rollbacks = 0

    def cursor(self):
        raise RuntimeError("db down")

    def rollback(self):
        self.rollbacks += 1


def _search_statements(cursor):
    """The candidate SELECTs, without the settings statements."""
    return [(sql, params) for sql, params in cursor.executed if params is not None]


def _row(body, url, title, source_type, score, metadata=None, source_id=None):
    """Build a row in the SELECT column order used by retrieve_from_pgvector."""
    return (body, metadata or {}, url, title, source_type, score, source_id or url)


# A fake 1024-dim embedding (values irrelevant; DB is mocked).
FAKE_EMBEDDING = [0.01] * 1024


class RetrieveFromPgvectorTests(unittest.TestCase):
    def setUp(self):
        # Patch embed_query so no Bedrock call happens.
        patcher = mock.patch.object(retrieval, "embed_query", return_value=FAKE_EMBEDDING)
        self.mock_embed = patcher.start()
        self.addCleanup(patcher.stop)

    def test_output_shape_matches_legacy_contract(self):
        rows = [_row("body A", "https://x/a", "Title A", "web", 0.90, {"heading_path": "H > A"})]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector("q", conn, region="ca-central-1", num_results=5)

        self.assertEqual(len(results), 1)
        r = results[0]
        # Legacy keys used by bedrock.format_context_for_prompt / chat.py
        for key in ("type", "uri", "url", "content", "score"):
            self.assertIn(key, r)
        self.assertEqual(r["type"], "WEB")            # uppercased legacy type
        self.assertEqual(r["uri"], "https://x/a")
        self.assertEqual(r["url"], "https://x/a")
        self.assertEqual(r["content"], "body A")
        self.assertAlmostEqual(r["score"], 0.90, places=4)
        # Richer fields
        self.assertEqual(r["title"], "Title A")
        self.assertEqual(r["source_type"], "web")
        self.assertEqual(r["metadata"], {"heading_path": "H > A"})

    def test_min_score_filters_low_results(self):
        rows = [
            _row("keep", "https://x/keep", "Keep", "web", 0.80),
            _row("drop", "https://x/drop", "Drop", "web", 0.10),
        ]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector(
            "q", conn, region="r", num_results=5, min_score=0.40, min_results=1
        )

        urls = [r["url"] for r in results]
        self.assertIn("https://x/keep", urls)
        self.assertNotIn("https://x/drop", urls)

    def test_dedupes_by_url_keeping_highest_first(self):
        # Rows arrive already ordered by similarity (highest first).
        rows = [
            _row("first", "https://x/dup", "Dup", "web", 0.90),
            _row("second", "https://x/dup", "Dup", "web", 0.85),
            _row("other", "https://x/other", "Other", "web", 0.80),
        ]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector("q", conn, region="r", num_results=5)

        urls = [r["url"] for r in results]
        self.assertEqual(urls, ["https://x/dup", "https://x/other"])
        # The first (highest-score) row for the duplicate URL wins.
        dup = next(r for r in results if r["url"] == "https://x/dup")
        self.assertEqual(dup["content"], "first")

    def test_documents_sharing_a_citation_link_are_both_kept(self):
        # Two uploaded documents with the same public link are separate sources.
        rows = [
            _row("handbook", "https://x/landing", "Handbook", "document", 0.90, source_id="s1"),
            _row("faq", "https://x/landing", "FAQ", "document", 0.85, source_id="s2"),
            _row("handbook again", "https://x/landing", "Handbook", "document", 0.80, source_id="s1"),
        ]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector("q", conn, region="r", num_results=5)

        self.assertEqual([r["title"] for r in results], ["Handbook", "FAQ"])

    def test_query_prefers_chunk_then_source_citation_and_hides_cache(self):
        conn = FakeConnection([])
        cursor = FakeCursor([])
        conn.cursor = lambda: cursor

        retrieval.retrieve_from_pgvector("q", conn, region="r")

        sql = _search_statements(cursor)[0][0]
        self.assertIn("NULLIF(c.metadata->>'citation_url', '')", sql)
        self.assertIn("NULLIF(s.metadata->>'citation_url', '')", sql)
        self.assertIn("s.source_type = 'csv_row'::source_type", sql)
        self.assertIn("retrieval_hidden", sql)
        self.assertIn("l.row_source_id = s.id AND l.row_indexed = true", sql)

    def test_row_resource_without_url_remains_a_titled_source(self):
        rows = [_row("row body", None, "Row title", "csv_row", 0.9, source_id="row-1")]
        results = retrieval.retrieve_from_pgvector("q", FakeConnection(rows), region="r")
        self.assertEqual(results[0]["title"], "Row title")
        self.assertEqual(results[0]["url"], "")
        self.assertEqual(results[0]["uri"], "")

    def test_collapses_row_variants_of_same_canonical_chunk(self):
        shared = "csvlink://https://fetch.example#0:hash"
        rows = [
            _row("row one", "https://public.example/one", "One", "csv_row", 0.92,
                 {"canonical_content_key": shared}, source_id="row-1"),
            _row("row two", "https://public.example/two", "Two", "csv_row", 0.90,
                 {"canonical_content_key": shared}, source_id="row-2"),
            _row("standalone", "https://public.example/two", "Two", "csv_row", 0.85,
                 {"chunk_kind": "csv_row"}, source_id="row-2"),
        ]
        results = retrieval.retrieve_from_pgvector(
            "q", FakeConnection(rows), region="r", num_results=5, min_results=2
        )
        self.assertEqual([result["content"] for result in results], ["row one", "standalone"])

    def test_pages_past_duplicate_variants_to_find_distinct_sources(self):
        shared = "csvlink://https://fetch.example#0:hash"
        duplicates = [
            _row(f"variant {index}", f"https://public.example/{index}", f"Row {index}", "csv_row", 0.99,
                 {"canonical_content_key": shared}, source_id=f"row-{index}")
            for index in range(56)
        ]
        rows = duplicates + [_row("distinct", "https://other.example", "Other", "web", 0.8)]
        cursor = PagingCursor(rows)
        connection = FakeConnection([])
        connection.cursor = lambda: cursor

        results = retrieval.retrieve_from_pgvector(
            "q", connection, region="r", num_results=7, min_results=2
        )

        self.assertEqual([result["content"] for result in results], ["variant 0", "distinct"])
        self.assertEqual(len(_search_statements(cursor)), 2)

    def test_raises_hnsw_limits_before_searching(self):
        cursor = FakeCursor([])
        conn = FakeConnection([])
        conn.cursor = lambda: cursor

        retrieval.retrieve_from_pgvector("q", conn, region="r")

        statements = [sql.strip() for sql, _ in cursor.executed]
        first_select = next(i for i, sql in enumerate(statements) if sql.startswith("SELECT"))
        settings = statements[:first_select]
        self.assertIn("SET LOCAL hnsw.ef_search = 200", settings)
        self.assertIn("SET LOCAL hnsw.iterative_scan = strict_order", settings)
        # Plain SET would persist on the cached connection (and pin RDS Proxy).
        self.assertFalse(any(sql.startswith("SET ") and "LOCAL" not in sql for sql in settings))

    def test_unsupported_iterative_scan_still_searches(self):
        rows = [_row("body", "https://x/a", "A", "web", 0.9)]
        cursor = RejectingSettingCursor(rows, "iterative_scan")
        conn = FakeConnection([])
        conn.cursor = lambda: cursor

        results = retrieval.retrieve_from_pgvector("q", conn, region="r")

        self.assertEqual([r["content"] for r in results], ["body"])
        statements = [sql.strip() for sql, _ in cursor.executed]
        self.assertIn("ROLLBACK TO SAVEPOINT retrieval_settings", statements)
        self.assertEqual(conn.rollbacks, 0)

    def test_respects_num_results_cap(self):
        rows = [_row(f"b{i}", f"https://x/{i}", f"T{i}", "web", 0.9 - i * 0.01) for i in range(10)]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector("q", conn, region="r", num_results=3, min_score=0.0)

        self.assertEqual(len(results), 3)

    def test_backfills_when_below_min_results(self):
        # All rows below min_score; backfill should still return min_results.
        rows = [
            _row("low1", "https://x/1", "T1", "web", 0.10),
            _row("low2", "https://x/2", "T2", "web", 0.05),
        ]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector(
            "q", conn, region="r", num_results=5, min_score=0.40, min_results=2
        )

        self.assertEqual(len(results), 2)
        self.assertEqual({r["url"] for r in results}, {"https://x/1", "https://x/2"})

    def test_video_source_type_uppercased(self):
        rows = [_row("clip", "https://yt/x", "Vid", "video", 0.7,
                     {"chunk_start": "00:00:01", "chunk_end": "00:00:09"})]
        conn = FakeConnection(rows)

        results = retrieval.retrieve_from_pgvector("q", conn, region="r", num_results=5)

        self.assertEqual(results[0]["type"], "VIDEO")
        self.assertEqual(results[0]["source_type"], "video")
        self.assertEqual(results[0]["metadata"]["chunk_start"], "00:00:01")

    def test_embedding_failure_returns_empty(self):
        self.mock_embed.side_effect = RuntimeError("bedrock unavailable")
        conn = FakeConnection([])

        results = retrieval.retrieve_from_pgvector("q", conn, region="r")

        self.assertEqual(results, [])

    def test_db_failure_returns_empty(self):
        conn = FailingConnection()
        results = retrieval.retrieve_from_pgvector("q", conn, region="r")
        self.assertEqual(results, [])
        # The aborted transaction is rolled back so the AI response can be saved.
        self.assertEqual(conn.rollbacks, 1)


class InternalUrlTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(retrieval, "embed_query", return_value=FAKE_EMBEDDING)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_internal_identities_are_blanked(self):
        rows = [
            _row("legacy", "s3://kb-bucket/uploads/document/1_h.pdf", "Handbook", "document", 0.9, source_id="s1"),
            _row("upload", "upload://document/guide.pdf", "Guide", "document", 0.85, source_id="s2"),
            _row("cache", "csvlink://https://fetch.example", "Cache", "csv_link", 0.8, source_id="s3"),
        ]
        results = retrieval.retrieve_from_pgvector("q", FakeConnection(rows), region="r", num_results=5)
        self.assertEqual([r["url"] for r in results], ["", "", ""])
        self.assertEqual([r["uri"] for r in results], ["", "", ""])
        self.assertEqual([r["title"] for r in results], ["Handbook", "Guide", "Cache"])

    def test_internal_url_is_not_used_as_title(self):
        rows = [_row("legacy", "s3://kb-bucket/key.pdf", None, "document", 0.9)]
        results = retrieval.retrieve_from_pgvector("q", FakeConnection(rows), region="r")
        self.assertEqual(results[0]["title"], "Untitled resource")

    def test_public_http_url(self):
        self.assertEqual(retrieval.public_http_url(" https://x.org/a "), "https://x.org/a")
        self.assertEqual(retrieval.public_http_url("http://x.org"), "http://x.org")
        for value in ("s3://b/k", "upload://document/a.pdf", "javascript:alert(1)", "https://", "", None, 5):
            self.assertEqual(retrieval.public_http_url(value), "")


class ToPublicSourceTests(unittest.TestCase):
    def test_keeps_only_rendered_fields(self):
        source = {
            "type": "CSV_ROW",
            "source_type": "csv_row",
            "url": "https://public.example/row",
            "uri": "https://public.example/row",
            "title": "Row",
            "content": "x" * 2000,
            "score": 0.91,
            "metadata": {
                "csv_row": {"columns": {"email": "someone@example.org"}, "fetch_url": "https://f"},
                "canonical_content_key": "csvlink://k",
            },
        }
        public = retrieval.to_public_source(source)
        self.assertEqual(set(public), {"type", "source_type", "title", "url", "uri", "content"})
        self.assertEqual(public["url"], "https://public.example/row")
        self.assertEqual(len(public["content"]), retrieval.PUBLIC_PREVIEW_CHARS + 1)
        self.assertTrue(public["content"].endswith("…"))

    def test_video_timestamps_kept(self):
        public = retrieval.to_public_source({
            "type": "VIDEO", "source_type": "video", "url": "https://yt/x", "title": "Vid",
            "content": "clip", "metadata": {"chunk_start": "00:00:01.000", "chunk_end": "00:00:09.000", "other": 1},
        })
        self.assertEqual(public["metadata"], {"chunk_start": "00:00:01.000", "chunk_end": "00:00:09.000"})

    def test_non_http_url_blanked(self):
        public = retrieval.to_public_source({"url": "s3://b/k", "title": "Doc", "content": "c"})
        self.assertEqual((public["url"], public["uri"]), ("", ""))


class VectorLiteralTests(unittest.TestCase):
    def test_vector_literal_format(self):
        self.assertEqual(retrieval._vector_literal([1.0, 2.5, 3.0]), "[1.0,2.5,3.0]")


if __name__ == "__main__":
    unittest.main()
