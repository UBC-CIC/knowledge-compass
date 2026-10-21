"""
Shared behavior of the crawler and transcriber writers against embedding spaces
(migration 032): the active space is resolved from the database at startup,
vectors go to chunk_embeddings (never chunks.embedding), change detection
treats a missing/stale vector as changed, and the semantic split threshold
follows CLI > space > default.

Heavy third-party modules are stubbed (see test_embed_wiring._load). No AWS, no
database. Run from cdk/:

    py -3 -m unittest discover -s containers/tests -p "test_*.py"
"""

import asyncio
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from test_embed_wiring import FakeClient, _load  # noqa: E402

SPACE_ID = "22222222-2222-4222-8222-222222222222"
TITAN_ROW = {
    "id": SPACE_ID, "name": "titan-v2-512", "provider": "titan_v2", "model_id": "amazon.titan-embed-text-v2:0",
    "invoke_target": "amazon.titan-embed-text-v2:0", "dimensions": 512, "version": "1", "status": "active",
    "min_score": 0.3, "split_threshold": 0.42, "settings": {},
}


class ScriptedCursor:
    """Records statements; answers by SQL fragment."""

    def __init__(self, conn):
        self.conn = conn
        self._rows = []
        self._one = None
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        compact = " ".join(sql.split())
        self.conn.executed.append((compact, params))
        self._rows, self._one = [], None
        for fragment, (rows, one) in self.conn.script.items():
            if fragment in compact:
                self._rows, self._one = rows, one
                break

    def fetchall(self):
        return list(self._rows)

    def fetchone(self):
        return self._one


class ScriptedConnection:
    def __init__(self, script=None):
        self.script = script or {}
        self.executed = []
        self.commits = 0
        self.closed = False

    def cursor(self):
        return ScriptedCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def close(self):
        self.closed = True


def space_db_row(row=TITAN_ROW, settings=None):
    """Tuple in the column order of db_config.get_active_embedding_space's SELECT."""
    return (
        row["id"], row["name"], row["provider"], row["model_id"], row["invoke_target"], row["dimensions"],
        row["version"], row["status"], row["min_score"], row["split_threshold"], settings or row["settings"],
    )


class _IngestMixin:
    module_name = ""
    rel_path = ""
    default_threshold = 0.0
    text_key = "text"           # chunk key embedded and stored as embed_text

    @classmethod
    def setUpClass(cls):
        cls.mod = _load(cls.module_name, cls.rel_path)

    def setUp(self):
        self.mod.ACTIVE_SPACE = None
        self.mod.ACTIVE_SPEC = None
        self.addCleanup(setattr, self.mod, "ACTIVE_SPACE", None)
        self.addCleanup(setattr, self.mod, "ACTIVE_SPEC", None)

    def chunk(self, index=0, content_hash="h0", text="alpha beta"):
        chunk = {"chunk_index": index, "content_hash": content_hash, "body": text, "word_count": 2,
                 "heading_path": "H", "chunk_start": "00:00:01.000", "chunk_end": "00:00:09.000"}
        chunk[self.text_key] = text
        return chunk

    # ── space resolution ────────────────────────────────────────────────────

    def test_load_active_space_reads_the_database_and_sets_the_spec(self):
        conn = ScriptedConnection({"FROM embedding_active_space a": ([], space_db_row())})
        row = self.mod.load_active_space(conn)
        self.assertEqual((row["name"], row["dimensions"], row["split_threshold"]), ("titan-v2-512", 512, 0.42))
        self.assertIs(self.mod.ACTIVE_SPACE, row)
        self.assertEqual((self.mod.ACTIVE_SPEC.provider, self.mod.ACTIVE_SPEC.dimensions), ("titan_v2", 512))

    def test_missing_pointer_row_is_a_config_error(self):
        conn = ScriptedConnection({"FROM embedding_active_space a": ([], None)})
        with self.assertRaises(self.mod.db_config.ConfigError):
            self.mod.load_active_space(conn)
        self.assertIsNone(self.mod.ACTIVE_SPACE)

    def test_embed_texts_uses_the_active_spaces_model(self):
        self.mod.load_active_space(ScriptedConnection({"FROM embedding_active_space a": ([], space_db_row())}))
        calls = []

        class TitanClient:
            def invoke_model(self, **kwargs):
                import json
                calls.append(kwargs)
                body = json.loads(kwargs["body"])
                return {"body": mock.Mock(read=lambda: json.dumps({"embedding": [0.0] * body["dimensions"]}).encode())}

        with mock.patch.object(self.mod.shared_embeddings, "get_bedrock_client", return_value=TitanClient()):
            out = self.mod.embed_texts(["one", "two"])
        self.assertEqual(len(out), 2)
        self.assertEqual({c["modelId"] for c in calls}, {"amazon.titan-embed-text-v2:0"})
        self.assertEqual(len(calls), 2)  # Titan: one text per call

    def test_without_a_loaded_space_the_deprecated_env_fallback_applies(self):
        client = FakeClient()
        with mock.patch.object(self.mod.shared_embeddings, "get_bedrock_client", return_value=client):
            self.mod.embed_texts(["a"])
        self.assertEqual(client.calls[0][0]["modelId"], "cohere.embed-english-v3")

    def test_startup_resolution_is_skipped_when_not_needed(self):
        with mock.patch.object(self.mod, "get_db_connection", side_effect=AssertionError("no DB expected")):
            self.assertIsNone(self.mod.init_active_space(needed=False, write_db=False))

    def test_a_writing_run_fails_loudly_when_the_space_cannot_be_read(self):
        with mock.patch.object(self.mod, "get_db_connection", side_effect=RuntimeError("db down")):
            with self.assertRaises(RuntimeError):
                self.mod.init_active_space(needed=True, write_db=True)

    def test_a_crawl_only_run_falls_back_without_a_database(self):
        with mock.patch.object(self.mod, "get_db_connection", side_effect=RuntimeError("no db")):
            self.assertIsNone(self.mod.init_active_space(needed=True, write_db=False))

    def test_startup_resolution_loads_and_closes_the_connection(self):
        conn = ScriptedConnection({"FROM embedding_active_space a": ([], space_db_row())})
        with mock.patch.object(self.mod, "get_db_connection", return_value=conn):
            row = self.mod.init_active_space(needed=True, write_db=True)
        self.assertEqual(row["name"], "titan-v2-512")
        self.assertTrue(conn.closed)

    # ── threshold precedence ────────────────────────────────────────────────

    def test_threshold_precedence_cli_then_space_then_default(self):
        space = {"split_threshold": 0.42}
        self.assertEqual(self.mod.resolve_semantic_threshold(0.9, space), 0.9)
        self.assertEqual(self.mod.resolve_semantic_threshold(0.0, space), 0.0)   # explicit zero still wins
        self.assertEqual(self.mod.resolve_semantic_threshold(None, space), 0.42)
        self.assertEqual(self.mod.resolve_semantic_threshold(None, {"split_threshold": None}), self.default_threshold)
        self.assertEqual(self.mod.resolve_semantic_threshold(None, None), self.default_threshold)

    # ── change detection and writes ────────────────────────────────────────

    def test_existing_chunk_query_is_scoped_to_the_space_and_checks_the_hash(self):
        conn = ScriptedConnection({"FROM chunks c LEFT JOIN": ([(0, "h0", True), (1, "h1", False), (2, "h2", None)], None)})
        result = self.mod.get_existing_chunk_hashes(conn, "src-1", SPACE_ID)
        self.assertEqual(result, {0: ("h0", True), 1: ("h1", False), 2: ("h2", False)})
        sql, params = conn.executed[0]
        self.assertIn("LEFT JOIN chunk_embeddings ce", sql)
        self.assertIn("ce.space_id = %s::uuid", sql)
        self.assertIn("ce.embed_hash = md5(c.embed_text)", sql)
        self.assertEqual(params, (SPACE_ID, "src-1"))

    def test_change_detection_treats_a_missing_or_stale_vector_as_changed(self):
        existing = {0: ("h0", True), 1: ("h1", False), 2: ("old", True)}
        changed = [c for c in (self.chunk(0, "h0"), self.chunk(1, "h1"), self.chunk(2, "new"), self.chunk(3, "h3"))
                   if self.mod.needs_embedding(c, existing)]
        self.assertEqual([c["chunk_index"] for c in changed], [1, 2, 3])
        self.assertFalse(self.mod.needs_embedding(self.chunk(0, "h0"), existing))

    def test_upsert_writes_the_chunk_without_a_vector_column_and_the_vector_with_md5(self):
        conn = ScriptedConnection()
        self.mod.upsert_chunk(conn, "src-1", self.chunk(), [0.5, 0.25], SPACE_ID)
        sql, params = conn.executed[0]
        columns = sql.split("INSERT INTO chunks (")[1].split(")")[0]
        self.assertNotIn("embedding", columns.replace("embed_text", ""))
        self.assertIn("RETURNING id, embed_text", sql)
        self.assertIn("INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)", sql)
        self.assertIn("md5(embed_text)", sql)
        self.assertIn("ON CONFLICT (chunk_id, space_id) DO UPDATE", sql)
        self.assertEqual(params[-2:], (SPACE_ID, "[0.5,0.25]"))
        # The stored embed_text is the string that was embedded (before truncation).
        self.assertEqual(params[3], "alpha beta")

    def test_embedded_text_and_stored_embed_text_are_the_same_value(self):
        chunk = self.chunk(text="exactly this text")
        self.assertEqual(chunk[self.text_key], "exactly this text")
        conn = ScriptedConnection()
        self.mod.upsert_chunk(conn, "src-1", chunk, [0.1], SPACE_ID)
        self.assertEqual(conn.executed[0][1][3], chunk[self.text_key])


class CrawlerSpaceTests(_IngestMixin, unittest.TestCase):
    module_name = "kc_crawler_space_under_test"
    rel_path = "crawler/crawler.py"
    default_threshold = 0.6
    text_key = "text"

    def test_write_to_db_embeds_only_changed_or_unvectored_chunks_in_the_active_space(self):
        self.mod.ACTIVE_SPACE = dict(TITAN_ROW)
        page = {"url": "https://example.org/a", "title": "A", "chunks": [
            self.chunk(0, "same", "unchanged text"), self.chunk(1, "same1", "missing vector text"), self.chunk(2, "new2", "new text"),
        ]}
        conn = ScriptedConnection({
            "INSERT INTO sources": ([], ("src-1",)),
            "INSERT INTO ingestion_runs": ([], ("run-1",)),
            "FROM chunks c LEFT JOIN": ([(0, "same", True), (1, "same1", False), (2, "old2", True)], None),
        })
        embedded = []

        def fake_embed(texts, input_type="search_document"):
            embedded.extend(texts)
            return [[0.5] * 4 for _ in texts]

        with mock.patch.object(self.mod, "get_db_connection", return_value=conn), \
                mock.patch.object(self.mod, "embed_texts", fake_embed), \
                mock.patch.object(self.mod, "delete_stale_chunks", return_value=0):
            self.mod.write_to_db([page], "https://example.org", 5, 300)
        self.assertEqual(embedded, ["missing vector text", "new text"])
        upserts = [p for s, p in conn.executed if "INSERT INTO chunk_embeddings" in s]
        self.assertEqual(len(upserts), 2)
        self.assertTrue(all(SPACE_ID in p for p in upserts))
        lookups = [p for s, p in conn.executed if "FROM chunks c LEFT JOIN" in s]
        self.assertEqual(lookups, [(SPACE_ID, "src-1")])

    def test_upsert_source_refreshes_only_a_row_of_the_same_type(self):
        conn = ScriptedConnection({"INSERT INTO sources": ([], ("src-1",))})
        self.assertEqual(self.mod.upsert_source(conn, "https://example.org/a", "A"), "src-1")
        sql = conn.executed[0][0]
        self.assertIn("WHERE sources.source_type = EXCLUDED.source_type", sql)
        self.assertNotIn("source_type = EXCLUDED.source_type", sql.split("WHERE", 1)[0])

    def test_upsert_source_returns_none_when_the_url_belongs_to_another_type(self):
        conn = ScriptedConnection()
        self.assertIsNone(self.mod.upsert_source(conn, "https://example.org/a", "A"))

    def test_write_to_db_skips_a_page_whose_url_is_not_web_without_deleting_chunks(self):
        self.mod.ACTIVE_SPACE = dict(TITAN_ROW)
        conn = ScriptedConnection({
            "to_regclass('public.web_source_owners')": ([], None),
            "INSERT INTO ingestion_runs": ([], ("run-1",)),
        })
        ids = iter([("seed-src",), None])
        original_cursor = conn.cursor

        def cursor():
            cur = original_cursor()
            execute = cur.execute

            def scripted_execute(sql, params=None):
                execute(sql, params)
                if "INSERT INTO sources" in " ".join(sql.split()):
                    cur._one = next(ids)

            cur.execute = scripted_execute
            return cur

        conn.cursor = cursor
        page = {"url": "https://example.org/taken", "title": "Taken", "chunks": [self.chunk(0, "h", "body")]}
        with mock.patch.object(self.mod, "get_db_connection", return_value=conn), \
                mock.patch.object(self.mod, "embed_texts") as embed, \
                mock.patch.object(self.mod, "delete_stale_chunks") as delete:
            self.mod.write_to_db([page], "https://example.org", 5, 300)
        embed.assert_not_called()
        delete.assert_not_called()
        self.assertFalse(any("DELETE FROM chunks" in sql for sql, _ in conn.executed))

    def test_write_to_db_refuses_a_seed_that_belongs_to_an_upload(self):
        self.mod.ACTIVE_SPACE = dict(TITAN_ROW)
        conn = ScriptedConnection({"to_regclass('public.web_source_owners')": ([], None)})
        with mock.patch.object(self.mod, "get_db_connection", return_value=conn), \
                mock.patch.object(self.mod, "delete_stale_chunks") as delete:
            with self.assertRaises(RuntimeError) as raised:
                self.mod.write_to_db([], "https://example.org/video", 5, 300)
        self.assertIn("uploaded source", str(raised.exception))
        delete.assert_not_called()

    def test_write_to_db_resolves_the_space_when_none_was_loaded_at_startup(self):
        conn = ScriptedConnection({
            "FROM embedding_active_space a": ([], space_db_row()),
            "INSERT INTO sources": ([], ("src-1",)),
            "INSERT INTO ingestion_runs": ([], ("run-1",)),
        })
        with mock.patch.object(self.mod, "get_db_connection", return_value=conn):
            self.mod.write_to_db([], "https://example.org", 5, 300)
        self.assertEqual(self.mod.ACTIVE_SPACE["id"], SPACE_ID)

    def _run_main(self, argv, space):
        seen = {}

        async def fake_crawl(seed_url, max_pages, max_words, use_semantic=False, semantic_threshold=0.6):
            seen["threshold"] = semantic_threshold
            return [], set()

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sys, "argv", ["crawler.py", "https://example.org", "--output", os.path.join(tmp, "o.json")] + argv), \
                mock.patch.object(self.mod, "init_active_space", return_value=space) as init, \
                mock.patch.object(self.mod, "crawl", fake_crawl):
            self.mod.main()
        return seen, init

    def test_main_resolves_the_space_before_crawling_and_uses_its_split_threshold(self):
        seen, init = self._run_main(["--semantic"], dict(TITAN_ROW))
        init.assert_called_once_with(needed=True, write_db=False)
        self.assertEqual(seen["threshold"], 0.42)

    def test_main_cli_threshold_wins_over_the_space(self):
        seen, _ = self._run_main(["--semantic", "--semantic-threshold", "0.9"], dict(TITAN_ROW))
        self.assertEqual(seen["threshold"], 0.9)

    def test_main_falls_back_to_the_default_without_a_space(self):
        seen, _ = self._run_main([], None)
        self.assertEqual(seen["threshold"], 0.6)

    def test_main_does_not_touch_the_database_for_a_plain_crawl(self):
        _, init = self._run_main([], None)
        init.assert_called_once_with(needed=False, write_db=False)


class TranscriberSpaceTests(_IngestMixin, unittest.TestCase):
    module_name = "kc_transcriber_space_under_test"
    rel_path = "transcriber/transcrbe.py"
    default_threshold = 0.5
    text_key = "embed_text"

    def test_write_to_db_embeds_only_changed_or_unvectored_chunks_in_the_active_space(self):
        self.mod.ACTIVE_SPACE = dict(TITAN_ROW)
        chunks = [self.chunk(0, "same", "unchanged text"), self.chunk(1, "same1", "missing vector text")]
        conn = ScriptedConnection({
            "INSERT INTO sources": ([], ("src-1",)),
            "INSERT INTO ingestion_runs": ([], ("run-1",)),
            "FROM chunks c LEFT JOIN": ([(0, "same", True), (1, "same1", False)], None),
        })
        embedded = []

        def fake_embed(texts, input_type="search_document"):
            embedded.extend(texts)
            return [[0.5] * 4 for _ in texts]

        with mock.patch.object(self.mod, "get_db_connection", return_value=conn), \
                mock.patch.object(self.mod, "embed_texts", fake_embed), \
                mock.patch.object(self.mod, "delete_stale_chunks", return_value=0):
            self.mod.write_to_db(chunks, "https://youtube.com/watch?v=x", "Video")
        self.assertEqual(embedded, ["missing vector text"])
        upserts = [p for s, p in conn.executed if "INSERT INTO chunk_embeddings" in s]
        self.assertEqual(len(upserts), 1)
        self.assertIn(SPACE_ID, upserts[0])

    def test_upsert_source_updates_only_video_rows(self):
        conn = ScriptedConnection({"INSERT INTO sources": ([], ("src-1",))})
        self.assertEqual(self.mod.upsert_source(conn, "https://youtu.be/x", "Talk"), "src-1")
        sql = conn.executed[0][0]
        self.assertIn("WHERE sources.source_type = 'video'::source_type", sql)

    def test_upsert_source_aborts_when_the_url_is_not_a_video(self):
        conn = ScriptedConnection()
        with self.assertRaises(RuntimeError) as raised:
            self.mod.upsert_source(conn, "https://example.org/page", "Talk")
        self.assertIn("non-video", str(raised.exception))

    def test_write_to_db_does_not_delete_chunks_when_the_url_is_not_a_video(self):
        self.mod.ACTIVE_SPACE = dict(TITAN_ROW)
        conn = ScriptedConnection()
        with mock.patch.object(self.mod, "get_db_connection", return_value=conn), \
                mock.patch.object(self.mod, "embed_texts") as embed, \
                mock.patch.object(self.mod, "delete_stale_chunks") as delete:
            with self.assertRaises(RuntimeError):
                self.mod.write_to_db([self.chunk()], "https://example.org/page", "Talk")
        embed.assert_not_called()
        delete.assert_not_called()
        self.assertFalse(any("DELETE FROM chunks" in sql for sql, _ in conn.executed))
        self.assertEqual(conn.commits, 0)

    def _run_main(self, argv, space):
        seen = {}

        def fake_chunk_segments(segments, video_name, video_url, **kwargs):
            seen["threshold"] = kwargs["semantic_threshold"]
            return []

        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(sys, "argv", ["transcrbe.py", "t.json", "https://youtube.com/watch?v=x",
                                                "--output", os.path.join(tmp, "o.json")] + argv), \
                mock.patch.object(self.mod, "init_active_space", return_value=space) as init, \
                mock.patch.object(self.mod, "resolve_transcript_path", side_effect=lambda p: p), \
                mock.patch.object(self.mod, "parse_transcribe_json", return_value=[]), \
                mock.patch.object(self.mod, "chunk_segments", fake_chunk_segments):
            self.mod.main()
        return seen, init

    def test_main_uses_the_spaces_split_threshold_and_resolves_it_once_up_front(self):
        seen, init = self._run_main(["--semantic"], dict(TITAN_ROW))
        init.assert_called_once_with(needed=True, write_db=False)
        self.assertEqual(seen["threshold"], 0.42)

    def test_main_cli_threshold_wins_over_the_space(self):
        seen, _ = self._run_main(["--semantic", "--semantic-threshold", "0.8"], dict(TITAN_ROW))
        self.assertEqual(seen["threshold"], 0.8)

    def test_main_falls_back_to_the_speech_default_without_a_space(self):
        seen, _ = self._run_main([], None)
        self.assertEqual(seen["threshold"], 0.5)
        self.assertEqual(self.mod.SEMANTIC_THRESHOLD_VTT, 0.5)


if __name__ == "__main__":
    unittest.main()
