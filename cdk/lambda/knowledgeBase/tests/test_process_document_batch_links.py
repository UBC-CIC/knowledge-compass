"""
How process_document_batch hands a CSV run to the link phase: a CSV without
url_column is finished exactly as before, one with links is left for
process_csv_links to finalize, and a link-phase error never fails the CSV.

Run from the knowledgeBase dir:

    pytest tests
"""

import io
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import process_document_batch as batch  # noqa: E402

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
            result = batch.write_chunks(mock.Mock(), "source", [chunk])
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
            result = batch.write_chunk_sets(mock.Mock(), [("one", [first]), ("two", [second])])
        embed.assert_called_once_with(["same embedded text"])
        self.assertEqual(upsert.call_count, 2)
        self.assertEqual(result, {"written": 2, "embedded": 1, "deleted": 0})


if __name__ == "__main__":
    unittest.main()
