"""Unit tests for helpers/eval_scoring.py and the golden-set loader in tests/eval/run_eval.py."""

import collections
import importlib.util
import json
import os
import sys
import tempfile
import unittest

_TG = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, _TG)

from helpers import eval_scoring  # noqa: E402

_EVAL_DIR = os.path.join(_TG, "tests", "eval")
_GOLDEN = os.path.join(_EVAL_DIR, "golden_queries.json")
_EXAMPLE = os.path.join(_EVAL_DIR, "questions.example.json")


def _load_run_eval():
    spec = importlib.util.spec_from_file_location("run_eval_under_test", os.path.join(_EVAL_DIR, "run_eval.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


run_eval = _load_run_eval()


class RelevanceTests(unittest.TestCase):
    ITEM = {"question": "q", "expected": [], "expected_topics": ["Partial Day", "reduced schedule", "sent home"]}

    def test_topic_hits_counts_distinct_topics_case_insensitively(self):
        self.assertEqual(eval_scoring.topic_hits("A PARTIAL DAY plan and a partial day log", ["partial day"]), 1)
        self.assertEqual(eval_scoring.topic_hits("Partial day, reduced schedule", ["partial day", "reduced SCHEDULE", "x"]), 2)
        self.assertEqual(eval_scoring.topic_hits("", ["a"]), 0)
        self.assertEqual(eval_scoring.topic_hits("text", ["", "  "]), 0)

    def test_threshold_of_two_by_default(self):
        one = {"content": "all about a partial day only", "title": ""}
        two = {"content": "a partial day or a reduced schedule", "title": ""}
        self.assertFalse(eval_scoring.is_relevant(one, self.ITEM))
        self.assertTrue(eval_scoring.is_relevant(two, self.ITEM))

    def test_title_counts_toward_topics(self):
        source = {"content": "partial day", "title": "Reduced Schedule guide"}
        self.assertTrue(eval_scoring.is_relevant(source, self.ITEM))

    def test_threshold_clamped_for_single_topic_entries(self):
        item = {"question": "q", "expected_topics": ["field trip"]}
        self.assertTrue(eval_scoring.is_relevant({"content": "A field trip plan"}, item, min_topic_hits=2))
        self.assertFalse(eval_scoring.is_relevant({"content": "nothing"}, item, min_topic_hits=2))

    def test_candidate_index_uses_embed_text(self):
        source = {"embed_text": "partial day and reduced schedule"}
        self.assertTrue(eval_scoring.is_relevant(source, self.ITEM))

    def test_entry_without_expectations_is_never_relevant(self):
        self.assertFalse(eval_scoring.is_relevant({"content": "anything"}, {"question": "q"}))

    def test_url_and_title_matching_is_unchanged(self):
        item = {"question": "q", "expected": ["reduced-schedules", "Partial Day Guide"]}
        self.assertTrue(eval_scoring.is_relevant({"url": "https://x.org/Reduced-Schedules/a"}, item))
        self.assertTrue(eval_scoring.is_relevant({"title": " partial day guide "}, item))
        self.assertFalse(eval_scoring.is_relevant({"url": "https://x.org/other", "title": "Other"}, item))
        # Expected wins over topics: topic text alone does not match when expected is filled.
        both = {"question": "q", "expected": ["only-this"], "expected_topics": ["partial day", "reduced schedule"]}
        self.assertFalse(eval_scoring.is_relevant({"content": "partial day reduced schedule"}, both))

    def test_guideline_heading_match(self):
        source = {"metadata": {"section_key": "sit-1", "heading_path": "Guide > Partial Day"}}
        self.assertTrue(eval_scoring.matches(source, ["partial day"]))

    def test_expected_override_for_guideline_targets(self):
        item = {"question": "q", "expected": ["a"]}
        self.assertTrue(eval_scoring.is_relevant({"title": "b"}, item, expected=["b"]))

    def test_first_relevant_rank_respects_n(self):
        results = [{"content": "x"}, {"content": "partial day reduced schedule"}]
        self.assertEqual(eval_scoring.first_relevant_rank(results, self.ITEM), 2)
        self.assertIsNone(eval_scoring.first_relevant_rank(results, self.ITEM, n=1))
        self.assertIsNone(eval_scoring.first_relevant_rank([], self.ITEM))


class MetricTests(unittest.TestCase):
    def test_recall_and_mrr_arithmetic(self):
        ranks = [1, 2, None, 6]
        self.assertAlmostEqual(eval_scoring.recall_at_k(ranks, 1), 0.25)
        self.assertAlmostEqual(eval_scoring.recall_at_k(ranks, 5), 0.5)
        self.assertAlmostEqual(eval_scoring.recall_at_k(ranks, 15), 0.75)
        self.assertAlmostEqual(eval_scoring.mrr(ranks), (1 + 0.5 + 0 + 1 / 6) / 4)
        self.assertEqual(eval_scoring.recall_at_k([], 5), 0.0)
        self.assertEqual(eval_scoring.mrr([]), 0.0)

    def test_percentile_math(self):
        self.assertEqual(eval_scoring.percentile([], 50), 0.0)
        self.assertEqual(eval_scoring.percentile([7], 90), 7.0)
        self.assertEqual(eval_scoring.percentile([1, 2, 3, 4], 50), 2.5)
        self.assertEqual(eval_scoring.percentile([4, 1, 3, 2], 100), 4.0)
        self.assertEqual(eval_scoring.percentile([1, 2, 3, 4, 5], 0), 1.0)
        self.assertAlmostEqual(eval_scoring.percentile(list(range(1, 11)), 90), 9.1)

    def test_report_only_kinds_are_excluded_from_pass_fail_metrics(self):
        per_question = [
            {"id": "a", "kind": "positive", "rank": 1, "top_score": 0.8},
            {"id": "b", "kind": "positive", "rank": None, "top_score": 0.5},
            {"id": "c", "kind": "near_miss", "rank": None, "top_score": 0.45},
            {"id": "d", "kind": "off_topic", "rank": None, "top_score": 0.1},
        ]
        summary = eval_scoring.summarize(per_question, (5, 15))
        self.assertEqual(summary["questions"], 2)
        self.assertEqual(summary["report_only_questions"], 2)
        self.assertEqual(summary["recall@5"], 0.5)
        self.assertEqual(summary["mrr"], 0.5)
        dist = eval_scoring.score_distribution(per_question)
        self.assertEqual(dist["near_miss"]["max"], 0.45)
        self.assertEqual(dist["off_topic"]["count"], 1)
        self.assertEqual(dist["positive"]["count"], 2)

    def test_score_distribution_and_suggestion(self):
        per_question = (
            [{"kind": "positive", "top_score": s} for s in (0.6, 0.7, 0.8)]
            + [{"kind": "near_miss", "top_score": s} for s in (0.3, 0.4)]
            + [{"kind": "off_topic", "top_score": None}]
        )
        dist = eval_scoring.score_distribution(per_question)
        self.assertEqual(dist["positive"], {"count": 3, "min": 0.6, "median": 0.7, "p90": 0.78, "max": 0.8})
        self.assertEqual(dist["off_topic"]["count"], 0)
        self.assertEqual(dist["off_topic"]["median"], None)
        self.assertEqual(eval_scoring.suggest_min_score(dist), round((0.39 + 0.7) / 2, 3))

    def test_suggestion_absent_when_groups_overlap(self):
        dist = {"near_miss": {"p90": 0.8}, "positive": {"median": 0.6}}
        self.assertIsNone(eval_scoring.suggest_min_score(dist))
        self.assertIsNone(eval_scoring.suggest_min_score({}))


class LoaderTests(unittest.TestCase):
    def _load(self, data):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump(data, handle)
            path = handle.name
        try:
            return run_eval.load_questions(path)
        finally:
            os.unlink(path)

    def test_accepts_topics_only_entries(self):
        self.assertEqual(len(self._load([{"question": "q", "expected": [], "expected_topics": ["a"]}])), 1)

    def test_accepts_expected_only_entries(self):
        self.assertEqual(len(self._load([{"question": "q", "expected": ["x"]}])), 1)

    def test_rejects_entries_with_neither_field(self):
        with self.assertRaises(ValueError):
            self._load([{"question": "q", "expected": [], "expected_topics": []}])
        with self.assertRaises(ValueError):
            self._load([{"question": "q"}])

    def test_rejects_empty_question_and_unknown_kind(self):
        with self.assertRaises(ValueError):
            self._load([{"question": "", "expected": ["x"]}])
        with self.assertRaises(ValueError):
            self._load([{"question": "q", "expected": ["x"], "kind": "weird"}])

    def test_report_only_entries_need_no_expectations(self):
        self.assertEqual(len(self._load([{"question": "q", "kind": "off_topic", "expected": [], "expected_topics": []}])), 1)

    def test_loads_legacy_example_file(self):
        questions = run_eval.load_questions(_EXAMPLE)
        self.assertEqual(len(questions), 5)
        self.assertTrue(all(eval_scoring.kind_of(q) == "positive" for q in questions))

    def test_matches_wrapper_behaves_like_before(self):
        self.assertTrue(run_eval.matches({"url": "https://x.org/A"}, ["x.org/a"]))
        self.assertEqual(run_eval.first_match_rank([{"title": "no"}, {"title": "Yes"}], ["yes"]), 2)
        self.assertEqual(run_eval.expected_for({"expected": ["a"], "expected_guideline": ["g"]}, "guideline"), ["g"])
        self.assertEqual(run_eval.expected_for({"expected": ["a"], "expected_guideline": ["g"]}, "standard"), ["a"])


class GoldenSetTests(unittest.TestCase):
    """The checked-in golden set is synthetic: guard its shape, not its content."""

    @classmethod
    def setUpClass(cls):
        with open(_GOLDEN, "r", encoding="utf-8") as handle:
            cls.entries = json.load(handle)

    def test_shape_and_counts(self):
        self.assertEqual(len(self.entries), 71)
        kinds = collections.Counter(eval_scoring.kind_of(e) for e in self.entries)
        self.assertEqual(kinds, {"positive": 64, "near_miss": 4, "off_topic": 3})

    def test_ids_and_questions(self):
        ids = [e.get("id") for e in self.entries]
        self.assertTrue(all(ids))
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue(all((e.get("question") or "").strip() for e in self.entries))

    def test_positives_have_topics(self):
        for entry in self.entries:
            if eval_scoring.kind_of(entry) == "positive":
                self.assertTrue(entry.get("expected_topics"), entry["id"])

    def test_loader_accepts_the_golden_set(self):
        self.assertEqual(len(run_eval.load_questions(_GOLDEN)), 71)


if __name__ == "__main__":
    unittest.main()
