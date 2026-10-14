import copy
import tempfile
import unittest
from pathlib import Path

from evals import schema
from evals.schema import ScenarioError

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "scenarios"


def _example():
    return schema.read_yaml(FIXTURES / "j9_f1" / "X01.yaml")


class ScenarioParsingTest(unittest.TestCase):
    def test_example_is_valid(self):
        s = schema.scenario_from_dict(_example())
        self.assertEqual(s.story_id, "X01")
        self.assertEqual(s.modes, ["standard", "guideline"])
        self.assertEqual(s.variants[0].description, "attending only mornings")
        self.assertTrue(s.variants[0].message)
        self.assertEqual(s.reference_flow[0].step, "Acknowledge the situation.")

    def test_round_trip_keeps_fields_and_order(self):
        s = schema.scenario_from_dict(_example())
        data = s.to_dict()
        self.assertEqual(list(data)[:3], ["story_id", "reviewed", "testable"])
        self.assertEqual(schema.scenario_from_dict(data).to_dict(), data)

    def test_every_problem_is_reported(self):
        bad = _example()
        bad.update(story_id="bad id!", journey_number=0, opening_message="", acceptance_criteria=[],
                   modes=["admin"], reviewed="yes")
        with self.assertRaises(ScenarioError) as ctx:
            schema.scenario_from_dict(bad, "x.yaml")
        msg = str(ctx.exception)
        for fragment in ("story_id", "journey_number", "opening_message", "acceptance_criteria", "modes", "reviewed"):
            self.assertIn(fragment, msg)

    def test_overlong_messages_rejected(self):
        bad = _example()
        bad["opening_message"] = "x" * (schema.MAX_MESSAGE_CHARS + 1)
        bad["variants"][0]["message"] = "y" * (schema.MAX_MESSAGE_CHARS + 1)
        with self.assertRaises(ScenarioError) as ctx:
            schema.scenario_from_dict(bad)
        self.assertIn("opening_message exceeds", str(ctx.exception))
        self.assertIn("variants[0].message exceeds", str(ctx.exception))

    def test_list_field_type_errors_are_not_lost(self):
        bad = _example()
        bad["hidden_facts"] = "not a list"
        with self.assertRaises(ScenarioError) as ctx:
            schema.scenario_from_dict(bad)
        self.assertIn("hidden_facts", str(ctx.exception))


class LabelMapTest(unittest.TestCase):
    def test_lookup(self):
        lm = schema.load_label_map(FIXTURES)
        s = schema.scenario_from_dict(_example())
        self.assertEqual(lm.journey_key(s), "J1")
        self.assertEqual(lm.cluster_keys(s), ["A", "B"])
        self.assertTrue(lm.reviewed)

    def test_story_override(self):
        lm = schema.label_map_from_dict({"journeys": {9: {"journey_key": "J1"}},
                                         "stories": {"X01": {"clusters": ["N"], "journey_key": "J2"}}})
        self.assertEqual(lm.journey_key(schema.scenario_from_dict(_example())), "J2")

    def test_invalid_keys_rejected(self):
        for data in (
            {"journeys": {"one": {}}},
            {"journeys": {1: {"journey_key": "j1"}}},
            {"stories": {"111": {"clusters": ["a b"]}}},
            {"stories": {"111": {"clusters": "A"}}},
            {"reviewed": "true"},
        ):
            with self.assertRaises(ScenarioError, msg=str(data)):
                schema.label_map_from_dict(data)


class DirectoryTest(unittest.TestCase):
    def test_fixture_directory_valid_for_scoring(self):
        self.assertEqual(schema.validate_directory(FIXTURES, for_scoring=True), [])

    def test_missing_labels_and_review_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = _example()
            data["reviewed"] = False
            schema.write_yaml(Path(tmp) / "a" / "X01.yaml", data)
            problems = schema.validate_directory(Path(tmp), for_scoring=True)
            text = "\n".join(problems)
            self.assertIn("not reviewed", text)
            self.assertIn("no journey_key", text)
            self.assertIn("no expected clusters", text)

    def test_duplicates_and_bad_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            schema.write_yaml(Path(tmp) / "a" / "X01.yaml", _example())
            schema.write_yaml(Path(tmp) / "b" / "X01.yaml", _example())
            (Path(tmp) / "c.yaml").write_text("story_id: [", encoding="utf-8")
            problems = schema.validate_directory(Path(tmp))
            self.assertTrue(any("duplicate story_id X01" in p for p in problems))
            self.assertEqual(len(problems), 2)
            with self.assertRaises(ScenarioError):
                schema.load_scenarios(Path(tmp))


class SelectionTest(unittest.TestCase):
    def _many(self):
        out = []
        for sid, journey, reviewed, testable in (("111", 1, True, True), ("112", 1, True, False),
                                                 ("211", 2, True, True), ("212", 2, False, True)):
            d = copy.deepcopy(_example())
            d.update(story_id=sid, journey_number=journey, reviewed=reviewed, testable=testable)
            out.append(schema.scenario_from_dict(d))
        return out

    def test_reviewed_gate(self):
        with self.assertRaises(ScenarioError) as ctx:
            schema.select_scenarios(self._many())
        self.assertIn("212", str(ctx.exception))

    def test_testable_false_is_skipped_and_filters_apply(self):
        picked = schema.select_scenarios(self._many(), journey=1)
        self.assertEqual([s.story_id for s in picked], ["111"])
        picked = schema.select_scenarios(self._many(), stories=["211", "112"])
        self.assertEqual([s.story_id for s in picked], ["211"])
        self.assertEqual(len(schema.select_scenarios(self._many(), stories=["111", "211"], limit=1)), 1)

    def test_drafts_allowed_when_not_scoring(self):
        picked = schema.select_scenarios(self._many(), for_scoring=False)
        self.assertEqual(len(picked), 4)


if __name__ == "__main__":
    unittest.main()
