"""
Crawl provenance (migration 038): the crawler links the seed row and every page
row it writes to the owning website data source in web_source_owners, so
deleting the website removes them. No AWS, no database. Run from cdk/:

    py -3 -m unittest discover -s containers/tests -p "test_*.py"
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from test_embed_wiring import _load  # noqa: E402
from test_ingest_space_writes import TITAN_ROW, ScriptedConnection  # noqa: E402

OWNER_ID = "33333333-3333-4333-8333-333333333333"
JOB_ID = "44444444-4444-4444-8444-444444444444"


class RecordingConnection(ScriptedConnection):
    """ScriptedConnection that also records commits in statement order."""

    def commit(self):
        super().commit()
        self.executed.append(("COMMIT", None))


def _connection(script, source_ids):
    """RecordingConnection answering each `INSERT INTO sources` with the next id."""
    conn = RecordingConnection(script)
    ids = iter(source_ids)
    original_cursor = conn.cursor

    def cursor():
        cur = original_cursor()
        execute = cur.execute

        def scripted_execute(sql, params=None):
            execute(sql, params)
            if "INSERT INTO sources" in " ".join(sql.split()):
                cur._one = (next(ids),)

        cur.execute = scripted_execute
        return cur

    conn.cursor = cursor
    return conn


def _page(url, n_chunks=1):
    return {
        "url": url,
        "title": url,
        "chunks": [
            {"chunk_index": i, "content_hash": f"h{i}", "body": "b", "text": "t", "word_count": 1,
             "heading_path": "H"}
            for i in range(n_chunks)
        ],
    }


class CrawlerProvenanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load("kc_crawler_provenance_under_test", "crawler/crawler.py")

    def setUp(self):
        self.mod.ACTIVE_SPACE = dict(TITAN_ROW)
        self.addCleanup(setattr, self.mod, "ACTIVE_SPACE", None)

    def _write(self, conn, pages, job_id=JOB_ID, seed="https://example.org"):
        with mock.patch.object(self.mod, "get_db_connection", return_value=conn), \
                mock.patch.object(self.mod, "embed_texts", lambda texts, input_type="search_document": [[0.1] for _ in texts]), \
                mock.patch.object(self.mod, "delete_stale_chunks", return_value=0):
            self.mod.write_to_db(pages, seed, 5, 300, job_id=job_id)

    @staticmethod
    def _owner_writes(conn):
        return [(i, p) for i, (s, p) in enumerate(conn.executed) if "INSERT INTO web_source_owners" in s]

    def test_owner_from_the_job_run_is_stamped_on_seed_and_every_page_before_its_commit(self):
        conn = _connection({
            "to_regclass('public.web_source_owners')": ([], (True,)),
            "SELECT data_source_id FROM ingestion_runs": ([], (OWNER_ID,)),
            "UPDATE ingestion_runs": ([], (JOB_ID,)),
        }, ["seed-src", "page-a", "page-b"])
        self._write(conn, [_page("https://example.org/a"), _page("https://example.org/b", 2)])

        writes = self._owner_writes(conn)
        self.assertEqual([p for _, p in writes],
                         [("seed-src", OWNER_ID), ("page-a", OWNER_ID), ("page-b", OWNER_ID)])
        lookup = [p for s, p in conn.executed if "SELECT data_source_id FROM ingestion_runs" in s]
        self.assertEqual(lookup, [(JOB_ID,)])
        # Each owner insert follows its sources upsert and precedes the next commit.
        statements = [s for s, _ in conn.executed]
        for index, _ in writes:
            self.assertIn("INSERT INTO sources", statements[index - 1])
            self.assertIn("COMMIT", statements[index:])
            next_commit = statements.index("COMMIT", index)
            self.assertFalse(any("INSERT INTO sources" in s for s in statements[index + 1:next_commit]))
        # The website-by-name fallback is not needed when the run resolves.
        self.assertFalse(any("FROM data_sources" in s for s in statements))

    def test_without_a_job_id_the_website_is_found_by_seed_name(self):
        conn = _connection({
            "to_regclass('public.web_source_owners')": ([], (True,)),
            "FROM data_sources": ([], (OWNER_ID,)),
            "INSERT INTO ingestion_runs": ([], ("run-1",)),
        }, ["seed-src", "page-a"])
        self._write(conn, [_page("https://example.org/a")], job_id=None)

        self.assertFalse(any("SELECT data_source_id FROM ingestion_runs" in s for s, _ in conn.executed))
        sql, params = next((s, p) for s, p in conn.executed if "FROM data_sources" in s)
        self.assertIn("type = 'website'::data_source_type AND name = %s", sql)
        self.assertEqual(params, ("https://example.org",))
        self.assertEqual([p for _, p in self._owner_writes(conn)],
                         [("seed-src", OWNER_ID), ("page-a", OWNER_ID)])

    def test_missing_table_skips_stamping_and_still_writes_pages(self):
        conn = _connection({
            "to_regclass('public.web_source_owners')": ([], None),
            "UPDATE ingestion_runs": ([], (JOB_ID,)),
        }, ["seed-src", "page-a"])
        self._write(conn, [_page("https://example.org/a")])

        self.assertFalse(any("web_source_owners" in s and "to_regclass" not in s for s, _ in conn.executed))
        self.assertFalse(any("FROM data_sources" in s or "SELECT data_source_id" in s for s, _ in conn.executed))
        self.assertEqual(sum("INSERT INTO chunk_embeddings" in s for s, _ in conn.executed), 1)

    def test_table_present_but_false_is_treated_as_missing(self):
        conn = _connection({
            "to_regclass('public.web_source_owners')": ([], (False,)),
            "UPDATE ingestion_runs": ([], (JOB_ID,)),
        }, ["seed-src", "page-a"])
        self._write(conn, [_page("https://example.org/a")])
        self.assertEqual(self._owner_writes(conn), [])

    def test_no_resolvable_owner_means_no_stamping(self):
        conn = _connection({
            "to_regclass('public.web_source_owners')": ([], (True,)),
            "UPDATE ingestion_runs": ([], (JOB_ID,)),
        }, ["seed-src", "page-a"])
        self._write(conn, [_page("https://example.org/a")])
        self.assertEqual(self._owner_writes(conn), [])
        self.assertEqual(sum("INSERT INTO chunk_embeddings" in s for s, _ in conn.executed), 1)

    def test_record_source_owner_is_parameterized_and_refreshes_last_seen(self):
        conn = ScriptedConnection()
        self.mod.record_source_owner(conn, "src-1", OWNER_ID)
        sql, params = conn.executed[0]
        self.assertIn("VALUES (%s::uuid, %s::uuid)", sql)
        self.assertIn("ON CONFLICT (source_id, data_source_id) DO UPDATE SET last_seen_at = now()", sql)
        self.assertEqual(params, ("src-1", OWNER_ID))

    def test_provenance_lookups_are_parameterized(self):
        conn = ScriptedConnection({"SELECT data_source_id FROM ingestion_runs": ([], (OWNER_ID,))})
        self.assertEqual(self.mod.resolve_owning_data_source(conn, JOB_ID, "https://x.org'--"), OWNER_ID)
        sql, params = conn.executed[0]
        self.assertNotIn(JOB_ID, sql)
        self.assertEqual(params, (JOB_ID,))

        conn = ScriptedConnection()
        self.assertIsNone(self.mod.resolve_owning_data_source(conn, JOB_ID, "https://x.org'--"))
        sql, params = conn.executed[1]
        self.assertNotIn("x.org", sql)
        self.assertEqual(params, ("https://x.org'--",))


if __name__ == "__main__":
    unittest.main()
