import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals import report, schema
from evals.harness.simulator import ParentSimulator, build_messages, build_system
from evals.judge import bedrock_eval, judge, routing_metrics

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "scenarios"


def scenario():
    return schema.load_scenario(FIXTURES / "j9_f1" / "X01.yaml")


def routing(journey, situation, conf="HIGH", secondary="NONE", seen=None):
    return {"journey": journey, "situation": situation, "secondary_situation": secondary,
            "confidence": conf, "clusters_seen": seen or []}


def transcript(mode="standard", guidance_turn=1):
    return {
        "story_id": "X01", "mode": mode, "expected": {"journey_key": "J1", "clusters": ["A", "B"]},
        "turns": [
            {"index": 0, "user": "My daughter keeps getting sent home.", "response": "That sounds hard. What happened?",
             "phase": "DETECTIVE", "sources": [], "routing": routing("J1", "C") if mode == "standard" else {}},
            {"index": 1, "user": "Three times this month.", "response": "Here is guidance: keep a record.",
             "phase": "SUGGESTION", "sources": [{"title": "Guide", "content": "Keep a dated record."}],
             "warning": None, "routing": routing("J1", "A") if mode == "standard" else {}},
        ],
        "outcome": {"stopped": "guidance", "reached_guidance": guidance_turn is not None,
                    "guidance_turn": guidance_turn, "turns": 2},
    }


class RoutingMetricsTest(unittest.TestCase):
    def test_probe_and_journey_accuracy(self):
        probes = [{
            "story_id": "X01", "expected": {"journey_key": "J1", "clusters": ["A", "B"]},
            "probes": [
                {"kind": "opening", "routing": routing("J1", "A")},
                {"kind": "variant", "routing": routing("J2", "K", conf="LOW")},
                {"kind": "variant", "routing": routing("J1", "C", secondary="B")},
                {"kind": "negative", "routing": routing("J1", "A")},
                {"kind": "negative", "routing": routing("UNCLEAR", "UNKNOWN")},
                {"kind": "variant", "error": "timeout"},
            ],
        }]
        m = routing_metrics.compute(probes, [transcript()])
        self.assertEqual(m["probes"]["count"], 3)
        self.assertAlmostEqual(m["probes"]["journey_accuracy"], 0.667)
        self.assertAlmostEqual(m["probes"]["situation_accuracy"], 0.333)
        self.assertAlmostEqual(m["probes"]["secondary_match_rate"], 0.333)
        self.assertEqual(m["negatives"], {"count": 2, "false_positives": 1, "false_positive_rate": 0.5})
        self.assertEqual(m["journey_confusion"]["J1"], {"J1": 2, "J2": 1})
        self.assertEqual(m["journey_confusion"]["not J1"], {"J1": 1, "UNCLEAR": 1})
        self.assertEqual(m["journeys_first_turn"]["situation_accuracy"], 0.0)
        self.assertEqual(m["journeys_final_turn"]["situation_accuracy"], 1.0)
        self.assertEqual(len(m["failures"]), 1)
        self.assertEqual(m["confidence"]["LOW"], 1)

    def test_guideline_transcripts_are_ignored(self):
        m = routing_metrics.compute([], [transcript("guideline")])
        self.assertEqual(m["journeys_first_turn"]["count"], 0)

    def test_no_expected_clusters_means_no_situation_score(self):
        probes = [{"story_id": "X", "expected": {"journey_key": "J1", "clusters": []},
                   "probes": [{"kind": "opening", "routing": routing("J1", "A")}]}]
        m = routing_metrics.compute(probes, [])
        self.assertEqual(m["probes"]["journey_accuracy"], 1.0)
        self.assertIsNone(m["probes"]["situation_accuracy"])


ASSESSMENT = {
    "reference_flow": [{"step": 1, "verdict": "present_first_reply"}, {"step": 2, "verdict": "present_later"}],
    "criteria": [{"item": 1, "verdict": "met"}, {"item": 2, "verdict": "partial"},
                 {"item": 3, "verdict": "not_met"}, {"item": 4, "verdict": "not_applicable"}],
    "detective": {"score": 4, "repeated_questions": False, "premature_guidance": False},
    "product_rules": [{"rule": "no_legal_advice", "verdict": "pass"}, {"rule": "no_blame", "verdict": "fail"},
                      {"rule": "no_speculation", "verdict": "unclear"}],
    "grounding": {"score": 5},
}


class JudgeTest(unittest.TestCase):
    def test_prompt_contains_rubric_parts_and_transcript(self):
        prompt = judge.build_prompt(scenario(), transcript())
        self.assertIn("1. Acknowledge the situation.", prompt)
        self.assertIn("1. recognize the reduced schedule", prompt)
        self.assertIn("3. encourage documentation", prompt)  # testing checks follow criteria
        self.assertIn('Helps the parent answer: "What can I do next?" rather than only: "Who is at fault?"', prompt)
        self.assertIn("Assistant (GUIDANCE TURN): Here is guidance", prompt)
        self.assertIn("Cited sources (previews): Guide: Keep a dated record.", prompt)
        self.assertIn("no_deficit_language", prompt)
        self.assertIn("STANDARD mode", prompt)
        self.assertIn("GUIDELINE mode", judge.build_prompt(scenario(), transcript("guideline")))

    def test_no_guidance_is_flagged(self):
        self.assertIn("never reached a guidance turn", judge.render_transcript(transcript(guidance_turn=None)))

    def test_scoring(self):
        s = judge.score(ASSESSMENT, scenario())
        self.assertEqual(s["reference_flow"], 0.875)
        self.assertEqual(s["reference_flow_first_reply"], 0.5)
        self.assertEqual(s["acceptance_criteria"], 0.5)
        self.assertEqual(s["criteria_judged"], 3)
        self.assertEqual(s["criteria_expected"], 4)
        self.assertEqual(s["detective"], 0.8)
        self.assertEqual(s["product_rules_pass_rate"], 0.5)
        self.assertEqual(s["product_rule_failures"], ["no_blame"])
        self.assertEqual(s["grounding"], 1.0)

    def test_assess_uses_forced_tool_and_judge_model(self):
        client = mock.Mock()
        client.converse.return_value = {"output": {"message": {"content": [
            {"toolUse": {"name": judge.JUDGE_TOOL, "input": ASSESSMENT}}]}}}
        out = judge.Judge(client, "us.anthropic.claude-opus-4-6-v1").assess(scenario(), transcript())
        kwargs = client.converse.call_args.kwargs
        self.assertEqual(kwargs["modelId"], "us.anthropic.claude-opus-4-6-v1")
        self.assertEqual(kwargs["toolConfig"]["toolChoice"], {"tool": {"name": judge.JUDGE_TOOL}})
        rules = kwargs["toolConfig"]["tools"][0]["toolSpec"]["inputSchema"]["json"]["properties"]["product_rules"]
        self.assertEqual(len(rules["items"]["properties"]["rule"]["enum"]), 6)
        self.assertEqual(out["turns_to_guidance"], 2)
        self.assertEqual(out["scores"]["acceptance_criteria"], 0.5)

    def test_missing_tool_output(self):
        client = mock.Mock()
        client.converse.return_value = {"output": {"message": {"content": [{"text": "no"}]}}}
        self.assertIn("error", judge.Judge(client, "m").assess(scenario(), transcript()))


class SimulatorTest(unittest.TestCase):
    def test_system_prompt_uses_persona_facts_and_opening(self):
        system = build_system(scenario())
        self.assertIn("Grade 3", system)
        self.assertIn("- It has happened three times this month.", system)
        self.assertIn("My daughter keeps getting sent home before lunch", system)
        self.assertIn("Never mention that you are an AI", system)

    def test_messages_alternate_from_assistant_point_of_view(self):
        msgs = build_messages(transcript()["turns"])
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant", "user"])
        self.assertEqual(msgs[0]["content"][0]["text"], "That sounds hard. What happened?")
        self.assertEqual(msgs[1]["content"][0]["text"], "Three times this month.")

    def test_reply_is_trimmed(self):
        client = mock.Mock()
        client.converse.return_value = {"output": {"message": {"content": [{"text": '  "It was   Tuesday."  '}]}}}
        sim = ParentSimulator(client, "haiku")
        self.assertEqual(sim.reply(scenario(), transcript()["turns"][:1]), "It was Tuesday.")
        self.assertEqual(sim.reply(scenario(), []), scenario().opening_message)


class BedrockEvalTest(unittest.TestCase):
    def test_record_shape(self):
        rec = bedrock_eval.record_for(scenario(), transcript())
        turn = rec["conversationTurns"][0]
        self.assertEqual(turn["prompt"]["content"][0]["text"].splitlines(), [
            "Parent: My daughter keeps getting sent home.",
            "Assistant: That sounds hard. What happened?",
            "Parent: Three times this month.",
        ])
        self.assertIn("- recognize the reduced schedule", turn["referenceResponses"][0]["content"][0]["text"])
        self.assertEqual(turn["output"]["text"], "Here is guidance: keep a record.")
        self.assertEqual(turn["output"]["knowledgeBaseIdentifier"], "knowledge-compass-standard")
        self.assertEqual(turn["output"]["retrievedPassages"]["retrievalResults"],
                         [{"name": "Guide", "content": {"text": "Keep a dated record."}}])

    def test_falls_back_to_last_reply_and_splits_by_mode(self):
        data = bedrock_eval.build_datasets({"X01": scenario()}, [
            transcript(guidance_turn=None), transcript("guideline"), {"story_id": "unknown", "turns": []},
        ])
        self.assertEqual(sorted(data), ["guideline", "standard"])
        self.assertEqual(data["standard"][0]["conversationTurns"][0]["output"]["text"], "Here is guidance: keep a record.")

    def test_record_cap(self):
        with mock.patch.object(bedrock_eval, "MAX_RECORDS", 1):
            with self.assertRaises(ValueError):
                bedrock_eval.build_datasets({"X01": scenario()}, [transcript(), transcript()])

    def test_job_request(self):
        req = bedrock_eval.job_request("kc-eval-x-standard", "arn:role", "s3://b/input/x.jsonl", "s3://b/output/x/",
                                       "us.anthropic.claude-opus-4-6-v1", "standard")
        self.assertEqual(req["applicationType"], "RagEvaluation")
        cfg = req["evaluationConfig"]["automated"]
        names = cfg["datasetMetricConfigs"][0]["metricNames"]
        self.assertIn("Builtin.Faithfulness", names)
        self.assertIn("kc-acceptance-criteria", names)
        custom = cfg["customMetricConfig"]["customMetrics"]
        self.assertLessEqual(len(custom), 10)
        for m in custom:
            d = m["customMetricDefinition"]
            self.assertTrue(d["instructions"].rstrip().endswith("{{prediction}}"))
            self.assertTrue(all(len(r["definition"].split()) <= 5 for r in d["ratingScale"]))
        self.assertEqual(req["inferenceConfig"]["ragConfigs"][0]["precomputedRagSourceConfig"]
                         ["retrieveAndGenerateSourceConfig"]["ragSourceIdentifier"], "knowledge-compass-standard")

    def test_job_name_is_valid(self):
        name = bedrock_eval.job_name("run_20261014T120000Z_ABC123", "guideline")
        self.assertRegex(name, r"^[a-z0-9](-*[a-z0-9]){0,62}$")
        self.assertLessEqual(len(bedrock_eval.job_name("x" * 100, "standard")), 63)

    def test_lifecycle_with_mocked_clients(self):
        bedrock, s3 = mock.Mock(), mock.Mock()
        bedrock.create_evaluation_job.return_value = {"jobArn": "arn:job"}
        bedrock.get_evaluation_job.side_effect = [{"status": "InProgress"}, {"status": "Completed"}]
        line = json.dumps({"automatedEvaluationResult": {"scores": [
            {"metricName": "Builtin.Correctness", "result": 0.8}, {"metricName": "kc-no-blame", "result": 1.0}]}})
        s3.list_objects_v2.return_value = {"Contents": [{"Key": "output/r/standard/job/uuid/out.jsonl"},
                                                        {"Key": "output/r/standard/job/uuid/custom_metrics/m.json"}]}
        s3.get_object.return_value = {"Body": mock.Mock(read=lambda: (line + "\n" + line.replace("0.8", "0.6")).encode())}
        ev = bedrock_eval.BedrockEvaluation(bedrock, s3, "bucket", "arn:role", "judge", sleep=lambda s: None, log=lambda m: None)
        job = ev.start("r", "standard", [bedrock_eval.record_for(scenario(), transcript())])
        put = s3.put_object.call_args.kwargs
        self.assertEqual(put["Key"], "input/r/standard.jsonl")
        self.assertEqual(len(put["Body"].decode().strip().splitlines()), 1)
        self.assertEqual(ev.wait(job["job_arn"], poll_seconds=1)["status"], "Completed")
        metrics = ev.results(job["output_prefix"])
        self.assertEqual(metrics["Builtin.Correctness"], {"mean": 0.7, "count": 2})
        self.assertEqual(metrics["kc-no-blame"]["count"], 2)
        s3.get_object.assert_called_once()  # custom_metrics definitions are skipped


class ReportTest(unittest.TestCase):
    def test_report_with_mode_deltas(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run_x"
            (run / "journeys").mkdir(parents=True)
            (run / "judge").mkdir()
            (run / "run.json").write_text(json.dumps({"run_id": "run_x", "stories": ["X01"], "modes": ["standard", "guideline"],
                                                      "global_prompt_mode_before": "standard",
                                                      "global_prompt_mode_after": "standard"}), encoding="utf-8")
            for mode, crit in (("standard", 0.5), ("guideline", 0.75)):
                (run / "journeys" / f"X01_{mode}.json").write_text(json.dumps(transcript(mode)), encoding="utf-8")
                (run / "judge" / f"X01_{mode}.json").write_text(json.dumps({
                    "story_id": "X01", "mode": mode, "reached_guidance": True, "turns_to_guidance": 2,
                    "scores": {**judge.score(ASSESSMENT, scenario()), "acceptance_criteria": crit},
                }), encoding="utf-8")
            rep = report.write(run)
            self.assertEqual(rep["mode_comparison"]["per_story"]["X01"]["acceptance_criteria"], 0.25)
            self.assertEqual(rep["judge"]["standard"]["stories"], 1)
            md = (run / "report.md").read_text(encoding="utf-8")
            self.assertIn("Global prompt mode before/after: standard/standard", md)
            self.assertIn("## Guideline minus standard", md)
            self.assertIn("| X01 | guideline |", md)


if __name__ == "__main__":
    unittest.main()
