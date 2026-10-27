"""
Unit tests for helpers/reembed_space.py (the `reembed_space` async task).
No AWS and no database: the state model lives in _embedding_fakes.FakeDb.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_reembed_space.py"
"""

import _setup  # noqa: F401  (must be first)

import copy
import json
import unittest
from unittest import mock

from botocore.exceptions import ClientError

import _embedding_fakes as fakes
from helpers import reembed_space as rs
from kc_shared import embeddings
from helpers.embedding_space import ActiveSpace

SPACE_ID = "22222222-2222-4222-8222-222222222222"
OTHER_SPACE_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "33333333-3333-4333-8333-333333333333"


def chunk_id(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def make_space(provider="cohere_v3", dimensions=1024, settings=None, space_id=SPACE_ID):
    target = "cohere.embed-english-v3" if provider == "cohere_v3" else "amazon.titan-embed-text-v2:0"
    return ActiveSpace(id=space_id, name="new-space", provider=provider, invoke_target=target,
                       dimensions=dimensions, status="building", settings=settings or {})


def throttle():
    return ClientError({"Error": {"Code": "ThrottlingException", "Message": "slow down"}}, "InvokeModel")


def make_db(count=5, mode="rebuild", **job_extra):
    db = fakes.FakeDb()
    db.tx["chunks"] = {chunk_id(i): f"chunk text number {i}" for i in range(1, count + 1)}
    db.tx["job"] = fakes.make_job(JOB_ID, SPACE_ID, mode, **job_extra)
    db.committed = copy.deepcopy(db.tx)
    return db


def fake_embed(dim=1024, calls=None):
    def embed(texts, spec, region=None, client=None):
        if calls is not None:
            calls.append(list(texts))
        return [[0.5] * dim for _ in texts]
    return embed


class ReembedTestBase(unittest.TestCase):
    space = make_space()

    def setUp(self):
        patches = [
            mock.patch.object(rs, "fetch_space", side_effect=lambda conn, sid=None: self.space),
            mock.patch.object(rs.time, "sleep"),
            mock.patch.object(rs.random, "uniform", return_value=1.0),
            mock.patch.object(rs, "invoke_self"),
        ]
        self.fetch_space, self.sleep, self.uniform, self.invoke = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)

    def run_job(self, db, embed=None, context=None, continuation=0):
        embed = embed or fake_embed()
        with mock.patch.object(rs.embeddings, "embed_documents", side_effect=embed) as m:
            result = rs.reembed_space(
                {"task": "reembed_space", "job_id": JOB_ID, "continuation": continuation},
                db, context or fakes.Context(),
            )
        return result, m


class RebuildTest(ReembedTestBase):
    def test_embeds_every_missing_chunk_and_succeeds(self):
        db = make_db(count=5)
        calls = []
        result, _ = self.run_job(db, embed=fake_embed(calls=calls))
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(db.job["status"], "succeeded")
        self.assertEqual(db.job["processed"], 5)
        self.assertEqual(db.job["total_chunks"], 5)
        self.assertEqual(db.remaining(SPACE_ID), [])
        self.assertEqual(sum(len(c) for c in calls), 5)

    def test_batch_selection_query_shape_and_cursor_advance(self):
        db = make_db(count=5)
        # Cohere v3: batch_size 96 -> read 192 rows per batch.
        self.run_job(db)
        selects = db.statements("SELECT c.id::text, c.embed_text, md5(c.embed_text)")
        sql = selects[0][1]
        self.assertIn("LEFT JOIN chunk_embeddings ce", sql)
        self.assertIn("ce.space_id = %s::uuid", sql)
        self.assertIn("c.id > %s::uuid", sql)
        self.assertIn("ce.chunk_id IS NULL OR ce.embed_hash <> md5(c.embed_text)", sql)
        self.assertIn("ORDER BY c.id", sql)
        self.assertEqual(selects[0][2], (SPACE_ID, fakes.NIL, 192))
        # The second read starts after the last chunk of the first batch, then a final
        # scan from the start finds nothing.
        self.assertEqual(selects[1][2][1], chunk_id(5))
        self.assertEqual(selects[2][2][1], fakes.NIL)

    def test_titan_batch_size_is_eight_per_worker(self):
        self.assertEqual(rs.select_batch_size(embeddings.spec_from_row(
            {"provider": "titan_v2", "invoke_target": "t", "dimensions": 512, "settings": {"concurrency": 4}})), 32)
        self.assertEqual(rs.select_batch_size(embeddings.DEFAULT_SPEC), 192)

    def test_progress_and_vectors_commit_in_one_transaction(self):
        db = make_db(count=3)
        self.run_job(db)
        upserts = db.statements("INSERT INTO chunk_embeddings")
        progress = db.statements("SET processed = processed + %s")
        self.assertEqual(len(upserts), 3)
        self.assertEqual(len(progress), 1)
        # Upserts and the progress update share one transaction id.
        self.assertEqual({e[3] for e in upserts} | {progress[0][3]}, {progress[0][3]})

    def test_a_failed_batch_leaves_no_partial_write(self):
        db = make_db(count=4)
        db.fail_next("INSERT INTO chunk_embeddings", RuntimeError("db down"))
        result, _ = self.run_job(db)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(db.job["status"], "failed")
        self.assertEqual(db.tx["vectors"], {})
        self.assertEqual(db.job["processed"], 0)
        self.assertEqual(db.job["last_error"], "RuntimeError")

    def test_text_is_never_stored_in_job_or_logs(self):
        db = make_db(count=2)
        db.fail_next("INSERT INTO chunk_embeddings", RuntimeError("chunk text number 1 leaked"))
        with self.assertLogs(level="ERROR") as logs:
            self.run_job(db)
        self.assertNotIn("chunk text number", json.dumps(db.job))
        self.assertNotIn("chunk text number", "\n".join(logs.output))

    def test_stale_hash_row_is_reembedded_and_current_row_is_not(self):
        db = make_db(count=3)
        db.tx["vectors"][(SPACE_ID, chunk_id(1))] = fakes.md5(db.tx["chunks"][chunk_id(1)])  # current
        db.tx["vectors"][(SPACE_ID, chunk_id(2))] = "0" * 32                                  # stale
        calls = []
        self.run_job(db, embed=fake_embed(calls=calls))
        embedded = [t for batch in calls for t in batch]
        self.assertEqual(sorted(embedded), ["chunk text number 2", "chunk text number 3"])

    def test_only_this_space_is_scoped(self):
        db = make_db(count=2)
        for i in (1, 2):
            db.tx["vectors"][(OTHER_SPACE_ID, chunk_id(i))] = fakes.md5(db.tx["chunks"][chunk_id(i)])
        calls = []
        self.run_job(db, embed=fake_embed(calls=calls))
        self.assertEqual(sum(len(c) for c in calls), 2)
        self.assertTrue(all(sid == SPACE_ID for sid, _ in db.tx["vectors"] if sid != OTHER_SPACE_ID))

    def test_chunk_deleted_mid_batch_is_skipped_not_fatal(self):
        db = make_db(count=3)
        original = fake_embed()

        def embed(texts, spec, region=None, client=None):
            db.tx["chunks"].pop(chunk_id(2))
            db.committed["chunks"].pop(chunk_id(2))
            return original(texts, spec)

        result, _ = self.run_job(db, embed=embed)
        self.assertEqual(result["status"], "succeeded")
        self.assertNotIn((SPACE_ID, chunk_id(2)), db.tx["vectors"])

    def test_resume_after_mid_job_failure_only_embeds_the_rest(self):
        db = make_db(count=6)
        space = make_space(settings={"batch_size": 2})   # 4 rows per batch
        self.space = space
        calls = []
        state = {"n": 0}

        def flaky(texts, spec, region=None, client=None):
            state["n"] += 1
            calls.append(list(texts))
            if state["n"] == 2:
                raise RuntimeError("boom")
            return [[0.1] * 1024 for _ in texts]

        result, _ = self.run_job(db, embed=flaky)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(db.job["processed"], 4)
        self.assertEqual(db.job["cursor"], chunk_id(4))   # cursor kept for the resume

        # A new job over the same space embeds only what is still missing.
        db.tx["job"] = fakes.make_job(JOB_ID, SPACE_ID, "delta")
        db.committed = copy.deepcopy(db.tx)
        calls2 = []
        result, _ = self.run_job(db, embed=fake_embed(calls=calls2))
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(sorted(t for c in calls2 for t in c),
                         ["chunk text number 5", "chunk text number 6"])

    def test_cursor_on_the_job_is_honoured_on_continuation(self):
        db = make_db(count=4, cursor=chunk_id(2))
        for i in (1, 2):   # finished by the earlier invocation
            db.tx["vectors"][(SPACE_ID, chunk_id(i))] = fakes.md5(db.tx["chunks"][chunk_id(i)])
        db.committed = copy.deepcopy(db.tx)
        calls = []
        self.run_job(db, embed=fake_embed(calls=calls), continuation=1)
        self.assertEqual(sorted(t for c in calls for t in c), ["chunk text number 3", "chunk text number 4"])
        # The first read starts at the stored cursor, not at the beginning.
        self.assertEqual(db.statements("SELECT c.id::text, c.embed_text, md5")[0][2][1], chunk_id(2))

    def test_final_scan_picks_up_chunks_added_behind_the_cursor(self):
        db = make_db(count=3)
        added = {"done": False}
        original = fake_embed()

        def embed(texts, spec, region=None, client=None):
            if not added["done"]:
                added["done"] = True
                late = chunk_id(0)               # sorts before the cursor
                db.tx["chunks"][late] = "late chunk"
                db.committed["chunks"][late] = "late chunk"
            return original(texts, spec)

        result, _ = self.run_job(db, embed=embed)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(db.remaining(SPACE_ID), [])
        self.assertIn((SPACE_ID, chunk_id(0)), db.tx["vectors"])

    def test_terminal_job_is_left_alone(self):
        db = make_db(count=2)
        db.job["status"] = "succeeded"
        db.committed = copy.deepcopy(db.tx)
        result, m = self.run_job(db)
        self.assertEqual(result["status"], "succeeded")
        m.assert_not_called()

    def test_unknown_job(self):
        db = make_db()
        result = rs.reembed_space({"task": "reembed_space", "job_id": "99999999-9999-4999-8999-999999999999"}, db)
        self.assertEqual(result["status"], "not_found")

    def test_missing_space_fails_the_job(self):
        self.fetch_space.side_effect = lambda conn, sid=None: None
        db = make_db()
        result, _ = self.run_job(db)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(db.job["last_error"], "embedding space not found")


class ThrottlingTest(ReembedTestBase):
    def test_two_throttles_then_success_backs_off_with_increasing_delays(self):
        db = make_db(count=2)
        state = {"n": 0}

        def embed(texts, spec, region=None, client=None):
            state["n"] += 1
            if state["n"] <= 2:
                raise throttle()
            return [[0.1] * 1024 for _ in texts]

        result, _ = self.run_job(db, embed=embed)
        self.assertEqual(result["status"], "succeeded")
        delays = [c.args[0] for c in self.sleep.call_args_list]
        self.assertEqual(delays, [2, 4])      # jitter patched to 1.0
        self.assertEqual(db.job["processed"], 2)

    def test_delay_grows_and_is_capped(self):
        db = make_db(count=1)
        with mock.patch.object(rs, "_MAX_TRIES", 12):
            state = {"n": 0}

            def embed(texts, spec, region=None, client=None):
                state["n"] += 1
                if state["n"] <= 8:
                    raise throttle()
                return [[0.1] * 1024 for _ in texts]

            self.run_job(db, embed=embed)
        delays = [c.args[0] for c in self.sleep.call_args_list]
        self.assertEqual(delays, [2, 4, 8, 16, 32, 60, 60, 60])

    def test_five_consecutive_throttles_fail_the_job_and_keep_the_cursor(self):
        db = make_db(count=6, cursor=chunk_id(2))
        self.space = make_space(settings={"batch_size": 2})

        def embed(texts, spec, region=None, client=None):
            raise throttle()

        result, m = self.run_job(db, embed=embed)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(m.call_count, 5)
        self.assertEqual(self.sleep.call_count, 4)
        self.assertEqual(db.job["cursor"], chunk_id(2))
        self.assertEqual(db.job["last_error"], "ClientError (ThrottlingException)")

    def test_non_throttle_errors_are_not_retried(self):
        db = make_db(count=2)

        def embed(texts, spec, region=None, client=None):
            raise ClientError({"Error": {"Code": "ValidationException", "Message": "bad"}}, "InvokeModel")

        result, m = self.run_job(db, embed=embed)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(m.call_count, 1)
        self.sleep.assert_not_called()

    def test_is_throttle_codes(self):
        for code in ("ThrottlingException", "ThrottledException", "ServiceQuotaExceededException",
                     "TooManyRequestsException"):
            err = ClientError({"Error": {"Code": code, "Message": ""}}, "InvokeModel")
            self.assertTrue(rs.is_throttle(err), code)
        self.assertFalse(rs.is_throttle(ValueError("x")))


class ContinuationTest(ReembedTestBase):
    def test_low_remaining_time_triggers_exactly_one_self_invoke(self):
        db = make_db(count=10)
        self.space = make_space(settings={"batch_size": 2})   # 4 rows per batch
        # 61 s left on the first check, 59 s afterwards: one batch runs, then it hands over.
        context = mock.Mock()
        context.get_remaining_time_in_millis.side_effect = [61_000, 59_000] + [59_000] * 5
        result, _ = self.run_job(db, context=context)
        self.assertEqual(result["status"], "continued")
        self.invoke.assert_called_once_with({"task": "reembed_space", "job_id": JOB_ID, "continuation": 1})
        self.assertEqual(db.job["status"], "running")
        self.assertEqual(db.job["continuation"], 1)
        self.assertEqual(db.job["processed"], 4)
        self.assertEqual(db.job["cursor"], chunk_id(4))

    def test_continuation_cap_fails_the_job_clearly(self):
        db = make_db(count=4, continuation=rs._MAX_CONTINUATIONS)
        context = mock.Mock()
        context.get_remaining_time_in_millis.return_value = 1_000
        result, _ = self.run_job(db, context=context, continuation=rs._MAX_CONTINUATIONS)
        self.assertEqual(result["status"], "failed")
        self.invoke.assert_not_called()
        self.assertIn("continuations", db.job["last_error"])

    def test_failed_self_invoke_fails_the_job(self):
        db = make_db(count=4)
        self.invoke.side_effect = RuntimeError("cannot invoke")
        context = mock.Mock()
        context.get_remaining_time_in_millis.return_value = 1_000
        result, _ = self.run_job(db, context=context)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(db.job["status"], "failed")


class DryRunTest(ReembedTestBase):
    def setUp(self):
        super().setUp()
        patch = mock.patch.object(rs, "_clock", side_effect=[100.0, 102.0])
        self.perf = patch.start()
        self.addCleanup(patch.stop)

    def test_estimates_without_writing_vectors(self):
        db = make_db(count=4, mode="dry_run")
        db.price = 0.1
        result, m = self.run_job(db)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(db.tx["vectors"], {})
        self.assertEqual(db.statements("INSERT INTO chunk_embeddings"), [])
        chars = sum(len(t) for t in db.tx["chunks"].values())
        self.assertEqual(db.job["total_chunks"], 4)
        self.assertEqual(db.job["est_tokens"], -(-chars // 4))
        self.assertAlmostEqual(db.job["est_cost_usd"], round(db.job["est_tokens"] / 1e6 * 0.1, 4), places=4)
        self.assertTrue(db.job["price_configured"])
        m.assert_called_once()   # the timed sample

    def test_price_not_configured_when_null(self):
        db = make_db(count=4, mode="dry_run")
        db.price = None
        self.run_job(db)
        self.assertIsNone(db.job["est_cost_usd"])
        self.assertFalse(db.job["price_configured"])
        self.assertIsNotNone(db.job["est_tokens"])

    def test_characters_are_capped_at_max_chars_per_row(self):
        db = make_db(count=2, mode="dry_run")
        db.tx["chunks"][chunk_id(1)] = "x" * 5000
        self.run_job(db)
        self.assertEqual(db.job["report"]["characters"], 2048 + len("chunk text number 2"))

    def test_time_extrapolation_batched_adapter(self):
        spec = embeddings.DEFAULT_SPEC     # batch 96, concurrency 1
        # 1000 rows -> 11 calls of 2 s each.
        self.assertEqual(rs.estimate_seconds(1000, 10, 2.0, spec), 22)
        spec2 = embeddings.spec_from_row({"provider": "cohere_v3", "invoke_target": "x", "dimensions": 1024,
                                          "settings": {"concurrency": 2}})
        self.assertEqual(rs.estimate_seconds(1000, 10, 2.0, spec2), 11)

    def test_time_extrapolation_single_text_adapter(self):
        spec = embeddings.spec_from_row({"provider": "titan_v2", "invoke_target": "t", "dimensions": 512,
                                         "settings": {"concurrency": 8}})
        # 10 texts in 2 s sequentially = 0.2 s each; 1000 rows over 8 workers = 25 s.
        self.assertEqual(rs.estimate_seconds(1000, 10, 2.0, spec), 25)

    def test_single_text_sample_is_timed_sequentially(self):
        self.space = make_space("titan_v2", 512, settings={"concurrency": 8})
        db = make_db(count=4, mode="dry_run")
        _, m = self.run_job(db, embed=fake_embed(512))
        self.assertEqual(m.call_args.args[1].concurrency, 1)

    def test_sample_failure_is_an_estimate_error_not_a_job_failure(self):
        db = make_db(count=3, mode="dry_run")

        def embed(texts, spec, region=None, client=None):
            raise RuntimeError("no bedrock")

        result, _ = self.run_job(db, embed=embed)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(db.job["status"], "succeeded")
        self.assertIsNone(db.job["est_seconds"])
        self.assertIn("RuntimeError", db.job["last_error"])
        self.assertEqual(db.job["total_chunks"], 3)

    def test_nothing_to_embed_costs_nothing(self):
        db = make_db(count=0, mode="dry_run")
        self.run_job(db)
        self.assertEqual(db.job["total_chunks"], 0)
        self.assertEqual(db.job["est_seconds"], 0)
        self.assertEqual(db.job["est_tokens"], 0)

    def test_pure_estimates(self):
        self.assertEqual(rs.estimate_tokens(0), 0)
        self.assertEqual(rs.estimate_tokens(1), 1)
        self.assertEqual(rs.estimate_tokens(4001), 1001)
        self.assertEqual(rs.estimate_cost(1_000_000, 0.02), 0.02)
        self.assertIsNone(rs.estimate_cost(1_000_000, None))


if __name__ == "__main__":
    unittest.main()
