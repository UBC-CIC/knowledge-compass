"""Which journey documents a turn may search."""

import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers.journey_guides import document_ids_for_turn, outlines_for, situation_name  # noqa: E402


COVERAGE = {
    "J1": {
        "document_ids": ["d1", "d2"],
        "names": {"sent home early"},
        "sections": [{"label": "Sent home early", "name": "sent home early"}],
    },
    "J2": {
        "document_ids": ["d3"],
        "names": {"meeting"},
        "sections": [{"label": "Meeting", "name": "meeting"}],
    },
}


class JourneyGuideSelectionTest(unittest.TestCase):
    def test_situation_name_is_the_last_heading(self):
        self.assertEqual(situation_name("Journey > Sent  home early", "ignored"), "sent home early")
        self.assertEqual(situation_name("", "Window key"), "window key")

    def test_known_journey_searches_only_its_documents(self):
        self.assertEqual(document_ids_for_turn(SimpleNamespace(journey="J1"), COVERAGE), ["d1", "d2"])
        self.assertEqual(document_ids_for_turn(SimpleNamespace(journey="J9"), COVERAGE), [])

    def test_unclear_journey_searches_every_journey_document(self):
        self.assertEqual(document_ids_for_turn(SimpleNamespace(journey="UNCLEAR"), COVERAGE), ["d1", "d2", "d3"])
        self.assertEqual(document_ids_for_turn(None, COVERAGE), ["d1", "d2", "d3"])
        self.assertEqual(document_ids_for_turn(SimpleNamespace(journey="BOTH"), COVERAGE), ["d1", "d2", "d3"])

    def test_empty_coverage_searches_nothing(self):
        self.assertEqual(document_ids_for_turn(SimpleNamespace(journey="UNCLEAR"), {}), [])

    def test_outline_lists_section_labels(self):
        outlines = outlines_for(COVERAGE)
        self.assertIn("Sent home early", outlines["J1"])
        self.assertNotIn("Meeting", outlines["J1"])


if __name__ == "__main__":
    unittest.main()
