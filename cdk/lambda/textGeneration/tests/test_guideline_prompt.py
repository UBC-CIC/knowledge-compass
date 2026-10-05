"""
Unit tests for helpers/guideline_prompt.py. Run from textGeneration:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import config, guideline_prompt as gp  # noqa: E402


def section(title, key, content, doc="d1", heading=None):
    return {
        "title": title,
        "content": content,
        "source_type": "guideline",
        "metadata": {"document_id": doc, "section_key": key, "heading_path": heading if heading is not None else key},
    }


STRUCTURED = [
    section("Child sent home early", "J1 > Sent home", "Ask first:\nHow long?\nHow to respond:\nKeep a record."),
    section("Reduced school day", "J1 > Reduced day", "Ask how long it will last."),
]
PLAIN = [section("Planning for next year", "window-2", "Plain paragraph text with no headings.", heading="")]


class GuidelinePromptTest(unittest.TestCase):
    def setUp(self):
        self._outline = config.GUIDELINE_OUTLINE
        config.GUIDELINE_OUTLINE = [
            {"document_id": "d1", "file_name": "guide.md", "section_key": "J1 > Sent home", "label": "Child sent home early"},
            {"document_id": "d2", "file_name": "other.md", "section_key": "window-1", "label": "Planning for next year"},
        ]

    def tearDown(self):
        config.GUIDELINE_OUTLINE = self._outline

    def test_static_block_is_stable_across_turns(self):
        a, _, _ = gp.build_guideline_prompt(STRUCTURED, None)
        b, _, _ = gp.build_guideline_prompt(PLAIN, {"label": "Child sent home early"})
        self.assertEqual(a, b)
        self.assertIn("<instructions>", a)
        self.assertIn("Guide: guide.md\n- Child sent home early", a)
        self.assertIn(config.GUARDRAILS, a)
        self.assertIn(config.LANGUAGE_GUIDELINES, a)
        for step in ("(a) Check the guide first", "(b) Identify the situation",
                     "(c) Take the matching section", "(d) Respond using only that section"):
            self.assertIn(step, a)

    def test_sections_are_numbered_for_citations(self):
        _, dynamic, model = gp.build_guideline_prompt(STRUCTURED, None)
        self.assertIn("[1] Situation: Child sent home early", dynamic)
        self.assertIn("[2] Situation: Reduced school day", dynamic)
        self.assertLess(dynamic.index("[1]"), dynamic.index("[2]"))
        self.assertIn("<cited_indices>", dynamic)
        self.assertIn("<guide_state>section: n</guide_state>", dynamic)
        self.assertEqual(model, config.SONNET_ARN)
        print("\n--- structured prompt (dynamic) ---\n" + dynamic)

    def test_empty_sections_ask_clarifying_question(self):
        _, dynamic, _ = gp.build_guideline_prompt([], None)
        self.assertIn(gp.NO_SECTIONS_NOTE, dynamic)
        self.assertNotIn("[1] Situation:", dynamic)

    def test_headingless_section_renders(self):
        _, dynamic, _ = gp.build_guideline_prompt(PLAIN, {"label": "Child sent home early"})
        self.assertIn("[1] Situation: Planning for next year\nPlain paragraph text", dynamic)
        self.assertNotIn("Heading:", dynamic)
        self.assertIn("<previous_situation>\nChild sent home early\n</previous_situation>", dynamic)
        print("\n--- plain prompt (dynamic) ---\n" + dynamic)

    def test_empty_outline(self):
        config.GUIDELINE_OUTLINE = []
        static, _, _ = gp.build_guideline_prompt([], None)
        self.assertIn("No guides have been uploaded yet.", static)


class ResourcesTest(unittest.TestCase):
    RESOURCES = [
        {"title": "Log video", "url": "https://example.org/v", "source_type": "video", "content": "Video text."},
        {"title": "Policy PDF", "url": "", "source_type": "document", "content": "PDF text."},
    ]

    def test_resources_numbered_after_sections(self):
        _, dynamic, _ = gp.build_guideline_prompt(STRUCTURED, None, self.RESOURCES)
        self.assertIn("<resources>", dynamic)
        self.assertIn("<source_3>\n[3] Log video", dynamic)
        self.assertIn("<source_4>\n[4] Policy PDF", dynamic)
        self.assertLess(dynamic.index("<guide_sections>"), dynamic.index("<resources>"))

    def test_no_resources_note(self):
        _, dynamic, _ = gp.build_guideline_prompt(STRUCTURED, None, [])
        self.assertIn("No supporting resources matched this message.", dynamic)

    def test_guide_state_ignores_resource_numbers(self):
        combined = STRUCTURED + self.RESOURCES
        self.assertIsNone(gp.parse_guide_state("<guide_state>section: 3</guide_state>", combined))
        self.assertEqual(
            gp.parse_guide_state("<guide_state>section: 2</guide_state>", combined)["section_key"],
            "J1 > Reduced day",
        )


class ParseGuideStateTest(unittest.TestCase):
    def test_maps_index_to_section(self):
        text = "<answer>x</answer><cited_indices>[2]</cited_indices><guide_state>section: 2</guide_state>"
        state = gp.parse_guide_state(text, STRUCTURED)
        self.assertEqual(state, {"document_id": "d1", "section_key": "J1 > Reduced day", "label": "Reduced school day"})

    def test_zero_missing_or_out_of_range(self):
        self.assertIsNone(gp.parse_guide_state("<guide_state>section: 0</guide_state>", STRUCTURED))
        self.assertIsNone(gp.parse_guide_state("<guide_state>section: 5</guide_state>", STRUCTURED))
        self.assertIsNone(gp.parse_guide_state("no tag", STRUCTURED))

    def test_tolerates_brackets_and_spacing(self):
        state = gp.parse_guide_state("<guide_state>\n Section : [1]\n</guide_state>", STRUCTURED)
        self.assertEqual(state["section_key"], "J1 > Sent home")


if __name__ == "__main__":
    unittest.main()
