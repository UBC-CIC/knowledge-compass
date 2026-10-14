"""
How process_document_batch hands a CSV run to the link phase: a CSV without
url_column is finished exactly as before, one with links is left for
process_csv_links to finalize, and a link-phase error never fails the CSV.

Run from the knowledgeBase dir:

    pytest tests
"""

import io
import os
import re
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import process_document_batch as batch  # noqa: E402
from helpers.embedding_space import ActiveSpace  # noqa: E402

LEGACY_ID = "11111111-1111-4111-8111-111111111111"
ACTIVE_ID = "22222222-2222-4222-8222-222222222222"


def make_space(space_id=ACTIVE_ID, name="titan-v2-512", provider="titan_v2", dimensions=512,
               invoke_target="amazon.titan-embed-text-v2:0"):
    return ActiveSpace(id=space_id, name=name, provider=provider, invoke_target=invoke_target,
                       dimensions=dimensions, status="active")


SPACE = make_space()

CSV_BYTES = (
    "name,website,notes\n"
    + "".join(
        f"Program {i},https://p{i}.example/,"
        f"Supports families with planning meetings and inclusive classroom resources {i}\n"
        for i in range(30)
    )
).encode()


def csv_run(**metadata):
    return {
        "ingestion_run_id": "run-1",
        "data_source_id": "ds-1",
        "name": "programs.csv",
        "type": "csv",
        "metadata": {"s3_bucket": "b", "s3_key": "k.csv", "source_url": "upload://csv/programs.csv", **metadata},
        "run_metadata": {"sync_session_id": "sess"},
    }


class CsvRunTests(unittest.TestCase):
    def process(self, run, link_result=None, link_error=None):
        connection = mock.MagicMock()
        s3 = mock.Mock()
        s3.get_object.return_value = {"Body": io.BytesIO(CSV_BYTES)}
        link = mock.Mock(return_value=link_result, side_effect=link_error)
        with mock.patch.object(batch, "_running_document_runs", return_value=[run]), \
                mock.patch.object(batch, "s3_client", s3), \
                mock.patch.object(batch, "_load_companion_metadata", return_value={}), \
                mock.patch.object(batch, "_upsert_source", return_value="src-1"), \
                mock.patch.object(batch, "write_chunks",
                                  return_value={"written": 4, "embedded": 4, "deleted": 0}) as write, \
                mock.patch.object(batch, "_finish_run") as finish, \
                mock.patch.object(batch, "start_link_phase", link):
            result = batch.process_document_batch({}, connection)
        return result, write, finish, link

    def test_csv_without_url_column_finishes_as_before(self):
        result, write, finish, link = self.process(csv_run(), link_result={"deferred": False, "metadata": {}})
        self.assertEqual(result["completed"], ["run-1"])
        # Same chunks as the plain CSV chunker produces: the link column stays literal text.
        self.assertEqual(write.call_args.args[2], batch._chunk_csv(CSV_BYTES))
        self.assertIn("website: https://p0.example/", write.call_args.args[2][0]["text"])
        finish.assert_called_once()
        self.assertEqual(finish.call_args.args[2], "completed")
        self.assertEqual(finish.call_args.kwargs["metadata"], {})
        self.assertEqual(finish.call_args.kwargs["chunks_upserted"], 4)

    def test_csv_with_links_is_left_running_for_the_link_worker(self):
        result, _, finish, link = self.process(
            csv_run(url_column="website"), link_result={"deferred": True, "metadata": {}}
        )
        self.assertEqual(result["completed"], ["run-1"])
        finish.assert_not_called()
        self.assertEqual(link.call_args.kwargs["raw_bytes"], CSV_BYTES)
        self.assertEqual(link.call_args.kwargs["chunks_upserted"], 4)

    def test_link_phase_error_does_not_fail_the_csv(self):
        result, _, finish, _ = self.process(csv_run(url_column="website"), link_error=RuntimeError("db hiccup"))
        self.assertEqual(result["completed"], ["run-1"])
        self.assertEqual(result["failed"], [])
        self.assertEqual(finish.call_args.args[2], "completed")
        self.assertIn("link crawl failed", finish.call_args.kwargs["metadata"]["link_error"])


class ChunkPersistenceTests(unittest.TestCase):
    def chunk(self, metadata):
        return {
            "chunk_index": 0,
            "heading_path": "Row",
            "text": "same embedded text",
            "body": "same embedded text",
            "word_count": 3,
            "content_hash": "hash",
            "metadata": metadata,
        }

    def test_metadata_only_change_reuses_existing_vector(self):
        chunk = self.chunk({"citation_url": "https://new.example"})
        old_state = (
            chunk["content_hash"],
            batch._embed_text_md5(chunk),
            batch._metadata_state({"heading_path": "Row", "citation_url": "https://old.example"}),
        )
        reuse_key = (chunk["content_hash"], batch._embed_text_md5(chunk))
        with mock.patch.object(batch, "_existing_chunk_states", return_value={0: old_state}), \
                mock.patch.object(batch, "_reusable_embeddings", return_value={reuse_key: "[0.1]"}), \
                mock.patch.object(batch, "_globally_reusable_embeddings", return_value={}), \
                mock.patch.object(batch, "_embed_texts") as embed, \
                mock.patch.object(batch, "_upsert_chunk") as upsert, \
                mock.patch.object(batch, "_delete_stale_chunks", return_value=0):
            result = batch.write_chunks(mock.Mock(), "source", [chunk], space=SPACE)
        embed.assert_not_called()
        upsert.assert_called_once()
        self.assertEqual(result, {"written": 1, "embedded": 0, "deleted": 0})

    def test_multi_source_writer_deduplicates_identical_inputs(self):
        first = self.chunk({"citation_url": "https://one.example"})
        second = self.chunk({"citation_url": "https://two.example"})
        with mock.patch.object(batch, "_existing_chunk_states", return_value={}), \
                mock.patch.object(batch, "_reusable_embeddings", return_value={}), \
                mock.patch.object(batch, "_globally_reusable_embeddings", return_value={}), \
                mock.patch.object(batch, "_embed_texts", return_value=[[0.1]]) as embed, \
                mock.patch.object(batch, "_upsert_chunk") as upsert, \
                mock.patch.object(batch, "_delete_stale_chunks", return_value=0):
            result = batch.write_chunk_sets(mock.Mock(), [("one", [first]), ("two", [second])], space=SPACE)
        embed.assert_called_once_with(["same embedded text"], SPACE.spec)
        self.assertEqual(upsert.call_count, 2)
        self.assertEqual([c.args[-1] for c in upsert.call_args_list], [ACTIVE_ID, ACTIVE_ID])
        self.assertEqual(result, {"written": 2, "embedded": 1, "deleted": 0})

    def test_space_is_resolved_once_per_call(self):
        first = self.chunk({})
        second = dict(self.chunk({}), chunk_index=1)
        with mock.patch.object(batch, "resolve_active_space", return_value=SPACE) as resolve, \
                mock.patch.object(batch, "_existing_chunk_states", return_value={}), \
                mock.patch.object(batch, "_reusable_embeddings", return_value={}), \
                mock.patch.object(batch, "_globally_reusable_embeddings", return_value={}), \
                mock.patch.object(batch, "_embed_texts", return_value=[[0.1]]), \
                mock.patch.object(batch, "_upsert_chunk"), \
                mock.patch.object(batch, "_delete_stale_chunks", return_value=0):
            batch.write_chunk_sets(mock.Mock(), [("one", [first]), ("two", [second])])
        resolve.assert_called_once()


class ScriptedCursor:
    """
    Records every statement and emulates only what the space-scoping tests
    need: vectors exist in `vectors_by_space`; a reuse query returns the ones
    for the space_id it was given (params[0]), as Postgres would.
    """

    def __init__(self, conn):
        self.conn = conn
        self._rows = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((" ".join(sql.split()), params))
        self._rows = []
        compact = " ".join(sql.split())
        if "FROM chunks c JOIN chunk_embeddings ce" in compact and "SELECT DISTINCT ON" in compact:
            space_id = params[0]
            self._rows = list(self.conn.vectors_by_space.get(space_id, []))
        elif "SELECT c.chunk_index, c.content_hash" in compact:
            space_id = params[0]
            self._rows = list(self.conn.states_by_space.get(space_id, []))

    def fetchall(self):
        return self._rows


class ScriptedConnection:
    def __init__(self, vectors_by_space=None, states_by_space=None):
        self.vectors_by_space = vectors_by_space or {}
        self.states_by_space = states_by_space or {}
        self.executed = []

    def cursor(self):
        return ScriptedCursor(self)


class SpaceScopedWriterTests(unittest.TestCase):
    TEXT = "same embedded text"

    def chunk(self, **overrides):
        base = {"chunk_index": 0, "heading_path": "Row", "text": self.TEXT, "body": self.TEXT,
                "word_count": 3, "content_hash": "hash", "metadata": {}}
        base.update(overrides)
        return base

    def write(self, connection, space=SPACE, chunks=None, embed_result=None):
        embed = mock.Mock(return_value=embed_result or [[0.5, 0.25]])
        with mock.patch.object(batch, "_embed_texts", embed), \
                mock.patch.object(batch, "_delete_stale_chunks", return_value=0):
            result = batch.write_chunk_sets(connection, [("src-1", chunks or [self.chunk()])], space=space)
        return result, embed

    def test_another_spaces_vector_is_never_reused(self):
        chunk = self.chunk()
        key_row = (chunk["content_hash"], batch._embed_text_md5(chunk), "[9.0,9.0]")
        # A current-hash vector exists for the legacy space only.
        connection = ScriptedConnection(vectors_by_space={LEGACY_ID: [key_row]})
        result, embed = self.write(connection)
        embed.assert_called_once_with([self.TEXT], SPACE.spec)       # embedded fresh in the active space
        self.assertEqual(result, {"written": 1, "embedded": 1, "deleted": 0})
        # Every read query is scoped to the active space id.
        reads = [params for sql, params in connection.executed if sql.startswith("SELECT")]
        self.assertTrue(reads)
        for params in reads:
            self.assertEqual(params[0], ACTIVE_ID)
        # ...and the written vector row carries the active space id, not the legacy one.
        upsert = [params for sql, params in connection.executed if "INSERT INTO chunk_embeddings" in sql][0]
        self.assertIn(ACTIVE_ID, upsert)
        self.assertNotIn(LEGACY_ID, upsert)
        self.assertIn("[0.5,0.25]", upsert)

    def test_the_active_spaces_own_vector_is_reused(self):
        chunk = self.chunk()
        key_row = (chunk["content_hash"], batch._embed_text_md5(chunk), "[7.0,7.0]")
        connection = ScriptedConnection(vectors_by_space={ACTIVE_ID: [key_row]})
        # Changed metadata so the chunk is rewritten but its vector reused.
        result, embed = self.write(connection, chunks=[self.chunk(metadata={"citation_url": "https://x.example"})])
        embed.assert_not_called()
        self.assertEqual(result["embedded"], 0)
        upsert = [params for sql, params in connection.executed if "INSERT INTO chunk_embeddings" in sql][0]
        self.assertIn("[7.0,7.0]", upsert)

    def test_unchanged_text_with_missing_vector_is_re_embedded(self):
        chunk = self.chunk()
        state = (chunk["content_hash"], batch._embed_text_md5(chunk), batch._metadata_state(batch._chunk_metadata(chunk)))
        # The stored chunk matches the incoming one and has a current vector in the LEGACY space only.
        connection = ScriptedConnection(states_by_space={LEGACY_ID: [(0,) + state[:2] + ({"heading_path": "Row"},)]})
        result, embed = self.write(connection)
        embed.assert_called_once()
        self.assertEqual(result["written"], 1)

    def test_unchanged_text_with_a_current_vector_is_left_alone(self):
        chunk = self.chunk()
        connection = ScriptedConnection(states_by_space={
            ACTIVE_ID: [(0, chunk["content_hash"], batch._embed_text_md5(chunk), {"heading_path": "Row"})]
        })
        result, embed = self.write(connection)
        embed.assert_not_called()
        self.assertEqual(result, {"written": 0, "embedded": 0, "deleted": 0})
        self.assertFalse([1 for sql, _ in connection.executed if "INSERT" in sql])

    def test_state_and_reuse_queries_join_on_the_hash(self):
        connection = ScriptedConnection()
        self.write(connection)
        selects = [sql for sql, _ in connection.executed if sql.startswith("SELECT")]
        self.assertEqual(len(selects), 3)  # states, source-local reuse, global reuse
        for sql in selects:
            self.assertIn("ce.space_id = %s::uuid", sql)
            self.assertIn("ce.embed_hash = md5(c.embed_text)", sql)
            self.assertNotIn("c.embedding", sql)

    def test_fresh_embed_writes_the_chunk_without_a_vector_column_and_the_vector_with_md5(self):
        connection = ScriptedConnection()
        self.write(connection)
        sql, params = [(s, p) for s, p in connection.executed if "INSERT INTO chunks" in s][0]
        columns = re.search(r"INSERT INTO chunks \(([^)]*)\)", sql).group(1)
        self.assertNotIn("embedding", columns.replace("embed_text", ""))
        self.assertNotIn("embedding = EXCLUDED.embedding", sql.split("RETURNING")[0])
        self.assertIn("RETURNING id, embed_text", sql)
        self.assertIn("INSERT INTO chunk_embeddings (chunk_id, space_id, embedding, embed_hash, embedded_at)", sql)
        self.assertIn("md5(embed_text)", sql)
        self.assertIn("ON CONFLICT (chunk_id, space_id) DO UPDATE", sql)
        self.assertEqual(params[-2:], (ACTIVE_ID, "[0.5,0.25]"))

    def test_embedding_uses_the_spaces_model_and_truncation(self):
        long_text = ("word " * 3000).strip()  # longer than Titan's 8000-char default cut
        chunk = self.chunk(text=long_text, body=long_text)
        connection = ScriptedConnection()
        _, embed = self.write(connection, chunks=[chunk])
        sent = embed.call_args.args[0][0]
        self.assertEqual(sent, long_text[:8000].rsplit(" ", 1)[0])
        self.assertEqual(embed.call_args.args[1].provider, "titan_v2")

    def test_other_ingestion_modules_only_go_through_the_shared_writers(self):
        helpers_dir = os.path.join(os.path.dirname(__file__), "..", "helpers")
        for name, expected in (("process_csv_links.py", "write_chunk_sets"), ("guideline_document.py", "write_chunks")):
            with open(os.path.join(helpers_dir, name), encoding="utf-8") as handle:
                source = handle.read()
            imported = re.search(r"from helpers\.process_document_batch import (\([^)]*\)|[^\n]*)", source)
            self.assertIsNotNone(imported, name)
            self.assertRegex(imported.group(1), r"\b" + expected + r"\b", name)
            self.assertNotIn("INSERT INTO chunks", source, name)
            self.assertNotIn("embed_documents", source, name)

    def test_no_helper_writes_the_legacy_embedding_column(self):
        helpers_dir = os.path.join(os.path.dirname(__file__), "..", "helpers")
        for name in sorted(os.listdir(helpers_dir)):
            if not name.endswith(".py"):
                continue
            with open(os.path.join(helpers_dir, name), encoding="utf-8") as handle:
                source = handle.read()
            for match in re.finditer(r"INSERT INTO chunks\s*\(([^)]*)\)", source):
                self.assertNotRegex(match.group(1).replace("embed_text", ""), r"\bembedding\b", name)
            self.assertNotRegex(source, r"UPDATE chunks\s+SET[^;\"]*\bembedding\s*=", name)


if __name__ == "__main__":
    unittest.main()
