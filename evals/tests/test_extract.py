import tempfile
import unittest
from pathlib import Path
from unittest import mock

from evals import extract as ex
from evals import schema

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "stories_excerpt.md"


def _doc():
    return ex.parse_document(FIXTURE.read_text(encoding="utf-8"), FIXTURE.name)


def _scenario(story_id):
    doc = _doc()
    story = next(s for s in doc.stories if s.story_id == story_id)
    return ex.story_to_scenario(doc, story, FIXTURE.name)


class BulletRepairTest(unittest.TestCase):
    def test_wrapped_item_is_joined(self):
        lines = [
            "recognize when a parent is being asked to pick up their child before the end of the school day",
            "help the parent remain calm and gather information before responding",
            "help distinguish between emergencies, safety concerns, behavioural concerns, support",
            "limitations, and administrative convenience",
            "avoid providing legal advice",
        ]
        merged = ex.merge_wrapped(lines, 4)
        self.assertEqual(len(merged), 4)
        self.assertEqual(merged[2], "help distinguish between emergencies, safety concerns, behavioural concerns, "
                                    "support limitations, and administrative convenience")
        self.assertTrue(merged[0].endswith("school day"))

    def test_no_merge_when_counts_match(self):
        self.assertEqual(ex.merge_wrapped(["a", "b"], 2), ["a", "b"])
        self.assertEqual(ex.merge_wrapped(["a"], 3), ["a"])

    def test_blocks_groups_bullet_runs_and_inline_bullets(self):
        lines = ex.normalize_lines("Intro:\n•\n•\n\nfirst item\nsecond item\n\n• inline one\ncontinued\n• inline two\n")
        kinds = ex.blocks(lines)
        self.assertEqual(kinds[0], ("text", "Intro:"))
        self.assertEqual(kinds[1], ("list", ["first item", "second item"]))
        self.assertEqual(kinds[2], ("list", ["inline one continued", "inline two"]))


class DocumentTest(unittest.TestCase):
    def test_header_and_story_split(self):
        doc = _doc()
        self.assertEqual(doc.journey_number, 1)
        self.assertEqual(doc.journey_name, "Involuntary Partial Day Attendance Navigation")
        self.assertEqual(doc.feature_number, 1)
        self.assertTrue(doc.feature_name.startswith("Guide parents"))
        self.assertEqual([s.story_id for s in doc.stories], ["111", "114", "11A"])
        self.assertEqual(doc.problems, [])

    def test_wrapped_story_heading(self):
        s = _scenario("111")
        self.assertTrue(s.story_text.startswith("As a parent, I want the system to recognize"))
        self.assertTrue(s.story_text.endswith("so I understand what is happening."))

    def test_inline_bullet_criteria_and_flow(self):
        s = _scenario("111")
        self.assertEqual(s.acceptance_criteria, [
            "recognize when a parent describes circumstances consistent with involuntary partial day attendance",
            "identify the situation using clear, parent-friendly language",
            "avoid legal conclusions or assigning fault",
        ])
        self.assertEqual(s.opening_message,
                         "My son keeps getting sent home before lunch because the school says they can’t support him all day.")
        self.assertEqual([st.step for st in s.reference_flow],
                         ["Acknowledge the situation.", "Identify the situation.", "Offer the next step."])
        self.assertIn("initiated by the school.”", s.reference_flow[0].text)
        self.assertEqual(s.content_required, ["definition of involuntary partial day attendance",
                                              "plain-language explanation suitable for parents"])

    def test_testing_considerations_split_into_variants_and_negatives(self):
        s = _scenario("111")
        self.assertEqual([v.description for v in s.variants], [
            "being sent home early every day", "attending only mornings",
            "reduced attendance due to lack of nursing or support resources",
        ])
        self.assertEqual([n.description for n in s.negative_cases],
                         ["family-requested reduced schedules", "temporary suspensions"])
        self.assertEqual(s.testing_checks, [])  # "Why:" list is not a testing item
        self.assertIn("Complexity: 🟢 Small (1–2 days)", s.notes)

    def test_bullet_runs_with_wraps_and_sub_bullets(self):
        s = _scenario("114")
        self.assertEqual(len(s.acceptance_criteria), 4)
        self.assertIn("support limitations, and administrative convenience", s.acceptance_criteria[2])
        self.assertEqual(s.content_required, [
            "common reasons schools request early pickup",
            "questions parents can ask during pickup calls",
            "guidance on responding constructively during difficult conversations",
        ])
        self.assertIn("the reason for the request; whether this has happened before", s.reference_flow[1].text)
        # Heading joined onto the paragraph before it.
        self.assertEqual([v.description for v in s.variants],
                         ["the call involves a safety concern", "the situation has happened repeatedly"])
        self.assertEqual(s.testing_checks, ["gather information before suggesting actions", "encourage documentation"])

    def test_guiding_question_and_future_notes(self):
        s = _scenario("11A")
        self.assertEqual(s.story_id, "11A")
        self.assertEqual(s.testing_checks, ["suggests a follow-up message", "encourages record keeping"])
        self.assertEqual(s.guiding_question, "What can I do when the school does not reply?")
        self.assertEqual(s.avoid_framing, "Who is to blame for the silence?")
        self.assertIn("Future enhancement: reminder scheduling", s.notes)

    def test_missing_sections_reported(self):
        doc = ex.parse_document("USER JOURNEY 1: J\nFEATURE 1: F\nUSER STORY 101: As a parent, x.\n🟦 1. Situation\ntext\n", "t.md")
        self.assertTrue(any("missing section" in p for p in doc.problems))

    def test_classify_intro(self):
        cases = {
            "Testers should verify that the system correctly recognizes situations such as:": "variant",
            "Testers should verify the system appropriately responds when the school:": "variant",
            "And that it does not incorrectly classify:": "negative",
            "Testers should verify the system:": "check",
            "The system should consistently:": "check",
            "The system should consistently help parents answer:": "guiding",
            "rather than:": "avoid",
            "This story has strong overlap with:": "other",
        }
        for text, expected in cases.items():
            self.assertEqual(ex.classify_intro(text), expected, text)


def _fake_bedrock(tool_input):
    client = mock.Mock()
    client.converse.return_value = {
        "output": {"message": {"content": [{"toolUse": {"name": ex.DRAFT_TOOL, "input": tool_input}}]}}
    }
    return client


class ExtractRunTest(unittest.TestCase):
    def _source(self, tmp):
        src = Path(tmp) / "src"
        src.mkdir()
        (src / FIXTURE.name).write_text(FIXTURE.read_text(encoding="utf-8"), encoding="utf-8")
        return src

    def test_writes_drafts_and_label_map_without_llm(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "scenarios"
            result = ex.extract(self._source(tmp), out, catalog=[{"key": "J1", "name": "x", "clusters": []}], log=lambda *_: None)
            self.assertEqual(sorted(result.written), ["111", "114", "11A"])
            s = schema.load_scenario(out / "j1_f1" / "111.yaml")
            self.assertFalse(s.reviewed)
            lm = schema.load_label_map(out)
            self.assertEqual(lm.journeys[1]["journey_key"], "J1")
            self.assertEqual(lm.stories["111"]["clusters"], [])
            self.assertEqual(schema.validate_directory(out), [])

    def test_llm_draft_fills_messages_and_valid_cluster_suggestions(self):
        catalog = [{"key": "J1", "name": "PDA", "clusters": [{"key": "A", "name": "a", "matches_when": "m"},
                                                              {"key": "C", "name": "c", "matches_when": "m"}]}]
        def draft_for(**kwargs):
            text = kwargs["messages"][0]["content"][0]["text"]
            n_var = 3 if "User story 111" in text else (2 if "User story 114" in text else 0)
            n_neg = 2 if "User story 111" in text else 0
            return {"output": {"message": {"content": [{"toolUse": {"name": ex.DRAFT_TOOL, "input": {
                "persona": "A parent of a Grade 2 student.",
                "hidden_facts": ["It happened twice."],
                "variant_messages": [f"variant {i}" for i in range(n_var)],
                "negative_messages": [f"negative {i}" for i in range(n_neg)],
                "suggested_clusters": ["A", "ZZ"],
            }}}]}}}
        client = mock.Mock()
        client.converse.side_effect = draft_for
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "scenarios"
            ex.extract(self._source(tmp), out, bedrock_client=client, model_id="m", catalog=catalog, log=lambda *_: None)
            s = schema.load_scenario(out / "j1_f1" / "111.yaml")
            self.assertEqual(s.persona, "A parent of a Grade 2 student.")
            self.assertEqual([v.message for v in s.variants], ["variant 0", "variant 1", "variant 2"])
            self.assertEqual([n.message for n in s.negative_cases], ["negative 0", "negative 1"])
            lm = schema.load_label_map(out)
            self.assertEqual(lm.stories["111"]["clusters"], ["A"])  # unknown key dropped
            self.assertEqual(lm.stories["111"]["suggested_by"], "llm")
            # Verbatim fields are never sent through the model's output.
            self.assertIn("avoid legal conclusions or assigning fault", s.acceptance_criteria)

    def test_mismatched_message_counts_are_ignored(self):
        s = _scenario("111")
        ex.apply_draft(s, {"variant_messages": ["only one"], "negative_messages": [], "persona": "p"}, [])
        self.assertTrue(all(not v.message for v in s.variants))
        self.assertEqual(s.persona, "p")

    def test_reviewed_files_are_kept_and_unreviewed_keep_llm_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            src, out = self._source(tmp), Path(tmp) / "scenarios"
            ex.extract(src, out, log=lambda *_: None)
            p111 = out / "j1_f1" / "111.yaml"
            p114 = out / "j1_f1" / "114.yaml"
            d = schema.read_yaml(p111)
            d["reviewed"] = True
            d["persona"] = "edited by reviewer"
            schema.write_yaml(p111, d)
            d = schema.read_yaml(p114)
            d["persona"] = "drafted earlier"
            d["testable"] = False
            schema.write_yaml(p114, d)

            result = ex.extract(src, out, log=lambda *_: None)
            self.assertEqual(result.kept_reviewed, ["111"])
            self.assertEqual(schema.load_scenario(p111).persona, "edited by reviewer")
            s114 = schema.load_scenario(p114)
            self.assertEqual(s114.persona, "drafted earlier")
            self.assertFalse(s114.testable)

            ex.extract(src, out, overwrite=True, log=lambda *_: None)
            self.assertFalse(schema.load_scenario(p111).reviewed)

    def test_fill_missing_keeps_reviewer_edits_and_reopens(self):
        def draft(**kwargs):
            text = kwargs["messages"][0]["content"][0]["text"]
            n_var = 3 if "User story 111" in text else (2 if "User story 114" in text else 0)
            n_neg = 2 if "User story 111" in text else 0
            return {"output": {"message": {"content": [{"toolUse": {"name": ex.DRAFT_TOOL, "input": {
                "persona": "drafted persona", "hidden_facts": ["drafted fact"],
                "variant_messages": [f"v{i}" for i in range(n_var)],
                "negative_messages": [f"n{i}" for i in range(n_neg)], "suggested_clusters": [],
            }}}]}}}
        client = mock.Mock()
        client.converse.side_effect = draft
        with tempfile.TemporaryDirectory() as tmp:
            src, out = self._source(tmp), Path(tmp) / "scenarios"
            ex.extract(src, out, log=lambda *_: None)
            p111 = out / "j1_f1" / "111.yaml"
            d = schema.read_yaml(p111)
            d.update(reviewed=True, opening_message="edited by reviewer", testable=False)
            d["variants"][0]["message"] = "reviewer message"
            schema.write_yaml(p111, d)

            result = ex.extract(src, out, bedrock_client=client, model_id="m", fill_missing=True, log=lambda *_: None)
            s = schema.load_scenario(p111)
            self.assertEqual(s.opening_message, "edited by reviewer")
            self.assertFalse(s.testable)
            self.assertEqual([v.message for v in s.variants], ["reviewer message", "v1", "v2"])
            self.assertEqual(s.persona, "drafted persona")
            self.assertFalse(s.reviewed)
            self.assertIn("111", result.reopened)

            # Nothing missing any more: no further Bedrock calls.
            calls = client.converse.call_count
            ex.extract(src, out, bedrock_client=client, model_id="m", fill_missing=True, log=lambda *_: None)
            self.assertEqual(client.converse.call_count, calls)

    def test_failed_llm_call_keeps_deterministic_draft(self):
        client = mock.Mock()
        client.converse.side_effect = ValueError("boom")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "scenarios"
            result = ex.extract(self._source(tmp), out, bedrock_client=client, model_id="m", log=lambda *_: None)
            self.assertEqual(len(result.written), 3)
            self.assertTrue(any("LLM draft failed" in p for p in result.problems))


if __name__ == "__main__":
    unittest.main()
