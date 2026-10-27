"""
Unit tests for helpers/validate_space.py (the `validate_space` async task).
Retrieval, embedding and the database are faked.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_validate_space.py"
"""

import _setup  # noqa: F401  (must be first)

import copy
import json
import os
import unittest
from unittest import mock

import _embedding_fakes as fakes
from helpers import validate_space as vs
from kc_shared import eval_scoring, retrieval_core
from helpers.embedding_space import ActiveSpace

TARGET_ID = "22222222-2222-4222-8222-222222222222"
ACTIVE_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "33333333-3333-4333-8333-333333333333"


def make_space(space_id, name, status="active"):
    return ActiveSpace(id=space_id, name=name, provider="cohere_v3", invoke_target="cohere.embed-english-v3",
                       dimensions=1024, status=status)


TARGET = make_space(TARGET_ID, "new-space", "building")
ACTIVE = make_space(ACTIVE_ID, "cohere-v3-1024")

GOLDEN = [
    {"id": "p1", "question": "reduced schedule question", "expected_topics": ["alpha", "beta"]},
    {"id": "p2", "question": "second question", "expected_topics": ["gamma", "delta"]},
    {"id": "n1", "question": "near miss", "kind": "near_miss", "expected_topics": ["alpha", "beta"]},
    {"id": "o1", "question": "off topic", "kind": "off_topic", "expected_topics": ["alpha", "beta"]},
]


def source_row(body, score, source_id):
    # (body, metadata, url, title, source_type, score, source_id)
    return (body, {}, f"https://example.org/{source_id}", f"Title {source_id}", "web", score, source_id)


def retrieval_for(rows_by_space):
    """fetch_candidate_rows stand-in: which rows come back depends on the space searched."""
    def fetch(cursor, space, embedding_str, num_results, min_results):
        return rows_by_space[str(space.id)]
    return fetch


GOOD_ROWS = [source_row("alpha and beta together", 0.9, "s1"), source_row("gamma delta text", 0.8, "s2")]
POOR_ROWS = [source_row("nothing relevant", 0.5, "s3")]


class CriteriaTest(unittest.TestCase):
    def setUp(self):
        patches = [
            mock.patch.object(vs.embeddings, "embed_query", return_value=[0.1] * 1024),
            mock.patch.object(vs, "load_golden", return_value=GOLDEN),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def conn(self, missing=0, types=None):
        types = types if types is not None else [("web", 10, 10, 10, 0), ("csv_row", 4, 4, 4, 0)]
        return fakes.ScriptedConnection({
            "SELECT count(*) FROM chunks c LEFT JOIN": [(missing,)],
            # Honours the LIMIT parameter the way Postgres would.
            "SELECT c.id::text FROM chunks c LEFT JOIN": lambda p: [(f"c{i}",) for i in range(missing)][: p[1]],
            "GROUP BY s.source_type": types,
        })

    def validate(self, conn, rows_by_space, **kw):
        with mock.patch.object(retrieval_core, "fetch_candidate_rows", retrieval_for(rows_by_space)):
            return vs.run_validation(conn, TARGET, ACTIVE, tolerance=kw.pop("tolerance", 0.05), **kw)

    def test_all_criteria_pass(self):
        report = self.validate(self.conn(), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertTrue(report["passed"])
        self.assertEqual(report["criteria"], {"coverage": True, "source_types": True, "quality": True})
        self.assertEqual(report["quality"]["comparison"]["deltas"]["recall@5"]["delta"], 0.0)

    def test_coverage_gap_fails_alone_and_lists_at_most_20_ids(self):
        report = self.validate(self.conn(missing=25), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertFalse(report["passed"])
        self.assertEqual(report["criteria"], {"coverage": False, "source_types": True, "quality": True})
        self.assertEqual(report["coverage"]["chunks_without_current_vector"], 25)
        self.assertEqual(len(report["coverage"]["sample_chunk_ids"]), 20)   # the SQL LIMIT is bound
        self.assertEqual(vs.failed_criteria(report), ["coverage"])

    def test_sample_limit_is_passed_to_the_query(self):
        conn = self.conn(missing=3)
        self.validate(conn, {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        sample = conn.sql_with("SELECT c.id::text FROM chunks c LEFT JOIN")[0]
        self.assertEqual(sample[1], (TARGET_ID, 20))

    def test_source_type_mismatch_fails_alone(self):
        types = [("web", 10, 10, 10, 0), ("csv_row", 4, 3, 4, 1)]   # target lacks a csv_row vector active has
        report = self.validate(self.conn(types=types), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertEqual(report["criteria"], {"coverage": True, "source_types": False, "quality": True})
        self.assertFalse(report["source_types"]["by_source_type"][1]["passed"])
        self.assertEqual(report["source_types"]["by_source_type"][1]["target_gaps"], 1)

    def test_active_space_having_gaps_does_not_fail_a_complete_target(self):
        types = [("web", 10, 10, 8, 0)]     # active lags (8 of 10); target complete
        report = self.validate(self.conn(types=types), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertTrue(report["criteria"]["source_types"])

    def test_recall_below_tolerance_fails_alone(self):
        report = self.validate(self.conn(), {TARGET_ID: POOR_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertEqual(report["criteria"], {"coverage": True, "source_types": True, "quality": False})
        self.assertFalse(report["passed"])
        self.assertLess(report["quality"]["comparison"]["deltas"]["recall@5"]["delta"], -0.05)

    def test_recall_within_tolerance_passes(self):
        # Active finds 2 of 2 positives, target 1 of 2: delta -0.5. A tolerance of 0.5 allows it.
        mixed = [source_row("alpha and beta together", 0.9, "s1")]
        report = self.validate(self.conn(), {TARGET_ID: mixed, ACTIVE_ID: GOOD_ROWS}, tolerance=0.5)
        self.assertEqual(report["quality"]["comparison"]["deltas"]["recall@5"]["delta"], -0.5)
        self.assertTrue(report["criteria"]["quality"])

    def test_tolerance_boundary_is_inclusive(self):
        mixed = [source_row("alpha and beta together", 0.9, "s1")]
        report = self.validate(self.conn(), {TARGET_ID: mixed, ACTIVE_ID: GOOD_ROWS}, tolerance=0.49)
        self.assertFalse(report["criteria"]["quality"])

    def test_skip_quality_runs_only_the_coverage_criteria(self):
        with mock.patch.object(vs.embeddings, "embed_query") as embed:
            report = self.validate(self.conn(), {}, include_quality=False)
        embed.assert_not_called()
        self.assertEqual(report["quality"], {"skipped": True})
        self.assertIsNone(report["criteria"]["quality"])
        self.assertTrue(report["passed"])

    def test_near_miss_and_off_topic_only_feed_the_distribution(self):
        report = self.validate(self.conn(), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        target = report["quality"]["target"]
        self.assertEqual(target["metrics"]["questions"], 2)
        self.assertEqual(target["metrics"]["report_only_questions"], 2)
        self.assertEqual(target["score_distribution"]["near_miss"]["count"], 1)
        self.assertEqual(target["score_distribution"]["off_topic"]["count"], 1)
        self.assertEqual(target["missed_question_ids"], [])

    def test_each_space_embeds_queries_with_its_own_spec(self):
        seen = []
        with mock.patch.object(vs.embeddings, "embed_query", side_effect=lambda q, spec, *a, **k: seen.append(spec) or [0.0] * 1024):
            self.validate(self.conn(), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertEqual(len(seen), 8)   # 4 golden entries x 2 spaces

    def test_search_settings_do_not_leak_between_queries(self):
        conn = self.conn()
        self.validate(conn, {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        self.assertGreaterEqual(conn.rollbacks, 8)

    def test_not_enough_time_raises_a_clear_error(self):
        with self.assertRaises(vs.ValidationTimeout):
            self.validate(self.conn(), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS}, time_left=lambda: 5)

    def test_report_has_no_text_keys(self):
        report = self.validate(self.conn(), {TARGET_ID: GOOD_ROWS, ACTIVE_ID: GOOD_ROWS})
        blob = json.dumps(report)
        for text in ("alpha and beta together", "reduced schedule question", "gamma delta text", "Title s1"):
            self.assertNotIn(text, blob)
        forbidden = {"content", "body", "text", "question", "query", "embed_text"}

        def walk(value):
            if isinstance(value, dict):
                self.assertFalse(forbidden & set(value), value.keys())
                for v in value.values():
                    walk(v)
            elif isinstance(value, list):
                for v in value:
                    walk(v)

        walk(report)


class ToleranceTest(unittest.TestCase):
    def test_default_env_and_request_precedence_and_clamping(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("VALIDATE_RECALL_TOLERANCE", None)
            self.assertEqual(vs.resolve_tolerance(None), 0.05)
            self.assertEqual(vs.resolve_tolerance(0.2), 0.2)
            self.assertEqual(vs.resolve_tolerance(9), 0.5)
            self.assertEqual(vs.resolve_tolerance(-1), 0.0)
            self.assertEqual(vs.resolve_tolerance("nope"), 0.05)
            self.assertEqual(vs.resolve_tolerance(True), 0.05)
            self.assertEqual(vs.resolve_tolerance(float("nan")), 0.05)
        with mock.patch.dict(os.environ, {"VALIDATE_RECALL_TOLERANCE": "0.1"}):
            self.assertEqual(vs.resolve_tolerance(None), 0.1)
            self.assertEqual(vs.resolve_tolerance(0.3), 0.3)


class GoldenFileTest(unittest.TestCase):
    def test_golden_file_loads_from_the_kb_package_path(self):
        self.assertTrue(os.path.isfile(vs.GOLDEN_PATH))
        self.assertEqual(os.path.dirname(vs.GOLDEN_PATH), os.path.dirname(retrieval_core.__file__))
        golden = vs.load_golden()
        self.assertEqual(len(golden), 71)
        kinds = [eval_scoring.kind_of(g) for g in golden]
        self.assertEqual((kinds.count("positive"), kinds.count("near_miss"), kinds.count("off_topic")), (64, 4, 3))

    def test_scoring_matches_the_textgeneration_numbers(self):
        # Same shared kc_shared module as textGeneration; same fake data, same numbers.
        ranks = [1, None, 3, 20]
        self.assertEqual(eval_scoring.recall_at_k(ranks, 5), 0.5)
        self.assertAlmostEqual(eval_scoring.mrr(ranks), (1 + 1 / 3 + 1 / 20) / 4)
        self.assertEqual(eval_scoring.percentile([1, 2, 3, 4], 50), 2.5)


JOB_REPORT = {"request": {}}


class TaskTest(unittest.TestCase):
    def setUp(self):
        self.db = fakes.FakeDb()
        self.db.tx["job"] = fakes.make_job(JOB_ID, TARGET_ID, "validate", report=copy.deepcopy(JOB_REPORT))
        self.db.committed = copy.deepcopy(self.db.tx)
        self.db.tx["spaces"] = {TARGET_ID: {"status": "building"}}
        self.status_updates = []

        # The status UPDATE is not part of FakeDb's vocabulary; record it here.
        original = self.db.handle

        def handle(n, p):
            if n.startswith("UPDATE embedding_spaces SET status = 'validated'"):
                self.status_updates.append(p)
                self.db.tx["spaces"][p[0]]["status"] = "validated"
                return [], 1
            return original(n, p)

        self.db.handle = handle
        self.target = TARGET
        patches = [
            mock.patch.object(vs, "fetch_space", side_effect=lambda conn, sid=None: self.target if sid else ACTIVE),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_task(self, report):
        with mock.patch.object(vs, "run_validation", return_value=report) as rv:
            result = vs.validate_space({"task": "validate_space", "job_id": JOB_ID}, self.db, fakes.Context())
        return result, rv

    def passing(self):
        return {"passed": True, "criteria": {"coverage": True, "source_types": True, "quality": True}}

    def test_pass_marks_validated_and_stores_the_report(self):
        result, _ = self.run_task(self.passing())
        self.assertEqual(result, {"status": "succeeded", "passed": True})
        self.assertEqual(self.db.tx["spaces"][TARGET_ID]["status"], "validated")
        self.assertEqual(self.db.job["status"], "succeeded")
        self.assertTrue(self.db.job["report"]["passed"])
        sql = self.db.statements("UPDATE embedding_spaces SET status = 'validated'")[0][1]
        self.assertIn("status IN ('building', 'validated')", sql)

    def test_fail_keeps_the_status_and_the_report(self):
        report = {"passed": False, "criteria": {"coverage": False, "source_types": True, "quality": None}}
        result, _ = self.run_task(report)
        self.assertEqual(result, {"status": "failed", "passed": False})
        self.assertEqual(self.db.tx["spaces"][TARGET_ID]["status"], "building")
        self.assertEqual(self.status_updates, [])
        self.assertEqual(self.db.job["status"], "failed")
        self.assertEqual(self.db.job["last_error"], "Validation did not pass: coverage")
        self.assertFalse(self.db.job["report"]["passed"])

    def test_request_options_reach_run_validation(self):
        self.db.job["report"] = {"request": {"tolerance": 0.2, "skip_quality": True}}
        self.db.committed = copy.deepcopy(self.db.tx)
        _, rv = self.run_task(self.passing())
        self.assertEqual(rv.call_args.kwargs["tolerance"], 0.2)
        self.assertFalse(rv.call_args.kwargs["include_quality"])

    def test_only_building_or_validated_spaces_are_validated(self):
        for status in ("active", "retired", "purged"):
            with self.subTest(status=status):
                db = self.db
                db.tx["job"] = fakes.make_job(JOB_ID, TARGET_ID, "validate", report={"request": {}})
                db.committed = copy.deepcopy(db.tx)
                self.target = make_space(TARGET_ID, "new-space", status)
                result, rv = self.run_task(self.passing())
                self.assertEqual(result["status"], "failed")
                rv.assert_not_called()

    def test_unexpected_error_fails_the_job_with_the_class_name_only(self):
        with mock.patch.object(vs, "run_validation", side_effect=RuntimeError("secret chunk text")):
            result = vs.validate_space({"task": "validate_space", "job_id": JOB_ID}, self.db, fakes.Context())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.db.job["last_error"], "RuntimeError")

    def test_timeout_fails_with_a_clear_message(self):
        with mock.patch.object(vs, "run_validation", side_effect=vs.ValidationTimeout("not enough time left to finish the golden-set run")):
            vs.validate_space({"task": "validate_space", "job_id": JOB_ID}, self.db, fakes.Context())
        self.assertIn("not enough time", self.db.job["last_error"])

    def test_wrong_mode_or_terminal_job_is_not_run(self):
        self.db.job["status"] = "succeeded"
        self.db.committed = copy.deepcopy(self.db.tx)
        result, rv = self.run_task(self.passing())
        self.assertEqual(result["status"], "succeeded")
        rv.assert_not_called()


if __name__ == "__main__":
    unittest.main()
