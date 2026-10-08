"""
Unit tests for helpers/cutover.py (`activate_space` / `rollback_space`) and the
activate / rollback routes of helpers/embedding_admin.py.

The state machine runs against _embedding_fakes.FakeDb, a transactional model of the
statements involved, with the delta, validation and golden-set work patched out. Time
is a fake clock that only moves when the code sleeps.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_cutover.py"
"""

import _setup  # noqa: F401  (must be first)

import copy
import datetime
import json
import unittest
from unittest import mock

import _embedding_fakes as fakes
from helpers import cutover, embedding_admin as ea, ingestion_lock, validate_space
from helpers.embedding_space import ActiveSpace
from helpers.reembed_space import DeltaOutcome

OLD = "11111111-1111-4111-8111-111111111111"
NEW = "22222222-2222-4222-8222-222222222222"
OTHER_JOB = "99999999-9999-4999-8999-999999999999"
JOB_ID = "33333333-3333-4333-8333-333333333333"

BASELINE = {"questions": 64, "mrr": 0.5, "recall@5": 0.8, "recall@15": 0.9}
GOOD_POST_FLIP = {"questions": 64, "mrr": 0.52, "recall@5": 0.82, "recall@15": 0.91}
BAD_POST_FLIP = {"questions": 64, "mrr": 0.1, "recall@5": 0.2, "recall@15": 0.3}
STEPS = ["lock", "wait_idle", "delta", "revalidate", "flip", "post_flip_check", "unlock"]


class FakeClock:
    def __init__(self):
        self.moment = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
        self.sleeps = []

    def now(self):
        return self.moment

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.moment += datetime.timedelta(seconds=seconds)


def validation_report(passed=True, include_quality=True, failed="coverage"):
    report = {
        "passed": passed,
        "criteria": {"coverage": passed or failed != "coverage", "source_types": True,
                     "quality": None if not include_quality else True},
        "quality": {"skipped": True},
    }
    if include_quality:
        report["quality"] = {"active": {"metrics": BASELINE}, "target": {"metrics": BASELINE}}
    return report


class CutoverBase(unittest.TestCase):
    kind = "activate"
    request = {}

    def setUp(self):
        self.clock = FakeClock()
        old_status, new_status = ("active", "validated") if self.kind == "activate" else ("active", "retired")
        self.db = fakes.FakeDb()
        self.db.tx["spaces"] = {OLD: {"status": old_status}, NEW: {"status": new_status}}
        self.db.tx["pointer"] = OLD
        self.db.tx["job"] = fakes.make_job(
            JOB_ID, NEW, self.kind,
            report={"request": copy.deepcopy(self.request), "old_space_id": OLD, "new_space_id": NEW},
        )
        self.db.committed = copy.deepcopy(self.db.tx)

        self.run_delta = mock.Mock(return_value=DeltaOutcome(done=True, processed=0, cursor=None))
        self.run_validation = mock.Mock(side_effect=lambda *a, include_quality=True, **k: validation_report(include_quality=include_quality))
        self.evaluate = mock.Mock(return_value={"metrics": GOOD_POST_FLIP})
        self.invoke = mock.Mock()
        self.emit = mock.Mock()
        patches = [
            mock.patch.object(cutover, "fetch_space", side_effect=self.fetch_space),
            mock.patch.object(cutover, "run_delta", self.run_delta),
            mock.patch.object(cutover, "count_remaining", return_value=0),
            mock.patch.object(cutover.validate_space, "run_validation", self.run_validation),
            mock.patch.object(cutover.validate_space, "evaluate_space", self.evaluate),
            mock.patch.object(cutover.validate_space, "load_golden", return_value=[]),
            mock.patch.object(cutover, "invoke_self", self.invoke),
            mock.patch.object(cutover, "emit_metric", self.emit),
            mock.patch.object(cutover, "_now", self.clock.now),
            mock.patch.object(cutover.time, "sleep", self.clock.sleep),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def fetch_space(self, connection, space_id=None):
        space_id = space_id or self.db.tx["pointer"]
        state = self.db.tx["spaces"].get(space_id)
        if state is None:
            return None
        return ActiveSpace(id=space_id, name="old" if space_id == OLD else "new", provider="cohere_v3",
                           invoke_target="cohere.embed-english-v3", dimensions=1024, status=state["status"])

    def go(self, event=None, context=None):
        event = event or {"task": f"{self.kind}_space", "job_id": JOB_ID, "continuation": 0}
        task = cutover.activate_space if self.kind == "activate" else cutover.rollback_space
        return task(event, self.db, context or fakes.Context())

    # views of the committed state
    @property
    def job(self):
        return self.db.committed["job"]

    @property
    def lock(self):
        return self.db.committed["lock"]

    @property
    def spaces(self):
        return self.db.committed["spaces"]

    def step_status(self):
        return {s["name"]: s["status"] for s in self.job["steps"]}

    def hold_lock(self, job_id=OTHER_JOB, expired=False):
        self.db.tx["lock"] = {"locked": True, "job_id": job_id, "expired": expired}
        self.db.committed = copy.deepcopy(self.db.tx)


class ActivateHappyPathTest(CutoverBase):
    def test_runs_every_step_in_order_and_flips(self):
        result = self.go()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual([s["name"] for s in self.job["steps"]], STEPS)
        self.assertEqual(set(self.step_status().values()), {"done"})
        self.assertEqual(self.job["status"], "succeeded")
        self.assertIsNone(self.job.get("last_error"))
        self.assertEqual(self.spaces[OLD]["status"], "retired")
        self.assertEqual(self.spaces[NEW]["status"], "active")
        self.assertEqual(self.db.committed["pointer"], NEW)
        self.assertEqual(self.spaces[OLD]["retired_at"], "now")
        self.assertEqual(self.spaces[NEW]["activated_at"], "now")
        self.assertFalse(self.lock["locked"])

    def test_step_order_in_the_statement_log(self):
        self.go()
        sql = [e[1] for e in self.db.log if e[0] == "sql"]

        def first(fragment):
            return next(i for i, s in enumerate(sql) if fragment in s)

        def last(fragment):
            return max(i for i, s in enumerate(sql) if fragment in s)

        lock_at = first("SET cutover_locked = true")
        idle_at = first("FROM ingestion_runs")
        flip_at = first("UPDATE embedding_spaces SET status = 'retired'")
        unlock_at = first("SET cutover_locked = false")
        self.assertLess(lock_at, idle_at)
        self.assertLess(idle_at, flip_at)
        self.assertLess(flip_at, unlock_at)
        self.assertEqual(last("SET cutover_locked = false"), unlock_at)   # released once, at the very end

    def test_the_flip_is_one_transaction(self):
        self.go()
        flips = [e for e in self.db.log if e[0] == "sql" and (
            "UPDATE embedding_spaces SET status = 'retired'" in e[1]
            or "UPDATE embedding_spaces SET status = 'active'" in e[1]
            or "UPDATE embedding_active_space SET space_id" in e[1])]
        self.assertEqual(len(flips), 3)
        self.assertEqual(len({e[3] for e in flips}), 1)       # one transaction id
        txn = flips[0][3]
        events = [e for e in self.db.log if (e[0] == "sql" and e[3] == txn) or (e[0] != "sql" and e[1] == txn)]
        self.assertEqual([e[0] for e in events], ["sql", "sql", "sql", "commit"])

    def test_flip_statements_are_compare_and_swap(self):
        self.go()
        retire = self.db.statements("UPDATE embedding_spaces SET status = 'retired'")[0]
        activate = self.db.statements("UPDATE embedding_spaces SET status = 'active'")[0]
        pointer = self.db.statements("UPDATE embedding_active_space SET space_id")[0]
        self.assertIn("AND status = 'active'", retire[1])
        self.assertEqual(retire[2], (OLD,))
        self.assertEqual(activate[2], (NEW, "validated"))
        self.assertIn("space_id = %s::uuid", pointer[1].split("WHERE")[1])
        self.assertEqual(pointer[2], (NEW, OLD))

    def test_post_flip_waits_one_cache_ttl_then_checks_the_new_space(self):
        self.go()
        self.assertIn(cutover.CACHE_TTL_SECONDS, [round(s) for s in self.clock.sleeps])
        self.assertEqual(cutover.CACHE_TTL_SECONDS, 65)
        # Delta before the flip (step 3) and again after it (late writers).
        self.assertEqual(self.run_delta.call_count, 2)
        evaluated_space = self.evaluate.call_args.args[1]
        self.assertEqual(str(evaluated_space.id), NEW)
        self.assertEqual(self.emit.call_count, 0)

    def test_revalidation_captures_the_baseline_used_after_the_flip(self):
        self.go()
        self.assertEqual(self.job["report"]["baseline"], BASELINE)
        self.assertTrue(self.job["report"]["revalidate"]["passed"])
        self.assertTrue(self.run_validation.call_args.kwargs["include_quality"])
        self.assertEqual(self.job["report"]["post_flip"]["delta_done"], True)

    def test_progress_is_visible_while_running(self):
        seen = []
        original = self.run_delta.side_effect

        def spy(*a, **k):
            seen.append((self.db.tx["job"]["status"], self.db.tx["job"]["current_step"]))
            return DeltaOutcome(done=True, processed=0, cursor=None)

        self.run_delta.side_effect = spy
        self.go()
        self.assertEqual(seen[0], ("running", "delta"))
        self.assertEqual(seen[1], ("running", "post_flip_check"))

    def test_lock_is_refreshed_while_waiting(self):
        self.db.tx["running_ingestion"] = 1
        self.db.committed = copy.deepcopy(self.db.tx)
        counts = iter([1, 1, 0])
        original = self.db.handle

        def handle(n, p):
            if "FROM ingestion_runs" in n:
                return [(next(counts),)], 1
            return original(n, p)

        self.db.handle = handle
        self.go()
        self.assertEqual(self.clock.sleeps[:2], [cutover.POLL_SECONDS, cutover.POLL_SECONDS])
        self.assertGreaterEqual(len(self.db.statements("SET cutover_locked_at = now()")), 2)


class ActivateOptionsTest(CutoverBase):
    request = {"skip_quality": True}

    def test_skip_quality_runs_coverage_only_and_skips_the_post_flip_golden_run(self):
        result = self.go()
        self.assertEqual(result["status"], "succeeded")
        self.assertFalse(self.run_validation.call_args.kwargs["include_quality"])
        self.evaluate.assert_not_called()
        self.assertNotIn("baseline", self.job["report"])
        self.assertEqual(self.job["report"]["post_flip"]["quality"], "skipped")


class FailurePathTest(CutoverBase):
    """The lock must be released whichever step breaks."""

    def break_step(self, step):
        boom = RuntimeError("boom with secret chunk text")
        if step == "lock":
            self.db.fail_next("SET cutover_locked = true", boom)
        elif step == "wait_idle":
            self.db.fail_next("FROM ingestion_runs", boom)
        elif step == "delta":
            self.run_delta.side_effect = boom
        elif step == "revalidate":
            self.run_validation.side_effect = boom
        elif step == "flip":
            self.db.fail_next("UPDATE embedding_active_space SET space_id", boom)
        elif step == "post_flip_check":
            self.evaluate.side_effect = boom

    def test_lock_is_released_when_any_step_raises(self):
        for step in STEPS[:-1]:
            with self.subTest(step=step):
                self.setUp()
                self.break_step(step)
                result = self.go()
                self.assertEqual(result["status"], "failed")
                self.assertEqual(self.job["status"], "failed")
                self.assertFalse(self.lock["locked"], f"lock still held after a failure in {step}")
                self.assertEqual(self.step_status()[step], "failed")
                self.assertEqual(self.step_status()["unlock"], "done")
                # Class name only; never the exception text.
                self.assertEqual(self.job["last_error"], "RuntimeError")
                self.assertNotIn("secret chunk text", json.dumps(self.job))

    def test_flip_failure_rolls_back_the_whole_transaction(self):
        self.break_step("flip")
        self.go()
        self.assertEqual(self.db.committed["pointer"], OLD)
        self.assertEqual(self.spaces[OLD]["status"], "active")
        self.assertEqual(self.spaces[NEW]["status"], "validated")
        self.assertGreaterEqual(self.db.rollbacks, 1)

    def test_flip_refuses_when_the_outgoing_space_is_no_longer_active(self):
        self.db.tx["spaces"][OLD]["status"] = "retired"
        self.db.committed = copy.deepcopy(self.db.tx)
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("no longer active", self.job["last_error"])
        self.assertEqual(self.db.committed["pointer"], OLD)
        self.assertEqual(self.spaces[NEW]["status"], "validated")

    def test_flip_refuses_when_the_pointer_moved_underneath(self):
        original = self.db.handle

        def handle(n, p):
            if "UPDATE embedding_active_space SET space_id" in n:
                self.db.tx["pointer"] = "55555555-5555-4555-8555-555555555555"   # someone else moved it
            return original(n, p)

        self.db.handle = handle
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("pointer changed", self.job["last_error"])
        self.assertEqual(self.spaces[OLD]["status"], "active")
        self.assertEqual(self.spaces[NEW]["status"], "validated")
        self.assertFalse(self.lock["locked"])

    def test_revalidation_failure_stops_before_the_flip(self):
        self.run_validation.side_effect = lambda *a, **k: validation_report(passed=False)
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("Re-validation did not pass: coverage", self.job["last_error"])
        self.assertEqual(self.db.committed["pointer"], OLD)
        self.assertEqual(self.db.statements("UPDATE embedding_spaces SET status = 'retired'"), [])
        self.assertFalse(self.lock["locked"])

    def test_wait_idle_timeout_fails_and_unlocks(self):
        self.db.tx["running_ingestion"] = 2
        self.db.committed = copy.deepcopy(self.db.tx)
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("2 ingestion run(s) were still running after 900 s", self.job["last_error"])
        self.assertFalse(self.lock["locked"])
        self.assertEqual(self.db.committed["pointer"], OLD)
        self.run_delta.assert_not_called()
        self.assertEqual(sum(self.clock.sleeps), 900)

    def test_wait_idle_timeout_is_configurable(self):
        self.db.tx["running_ingestion"] = 1
        self.db.committed = copy.deepcopy(self.db.tx)
        with mock.patch.dict("os.environ", {"ACTIVATE_IDLE_TIMEOUT_SECONDS": "30"}):
            self.go()
        self.assertIn("after 30 s", self.job["last_error"])
        self.assertFalse(self.lock["locked"])

    def test_an_unreleasable_lock_is_reported_and_left_to_the_ttl(self):
        original = self.db.handle

        def handle(n, p):
            if "SET cutover_locked = false" in n:
                raise RuntimeError("db gone")
            return original(n, p)

        self.db.handle = handle
        with self.assertLogs(level="ERROR") as logs:
            result = self.go()
        self.assertEqual(result["status"], "succeeded")
        self.assertIn("expires after", "\n".join(logs.output))
        self.assertIn("could not be released", self.job["last_error"])
        self.assertEqual(self.step_status()["unlock"], "failed")


class PostFlipFailureTest(CutoverBase):
    def test_quality_regression_fails_the_job_but_does_not_roll_back(self):
        self.evaluate.return_value = {"metrics": BAD_POST_FLIP}
        with self.assertLogs(level="ERROR") as logs:
            result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.job["status"], "failed")
        self.assertIn("QUALITY_BELOW_BASELINE", self.job["last_error"])
        self.emit.assert_called_once_with("PostFlipCheckFailed", "QUALITY_BELOW_BASELINE")
        self.assertTrue(any("Post-flip check failed" in line for line in logs.output))
        # The new space stays active; the operator decides about rollback.
        self.assertEqual(self.db.committed["pointer"], NEW)
        self.assertEqual(self.spaces[NEW]["status"], "active")
        self.assertEqual(self.spaces[OLD]["status"], "retired")
        self.assertEqual(len(self.db.statements("UPDATE embedding_active_space SET space_id")), 1)
        self.assertFalse(self.lock["locked"])
        self.assertEqual(self.step_status()["post_flip_check"], "failed")
        self.assertEqual(self.step_status()["flip"], "done")

    def test_an_error_during_the_post_flip_check_also_raises_the_alarm_metric(self):
        self.evaluate.side_effect = RuntimeError("bedrock down")
        self.go()
        self.emit.assert_called_once_with("PostFlipCheckFailed", "RuntimeError")
        self.assertEqual(self.db.committed["pointer"], NEW)
        self.assertFalse(self.lock["locked"])

    def test_failures_before_the_flip_do_not_emit_the_post_flip_metric(self):
        self.run_delta.side_effect = RuntimeError("x")
        self.go()
        self.emit.assert_not_called()

    def test_within_tolerance_passes(self):
        self.evaluate.return_value = {"metrics": dict(BASELINE, **{"recall@5": 0.76})}   # -0.04, tolerance 0.05
        self.assertEqual(self.go()["status"], "succeeded")
        self.emit.assert_not_called()

    def test_golden_check_helper(self):
        self.assertIsNone(cutover.golden_check(GOOD_POST_FLIP, BASELINE, 0.05))
        self.assertEqual(cutover.golden_check(BAD_POST_FLIP, BASELINE, 0.05), "QUALITY_BELOW_BASELINE")
        self.assertIsNone(cutover.golden_check({"recall@15": 0.4}, None, 0.05))
        self.assertEqual(cutover.golden_check({"recall@15": 0.0}, None, 0.05), "NO_RELEVANT_RESULTS")


class LockOwnershipTest(CutoverBase):
    def test_a_live_lock_held_by_another_job_blocks_the_cutover_and_is_left_alone(self):
        self.hold_lock(OTHER_JOB)
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("Another cutover holds the lock", self.job["last_error"])
        self.assertTrue(self.lock["locked"])
        self.assertEqual(self.lock["job_id"], OTHER_JOB)     # not released by us
        self.run_delta.assert_not_called()

    def test_a_lock_past_its_ttl_is_taken_over(self):
        self.hold_lock(OTHER_JOB, expired=True)
        self.assertEqual(self.go()["status"], "succeeded")
        self.assertFalse(self.lock["locked"])

    def test_the_ttl_constant_is_shared_with_the_ingestion_check(self):
        self.go()
        statement = self.db.statements("SET cutover_locked = true")[0]
        self.assertEqual(statement[2][2], ingestion_lock.LOCK_TTL_SECONDS)
        self.assertIn("make_interval(secs => %s)", statement[1])

    def test_while_locked_the_ingestion_check_rejects(self):
        seen = []

        def spy(*a, **k):
            conn = fakes.ScriptedConnection({"SELECT cutover_locked": [(True, None, JOB_ID, False)]})
            seen.append(ingestion_lock.is_locked(conn))
            return DeltaOutcome(done=True, processed=0, cursor=None)

        self.run_delta.side_effect = spy
        self.go()
        self.assertTrue(seen and seen[0])


class StateChangedTest(CutoverBase):
    def test_pointer_moved_since_the_request_fails_at_the_lock_step_and_unlocks(self):
        self.db.tx["pointer"] = "55555555-5555-4555-8555-555555555555"
        self.db.committed = copy.deepcopy(self.db.tx)
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("active space changed", self.job["last_error"])
        self.assertFalse(self.lock["locked"])

    def test_target_no_longer_validated_fails(self):
        self.db.tx["spaces"][NEW]["status"] = "building"
        self.db.committed = copy.deepcopy(self.db.tx)
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertIn("building", self.job["last_error"])
        self.assertFalse(self.lock["locked"])

    def test_missing_outgoing_space_in_the_job_fails(self):
        self.db.tx["job"]["report"] = {"request": {}}
        self.db.committed = copy.deepcopy(self.db.tx)
        self.assertEqual(self.go()["status"], "failed")
        self.assertFalse(self.lock["locked"])

    def test_terminal_and_wrong_mode_jobs_are_not_run(self):
        self.db.tx["job"]["status"] = "succeeded"
        self.db.committed = copy.deepcopy(self.db.tx)
        self.assertEqual(self.go()["status"], "succeeded")
        self.run_delta.assert_not_called()
        self.assertEqual(self.db.statements("SET cutover_locked = true"), [])

    def test_unknown_job(self):
        self.assertEqual(self.go({"task": "activate_space", "job_id": OTHER_JOB})["status"], "not_found")

    def test_re_entry_after_a_committed_flip_does_not_flip_twice(self):
        self.db.tx["pointer"] = NEW
        self.db.tx["spaces"][OLD]["status"] = "retired"
        self.db.tx["spaces"][NEW]["status"] = "active"
        self.db.committed = copy.deepcopy(self.db.tx)
        result = self.go()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.db.statements("UPDATE embedding_spaces SET status = 'retired'"), [])
        self.assertEqual([s["detail"] for s in self.job["steps"] if s["name"] == "flip"], ["already flipped"])


class ContinuationTest(CutoverBase):
    def test_wait_idle_hands_over_with_the_lock_kept_then_resumes(self):
        self.db.tx["running_ingestion"] = 1
        self.db.committed = copy.deepcopy(self.db.tx)
        low = mock.Mock()
        low.get_remaining_time_in_millis.return_value = 30_000
        result = self.go(context=low)
        self.assertEqual(result["status"], "continued")
        self.invoke.assert_called_once_with({"task": "activate_space", "job_id": JOB_ID, "continuation": 1})
        self.assertEqual(self.job["status"], "running")
        self.assertTrue(self.lock["locked"])                 # kept for the next invocation
        self.assertEqual(self.lock["job_id"], JOB_ID)
        self.assertEqual(self.job["continuation"], 1)
        self.assertEqual(self.step_status()["lock"], "done")
        self.assertEqual(self.step_status()["wait_idle"], "running")

        # Next invocation: ingestion finished, the cutover completes without re-locking.
        self.db.tx["running_ingestion"] = 0
        self.db.committed = copy.deepcopy(self.db.tx)
        self.db.log.clear()
        self.invoke.reset_mock()
        result = self.go(event={"task": "activate_space", "job_id": JOB_ID, "continuation": 1})
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.db.statements("SET cutover_locked = true"), [])
        self.assertEqual(self.db.committed["pointer"], NEW)
        self.assertFalse(self.lock["locked"])

    def test_delta_out_of_time_continues_from_the_stored_cursor(self):
        self.run_delta.side_effect = [DeltaOutcome(done=False, processed=10, cursor="c", out_of_time=True),
                                      DeltaOutcome(done=True, processed=5, cursor=None),
                                      DeltaOutcome(done=True, processed=0, cursor=None)]
        self.assertEqual(self.go()["status"], "continued")
        self.assertEqual(self.step_status()["delta"], "running")
        self.assertTrue(self.lock["locked"])
        self.assertEqual(self.go(event={"task": "activate_space", "job_id": JOB_ID, "continuation": 1})["status"], "succeeded")
        self.assertFalse(self.lock["locked"])

    def test_failed_self_invoke_fails_the_job_and_releases_the_lock(self):
        self.run_delta.return_value = DeltaOutcome(done=False, processed=0, cursor="c", out_of_time=True)
        self.invoke.side_effect = RuntimeError("cannot invoke")
        result = self.go()
        self.assertEqual(result["status"], "failed")
        self.assertFalse(self.lock["locked"])
        self.assertEqual(self.job["status"], "failed")

    def test_continuation_cap_fails_and_unlocks(self):
        result = self.go(event={"task": "activate_space", "job_id": JOB_ID, "continuation": cutover._MAX_CONTINUATIONS + 1})
        self.assertEqual(result["status"], "failed")
        self.assertIn("continuations", self.job["last_error"])
        self.assertFalse(self.lock["locked"])

    def test_post_flip_wait_hands_over_when_time_is_short(self):
        # Plenty of time until the flip, then little: the 65 s wait continues elsewhere.
        context = mock.Mock()
        times = {"n": 0}

        def remaining():
            times["n"] += 1
            return 600_000 if self.db.tx["pointer"] == OLD else 100_000

        context.get_remaining_time_in_millis.side_effect = remaining
        self.assertEqual(self.go(context=context)["status"], "continued")
        self.assertEqual(self.db.committed["pointer"], NEW)      # flipped, not yet verified
        self.assertTrue(self.lock["locked"])
        self.assertEqual(self.step_status()["post_flip_check"], "running")


class RollbackTest(CutoverBase):
    kind = "rollback"

    def test_rolls_back_to_the_retired_space_after_a_delta_on_it(self):
        order = []
        self.run_delta.side_effect = lambda conn, space, spec, **k: (
            order.append(("delta", str(space.id), self.db.tx["pointer"])) or DeltaOutcome(done=True, processed=0, cursor=None))
        result = self.go()
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(order[0], ("delta", NEW, OLD))      # delta on the RETIRED target, before the flip
        self.assertEqual(self.spaces[NEW]["status"], "active")
        self.assertEqual(self.spaces[OLD]["status"], "retired")
        self.assertEqual(self.db.committed["pointer"], NEW)
        self.assertIsNone(self.spaces[NEW]["retired_at"])
        self.assertEqual(self.db.statements("UPDATE embedding_spaces SET status = 'active'")[0][2], (NEW, "retired"))
        self.assertFalse(self.lock["locked"])

    def test_revalidation_is_coverage_only_and_post_flip_checks_sanity(self):
        self.go()
        self.assertFalse(self.run_validation.call_args.kwargs["include_quality"])
        self.evaluate.assert_called_once()
        self.assertNotIn("baseline", self.job["report"])

    def test_post_flip_sanity_failure_alarms_and_keeps_the_space_active(self):
        self.evaluate.return_value = {"metrics": {"recall@15": 0.0}}
        self.go()
        self.emit.assert_called_once_with("PostFlipCheckFailed", "NO_RELEVANT_RESULTS")
        self.assertEqual(self.db.committed["pointer"], NEW)
        self.assertFalse(self.lock["locked"])

    def test_lock_released_when_rollback_fails_early(self):
        self.run_delta.side_effect = RuntimeError("x")
        self.go()
        self.assertEqual(self.job["status"], "failed")
        self.assertFalse(self.lock["locked"])
        self.assertEqual(self.db.committed["pointer"], OLD)


class SecretsTest(CutoverBase):
    def test_nothing_in_the_job_or_logs_carries_text(self):
        self.run_validation.side_effect = RuntimeError("chunk body: private family story")
        with self.assertLogs(level="ERROR") as logs:
            self.go()
        self.assertNotIn("private family story", json.dumps(self.job))
        self.assertNotIn("private family story", "\n".join(logs.output))


# ── Routes: activate and rollback ─────────────────────────────────────────────

def event(path_suffix, email="admin@example.org", space_id=NEW):
    return {
        "httpMethod": "POST",
        "path": f"/admin/embedding-spaces/{space_id}/{path_suffix}",
        "resource": f"/admin/embedding-spaces/{{id}}/{path_suffix}",
        "pathParameters": {"id": space_id},
        "requestContext": {"authorizer": {"email": email}} if email else {},
        "headers": {},
    }


class CutoverRouteTest(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(ea, "invoke_self")
        self.invoke = patch.start()
        self.addCleanup(patch.stop)

    def conn(self, space_status="validated", pointer=OLD, running=None, locked=False, space=True):
        return fakes.ScriptedConnection({
            "SELECT id::text, name, status FROM embedding_spaces": [(NEW, "new", space_status)] if space else [],
            "SELECT space_id::text FROM embedding_active_space": [(pointer,)] if pointer else [],
            "SELECT cutover_locked": [(True, None, JOB_ID, False)] if locked else [(False, None, None, False)],
            "SELECT id::text FROM embedding_jobs WHERE status IN": [(running,)] if running else [],
            "INSERT INTO embedding_jobs": [(JOB_ID,)],
        })

    def post(self, suffix, conn, body=None, **kw):
        return ea.handle_embedding_request(event(suffix, **kw), body or {}, conn), conn

    def test_activate_accepts_a_validated_space(self):
        response, conn = self.post("activate", self.conn())
        self.assertEqual(response["statusCode"], 202)
        self.invoke.assert_called_once_with({"task": "activate_space", "job_id": JOB_ID, "continuation": 0})
        insert = conn.sql_with("INSERT INTO embedding_jobs")[0][1]
        self.assertEqual(insert[:3], (NEW, "activate", "admin@example.org"))
        self.assertEqual(json.loads(insert[3]), {"request": {}, "old_space_id": OLD, "new_space_id": NEW})

    def test_activate_passes_skip_quality(self):
        _, conn = self.post("activate", self.conn(), {"skip_quality": True})
        self.assertEqual(json.loads(conn.sql_with("INSERT INTO embedding_jobs")[0][1][3])["request"], {"skip_quality": True})
        response, _ = self.post("activate", self.conn(), {"skip_quality": "yes"})
        self.assertEqual(response["statusCode"], 400)

    def test_activate_refusals(self):
        cases = {
            "building": self.conn("building"),
            "retired (use rollback)": self.conn("retired"),
            "purged": self.conn("purged"),
            "already active": self.conn("active", pointer=NEW),
            "concurrent cutover": self.conn(running=OTHER_JOB),
            "sync lock held": self.conn(locked=True),
            "no active space": self.conn(pointer=None),
        }
        for label, conn in cases.items():
            with self.subTest(label):
                self.invoke.reset_mock()
                response, c = self.post("activate", conn)
                self.assertEqual(response["statusCode"], 409, label)
                self.assertEqual(c.sql_with("INSERT INTO embedding_jobs"), [])
                self.invoke.assert_not_called()

    def test_unknown_space_is_404(self):
        self.assertEqual(self.post("activate", self.conn(space=False))[0]["statusCode"], 404)
        self.assertEqual(self.post("rollback", self.conn(space=False))[0]["statusCode"], 404)

    def test_rollback_accepts_a_retired_space(self):
        response, conn = self.post("rollback", self.conn("retired"))
        self.assertEqual(response["statusCode"], 202)
        self.invoke.assert_called_once_with({"task": "rollback_space", "job_id": JOB_ID, "continuation": 0})
        self.assertEqual(conn.sql_with("INSERT INTO embedding_jobs")[0][1][1], "rollback")

    def test_rollback_refusals(self):
        cases = {
            "validated": self.conn("validated"),
            "building": self.conn("building"),
            "purged": self.conn("purged"),
            "already active": self.conn("active", pointer=NEW),
            "concurrent cutover": self.conn("retired", running=OTHER_JOB),
            "sync lock held": self.conn("retired", locked=True),
        }
        for label, conn in cases.items():
            with self.subTest(label):
                response, _ = self.post("rollback", conn)
                self.assertEqual(response["statusCode"], 409, label)
        self.invoke.assert_not_called()

    def test_unique_index_race_is_a_409(self):
        class Dup(Exception):
            pgcode = "23505"

        conn = self.conn()
        conn.fail_next("INSERT INTO embedding_jobs", Dup())
        self.assertEqual(self.post("activate", conn)[0]["statusCode"], 409)

    def test_stalled_cutover_jobs_are_reaped_with_the_lock_ttl(self):
        _, conn = self.post("activate", self.conn())
        reap = conn.sql_with("UPDATE embedding_jobs SET status = 'failed'")[0]
        self.assertEqual(reap[1], (["activate", "rollback"], ingestion_lock.LOCK_TTL_SECONDS))

    def test_unauthenticated_calls_are_rejected(self):
        for suffix in ("activate", "rollback"):
            response, conn = self.post(suffix, self.conn("retired" if suffix == "rollback" else "validated"), email=None)
            self.assertEqual(response["statusCode"], 401)
            self.assertEqual(conn.executed, [])
        self.invoke.assert_not_called()

    def test_start_failure_marks_the_job_failed(self):
        self.invoke.side_effect = RuntimeError("down")
        response, conn = self.post("activate", self.conn())
        self.assertEqual(response["statusCode"], 502)
        self.assertTrue(conn.sql_with("UPDATE embedding_jobs SET status = 'failed', finished_at = now()"))


if __name__ == "__main__":
    unittest.main()
