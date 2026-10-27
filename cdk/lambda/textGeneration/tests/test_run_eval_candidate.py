"""Candidate-comparison pipeline of tests/eval/run_eval.py with fake embeddings and an in-memory snapshot."""

import importlib.util
import os
import sys
import unittest

_TG = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _TG)
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from kc_shared import embeddings  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "run_eval_candidate_under_test", os.path.join(_TG, "tests", "eval", "run_eval.py")
)
run_eval = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run_eval)

DIMS = 64
SPEC = embeddings.spec_from_row({"provider": "titan_v2", "invoke_target": "fake-model", "dimensions": 512})


def _bag_of_words(text):
    """Deterministic fake embedding: hash each word into one of DIMS buckets."""
    vector = [0.0] * DIMS
    for word in text.lower().split():
        vector[sum(ord(c) for c in word) % DIMS] += 1.0
    return vector


def fake_embed_documents(texts, spec, region=None):
    return [_bag_of_words(t) for t in texts]


def fake_embed_query(text, spec, region=None):
    return _bag_of_words(text)


def _chunk(chunk_id, text, source_id=None, canonical=None):
    return {
        "id": chunk_id, "embed_text": text, "content": text, "title": f"Title {chunk_id}",
        "url": f"https://example.org/{chunk_id}", "source_type": "web",
        "source_id": source_id or f"src-{chunk_id}", "canonical_key": canonical,
    }


CHUNKS = [
    _chunk("c1", "zebra giraffe lion savanna"),
    _chunk("c2", "partial day attendance reduced schedule meeting notes"),
    _chunk("c3", "bread flour yeast oven"),
    _chunk("c4", "passport renewal office forms"),
]

QUESTIONS = [
    {"id": "pos", "question": "partial day attendance reduced schedule",
     "expected": [], "expected_topics": ["partial day", "reduced schedule"]},
    {"id": "nm", "kind": "near_miss", "question": "bread oven", "expected": [], "expected_topics": []},
    {"id": "ot", "kind": "off_topic", "question": "xyzzy plugh", "expected": [], "expected_topics": []},
]


def _run(**kwargs):
    defaults = dict(
        name="fake", spec=SPEC, chunks=CHUNKS, questions=QUESTIONS, k_values=(1, 5), num_results=3,
        embed_documents_fn=fake_embed_documents, embed_query_fn=fake_embed_query,
    )
    defaults.update(kwargs)
    return run_eval.run_candidate(**defaults)


class RunCandidateTests(unittest.TestCase):
    def test_planted_relevant_chunk_ranks_first(self):
        report = _run()
        by_id = {q["id"]: q for q in report["per_question"]}
        self.assertEqual(by_id["pos"]["rank"], 1)
        self.assertEqual(report["summary"]["recall@1"], 1.0)
        self.assertEqual(report["summary"]["mrr"], 1.0)

    def test_report_only_kinds_are_not_scored(self):
        report = _run()
        self.assertEqual(report["summary"]["questions"], 1)
        self.assertEqual(report["summary"]["report_only_questions"], 2)
        by_id = {q["id"]: q for q in report["per_question"]}
        self.assertIsNone(by_id["nm"]["rank"])
        self.assertIsNotNone(by_id["nm"]["top_score"])
        self.assertEqual(report["score_distribution"]["near_miss"]["count"], 1)
        self.assertEqual(report["score_distribution"]["off_topic"]["count"], 1)

    def test_storage_tokens_and_unconfigured_price(self):
        report = _run()
        summary = report["summary"]
        self.assertEqual(summary["storage_bytes_estimate"], len(CHUNKS) * 512 * 4)
        expected_chars = sum(len(c["embed_text"]) for c in CHUNKS)
        self.assertEqual(summary["estimated_tokens"], -(-expected_chars // 4))
        self.assertEqual(summary["estimated_cost_usd"], "price not configured")

    def test_cost_when_price_is_configured(self):
        report = _run(price_per_1m_tokens=1000000.0)
        self.assertEqual(report["summary"]["estimated_cost_usd"], float(report["summary"]["estimated_tokens"]))

    def test_tokens_cap_each_text_at_max_chars(self):
        long_chunk = _chunk("long", "word " * 10000)
        tokens = run_eval.estimate_tokens([long_chunk], SPEC)
        self.assertEqual(tokens, -(-SPEC.max_chars // 4))

    def test_documents_embedded_in_batches(self):
        calls = []

        def recording(texts, spec, region=None):
            calls.append(len(texts))
            return fake_embed_documents(texts, spec, region)

        _run(embed_documents_fn=recording, doc_batch=3)
        self.assertEqual(calls, [3, 1])

    def test_query_latency_fields_present(self):
        summary = _run()["summary"]
        self.assertIn("query_embed_p50_ms", summary)
        self.assertIn("query_embed_p95_ms", summary)

    def test_report_has_no_chunk_text(self):
        report = _run()
        blob = repr(report)
        for chunk in CHUNKS:
            self.assertNotIn(chunk["embed_text"], blob)


class RankChunksTests(unittest.TestCase):
    def test_dedupes_by_source_and_canonical_key(self):
        chunks = [
            _chunk("a", "alpha beta", source_id="s1"),
            _chunk("b", "alpha beta gamma", source_id="s1"),
            _chunk("c", "alpha beta delta", source_id="s2", canonical="k"),
            _chunk("d", "alpha beta epsilon", source_id="s3", canonical="k"),
        ]
        vectors = [run_eval._normalize(_bag_of_words(c["embed_text"])) for c in chunks]
        results = run_eval.rank_chunks(_bag_of_words("alpha beta"), chunks, vectors, 4)
        self.assertEqual([r["source_id"] for r in results].count("s1"), 1)
        self.assertEqual(len([r for r in results if r["canonical_key"] == "k"]), 1)
        self.assertEqual(results[0]["id"], "a")


class CandidateSpecTests(unittest.TestCase):
    def test_default_candidates_and_overrides(self):
        specs = run_eval.build_candidate_specs(list(run_eval.CANDIDATES), {"titan-v2-512": "arn:custom"})
        self.assertEqual(specs["v3-baseline"].dimensions, 1024)
        self.assertEqual(specs["titan-v2-1024"].dimensions, 1024)
        self.assertEqual(specs["titan-v2-512"].dimensions, 512)
        self.assertEqual(specs["titan-v2-512"].invoke_target, "arn:custom")
        self.assertEqual(specs["cohere-v4"].provider, "cohere_v4")

    def test_cohere_v4_dimension_flag_and_unknown_candidate(self):
        specs = run_eval.build_candidate_specs(["cohere-v4"], {}, 512)
        self.assertEqual(specs["cohere-v4"].dimensions, 512)
        with self.assertRaises(ValueError):
            run_eval.build_candidate_specs(["nope"], {})

    def test_parse_pairs(self):
        self.assertEqual(run_eval.parse_pairs(["a=1.5", "b=2"], float), {"a": 1.5, "b": 2.0})
        with self.assertRaises(ValueError):
            run_eval.parse_pairs(["broken"])


class SnapshotTests(unittest.TestCase):
    def test_read_snapshot_is_read_only_and_closes_cursor(self):
        executed = []

        class Plain:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute(self, sql, params=None):
                executed.append(sql.strip())

        class Named:
            itersize = 0
            closed = False

            def execute(self, sql, params=None):
                executed.append("NAMED " + " ".join(sql.split())[:20])

            def __iter__(self):
                return iter([("id1", "text", "T", "https://x.org/a", "web", "src", None),
                             ("id2", "t2", "T2", "s3://bucket/key", "document", "src2", "k")])

            def close(self):
                Named.closed = True

        class Conn:
            rolled_back = 0

            def cursor(self, name=None):
                return Named() if name else Plain()

            def rollback(self):
                Conn.rolled_back += 1

        chunks = run_eval.read_snapshot(Conn())
        self.assertEqual(executed[0], "SET TRANSACTION READ ONLY")
        self.assertTrue(Named.closed)
        self.assertEqual(Conn.rolled_back, 1)
        self.assertEqual(chunks[0]["url"], "https://x.org/a")
        self.assertEqual(chunks[1]["url"], "")  # internal identities are blanked
        self.assertEqual(chunks[1]["canonical_key"], "k")
        # No write verbs anywhere in the snapshot SQL.
        sql = run_eval._SNAPSHOT_SQL.upper()
        for verb in ("INSERT", "UPDATE", "DELETE"):
            self.assertNotIn(verb, sql)


if __name__ == "__main__":
    unittest.main()
