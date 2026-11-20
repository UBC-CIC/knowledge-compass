import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals import schema
from evals.guardrail_cases import GuardrailCase
from evals.harness.runner import RunConfig, Runner, is_guidance
from evals.harness.client import TurnResult
from evals.harness.signing import SigningKeyProvider
from evals.tests.fakes import KEY, FakeBackend
from evals.tests.test_client import make_client

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "scenarios"


def _keys():
    client = mock.Mock()
    client.get_secret_value.return_value = {"SecretString": json.dumps({"signingKey": KEY})}
    return SigningKeyProvider("s", "r", secrets_client=client)


class FakeSimulator:
    def __init__(self, replies=None):
        self.calls = 0
        self.replies = replies

    def reply(self, scenario, turns):
        self.calls += 1
        if self.replies is not None:
            return self.replies.pop(0) if self.replies else ""
        return f"parent answer {len(turns)}"


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scenario = schema.load_scenario(FIXTURES / "j9_f1" / "X01.yaml")
        self.label_map = schema.load_label_map(FIXTURES)

    def tearDown(self):
        self.tmp.cleanup()

    def runner(self, backend, simulator=None, **config):
        client, _ = make_client(backend)
        cfg = RunConfig(run_id="run_test", turn_delay=0, user_delay=0, **config)
        return Runner(client, _keys(), simulator if simulator is not None else FakeSimulator(), cfg,
                      label_map=self.label_map, results_root=self.root, sleep=lambda s: None, log=lambda m: None)

    def test_journey_stops_at_first_guidance_and_cleans_up(self):
        backend = FakeBackend()
        r = self.runner(backend)
        t = r.run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["stopped"], "guidance")
        self.assertEqual(t["outcome"]["guidance_turn"], 2)
        self.assertEqual([turn["phase"] for turn in t["turns"]], ["DETECTIVE", "DETECTIVE", "SUGGESTION"])
        self.assertEqual(t["turns"][0]["user"], self.scenario.opening_message)
        self.assertEqual(t["turns"][1]["user"], "parent answer 1")
        self.assertEqual(t["turns"][0]["routing"]["journey"], "J1")
        self.assertEqual(t["expected"], {"journey_key": "J1", "clusters": ["A", "B"]})
        self.assertTrue(t["cleaned_up"])
        self.assertEqual(backend.sessions, {})
        saved = json.loads((self.root / "run_test" / "journeys" / "X01_standard.json").read_text(encoding="utf-8"))
        self.assertTrue(saved["cleaned_up"])

    def test_every_session_is_tagged_with_mode(self):
        backend = FakeBackend()
        r = self.runner(backend, keep_sessions=True)
        r.run_journey(self.scenario, "guideline")
        (session,) = backend.sessions.values()
        self.assertEqual(session["eval_run_id"], "run_test")
        self.assertEqual(session["prompt_mode_override"], "guideline")

    def test_follow_up_turns_and_max_turns(self):
        backend = FakeBackend()
        t = self.runner(backend, follow_up_turns=1).run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["turns"], 4)
        self.assertEqual(t["outcome"]["guidance_turn"], 2)

        backend = FakeBackend(reply=lambda s, m, n: {"response": f"q{n}?", "phase": "DETECTIVE"})
        t = self.runner(backend, max_turns=3).run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["stopped"], "max_turns")
        self.assertEqual(t["outcome"]["turns"], 3)
        self.assertFalse(t["outcome"]["reached_guidance"])

    def test_limit_and_error_stop(self):
        backend = FakeBackend(reply=lambda s, m, n: {"response": "Daily message limit exceeded. Please try again tomorrow.", "phase": None})
        t = self.runner(backend).run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["stopped"], "limit")
        backend = FakeBackend(reply=lambda s, m, n: {"error": "Internal server error"})
        t = self.runner(backend).run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["stopped"], "error")
        self.assertEqual(backend.sessions, {})

    def test_simulator_giving_up_stops(self):
        backend = FakeBackend()
        t = self.runner(backend, simulator=FakeSimulator(replies=[])).run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["stopped"], "simulator")

    def test_budget_stop(self):
        backend = FakeBackend()
        sim = FakeSimulator(replies=["x" * 9500])
        t = self.runner(backend, simulator=sim).run_journey(self.scenario, "standard")
        self.assertEqual(t["outcome"]["stopped"], "budget")

    def test_guideline_guidance_needs_citations(self):
        self.assertFalse(is_guidance(TurnResult(phase="SUGGESTION", response="q?"), "guideline"))
        self.assertTrue(is_guidance(TurnResult(phase="SUGGESTION", response="a", sources=[{}]), "guideline"))
        self.assertTrue(is_guidance(TurnResult(phase="SUGGESTION", response="a"), "standard"))

    def test_probes_use_fresh_users_and_record_routing(self):
        backend = FakeBackend()
        out = self.runner(backend).run_probes(self.scenario)
        kinds = [p["kind"] for p in out["probes"]]
        self.assertEqual(kinds, ["opening", "variant", "negative"])
        self.assertEqual(len(backend.users), 3)
        self.assertTrue(all(p["routing"]["journey"] == "J1" for p in out["probes"]))
        self.assertEqual(backend.sessions, {})
        self.assertTrue((self.root / "run_test" / "probes" / "X01.json").exists())

    def test_probes_skip_cases_without_messages(self):
        self.scenario.variants[0].message = ""
        out = self.runner(FakeBackend()).run_probes(self.scenario)
        self.assertEqual(out["skipped_without_message"], ["attending only mornings"])

    def test_failed_cleanup_is_recorded(self):
        backend = FakeBackend()
        backend.delete_fails = True
        r = self.runner(backend)
        manifest = r.run([self.scenario])
        self.assertTrue(manifest["cleanup_failed"])
        self.assertTrue(all(set(c) == {"user_id", "session_id", "error"} for c in manifest["cleanup_failed"]))

    def test_run_fans_out_modes_and_writes_manifest(self):
        backend = FakeBackend()
        manifest = self.runner(backend, modes=["standard", "guideline"]).run([self.scenario])
        files = sorted(p.name for p in (self.root / "run_test" / "journeys").glob("*.json"))
        self.assertEqual(files, ["X01_guideline.json", "X01_standard.json"])
        self.assertEqual(manifest["sessions_created"], manifest["sessions_deleted"])
        self.assertEqual(manifest["errors"], [])
        # One chat path, so both modes record the journey key and any cited section.
        g = json.loads((self.root / "run_test" / "journeys" / "X01_guideline.json").read_text(encoding="utf-8"))
        self.assertTrue(all(turn["routing"]["journey"] == "J1" for turn in g["turns"]))

    def test_probes_only_and_journeys_only(self):
        backend = FakeBackend()
        self.runner(backend, journeys=False).run([self.scenario])
        self.assertFalse((self.root / "run_test" / "journeys").exists())
        backend = FakeBackend()
        r = self.runner(backend, probes=False)
        r.out = self.root / "run_j"
        r.run([self.scenario])
        self.assertFalse((self.root / "run_j" / "probes").exists())

    def test_guardrail_case_uses_fresh_user_records_reply_and_cleans_up(self):
        backend = FakeBackend(reply=lambda s, m, n: {"response": "I can only help with a child's schooling.",
                                                     "phase": "DETECTIVE"})
        r = self.runner(backend)
        case = GuardrailCase(id="O3", category="off_topic", expected="decline",
                             message="What's a good recipe for banana bread?", expectations=["kindly declines"])
        first = r.run_guardrail_case(case)
        r.run_guardrail_case(case)
        self.assertEqual(len(backend.users), 2)
        self.assertEqual(first["response"], "I can only help with a child's schooling.")
        self.assertEqual(first["user"], case.message)
        self.assertEqual((first["case_id"], first["expected"], first["mode"]), ("O3", "decline", "standard"))
        self.assertTrue(first["cleaned_up"])
        self.assertEqual(backend.sessions, {})
        saved = json.loads((self.root / "run_test" / "guardrails" / "O3.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["expectations"], ["kindly declines"])
        self.assertTrue(saved["cleaned_up"])


if __name__ == "__main__":
    unittest.main()
