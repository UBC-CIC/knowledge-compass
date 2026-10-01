"""
Unit tests for helpers/journeys.py, the catalog-driven router in
helpers/routing.py, and the journey-aware prompt assembly in helpers/logic.py.

No AWS access or database is needed. Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import helpers.config as config  # noqa: E402
from helpers import journeys, logic, routing  # noqa: E402
from helpers.journeys import (  # noqa: E402
    DEFAULT_CATALOG,
    Cluster,
    Journey,
    JourneyCatalog,
    build_detective_block,
    build_suggestion_block,
    catalog_from_rows,
    select_for_route,
)
from helpers.routing import (  # noqa: E402
    DETECTIVE,
    PARTIAL,
    SUGGESTION,
    Route,
    RoutingState,
    parse_route,
    touched_keys,
)


def _route(**overrides):
    base = dict(search_query="q", mode="ANSWER", confidence="HIGH")
    base.update(overrides)
    return Route(**base)


def _selected(selection):
    return [(j.key, [c.key for c in clusters]) for j, clusters in selection]


def _custom_catalog():
    """DEFAULT_CATALOG plus a new journey J3 with situation P."""
    j3 = Journey(
        key="J3",
        name="Post-secondary planning",
        description="Planning for life after high school.",
        detection_signals='"college," "university," "after graduation"',
        detective_questions="1. What options are they considering?",
        guidance="Focus on keeping options open after school.",
        clusters=(Cluster("P", "Applying to college", "Parent asks about applications.", 2,
                          "Response pattern:\n1. Explain supports at college.", 1),),
        sort_order=3,
    )
    return JourneyCatalog(DEFAULT_CATALOG.journeys + (j3,))


class DefaultCatalogTests(unittest.TestCase):
    def test_default_catalog_has_the_seeded_journeys(self):
        self.assertEqual([j.key for j in DEFAULT_CATALOG.journeys], ["J1", "J2"])
        self.assertEqual(sorted(DEFAULT_CATALOG.cluster_keys), list("ABCDEFGHIJKLMNO"))
        self.assertEqual(DEFAULT_CATALOG.owner_of("K").key, "J2")

    def test_keys_are_valid_and_not_reserved(self):
        self.assertTrue(journeys.is_valid_key("J1"))
        for bad in ("BOTH", "UNCLEAR", "UNKNOWN", "NONE", "j1", "", "A-B", "X" * 17, None):
            self.assertFalse(journeys.is_valid_key(bad), bad)


class CatalogFromRowsTests(unittest.TestCase):
    def test_groups_rows_and_skips_bad_keys(self):
        rows = [
            ("J1", "One", "d", "s", 1, "q", "g", "A", "Alpha", "m", 2, 1, "p"),
            ("J1", "One", "d", "s", 1, "q", "g", "B", "Beta", None, None, 2, None),
            ("J2", "Two", None, None, 2, None, None, None, None, None, None, None, None),
            ("bad key", "x", "", "", 3, "", "", None, None, None, None, None, None),
        ]
        catalog = catalog_from_rows(rows)
        self.assertEqual([j.key for j in catalog.journeys], ["J1", "J2"])
        self.assertEqual([c.key for c in catalog.journey("J1").clusters], ["A", "B"])
        self.assertEqual(catalog.journey("J1").clusters[1].priority, 5)
        self.assertEqual(catalog.journey("J2").clusters, ())
        self.assertEqual(catalog.journey("J2").guidance, "")

    def test_empty_rows_give_empty_catalog(self):
        self.assertTrue(catalog_from_rows([]).is_empty)


class SelectionTests(unittest.TestCase):
    def test_known_clusters_only(self):
        selection = select_for_route(DEFAULT_CATALOG, _route(journey="J1", situation="G", secondary_situation="F"))
        self.assertEqual(_selected(selection), [("J1", ["F", "G"])])

    def test_secondary_in_other_journey_adds_that_journey(self):
        selection = select_for_route(DEFAULT_CATALOG, _route(journey="J1", situation="C", secondary_situation="K"))
        self.assertEqual(_selected(selection), [("J1", ["C"]), ("J2", ["K"])])

    def test_routed_journey_guidance_kept_when_cluster_is_elsewhere(self):
        selection = select_for_route(DEFAULT_CATALOG, _route(journey="J2", situation="D"))
        self.assertEqual(_selected(selection), [("J1", ["D"]), ("J2", [])])

    def test_known_journey_unknown_situation_gives_all_its_clusters(self):
        selection = select_for_route(DEFAULT_CATALOG, _route(journey="J2"))
        self.assertEqual(_selected(selection), [("J2", list("KLMNO"))])

    def test_unclear_both_or_no_route_gives_everything(self):
        everything = [("J1", list("ABCDEFGHIJ")), ("J2", list("KLMNO"))]
        for route in (None, _route(journey="UNCLEAR"), _route(journey="BOTH")):
            self.assertEqual(_selected(select_for_route(DEFAULT_CATALOG, route)), everything)

    def test_archived_or_unknown_keys_are_ignored(self):
        # Archived items never reach the catalog, so they look like unknown keys.
        catalog = JourneyCatalog((DEFAULT_CATALOG.journey("J2"),))
        selection = select_for_route(catalog, _route(journey="J1", situation="C"))
        self.assertEqual(_selected(selection), [("J2", list("KLMNO"))])


class SuggestionBlockTests(unittest.TestCase):
    def test_routed_block_is_much_smaller_and_has_only_routed_clusters(self):
        routed = build_suggestion_block(DEFAULT_CATALOG, _route(journey="J1", situation="G", secondary_situation="F"))
        everything = build_suggestion_block(DEFAULT_CATALOG, None)
        self.assertIn("SITUATION G — NON-RESPONSE, DENIAL, AND SCHOOL PUSHBACK (priority 2)", routed)
        self.assertIn("SITUATION F — SUPPORT PLAN IMPLEMENTATION (priority 3)", routed)
        self.assertIn(DEFAULT_CATALOG.journey("J1").guidance, routed)
        self.assertNotIn("SITUATION C", routed)
        self.assertNotIn("JOURNEY J2", routed)
        self.assertLess(len(routed), len(everything) / 4)
        self.assertTrue(routed.startswith("<journeys>\n") and routed.endswith("\n</journeys>"))

    def test_priority_order_lists_included_clusters(self):
        block = build_suggestion_block(DEFAULT_CATALOG, _route(journey="J1", situation="A", secondary_situation="C"))
        order = block.split("\n\n", 1)[0]
        self.assertIn("1. C (Responding in the moment)", order)
        self.assertIn("4. A (Recognizing and understanding the situation)", order)
        self.assertLess(order.index("1. C"), order.index("4. A"))

    def test_single_cluster_has_no_priority_list(self):
        block = build_suggestion_block(DEFAULT_CATALOG, _route(journey="J1", situation="C"))
        self.assertNotIn("Priority order", block)

    def test_empty_catalog_gives_no_block(self):
        self.assertEqual(build_suggestion_block(JourneyCatalog(), _route()), "")


class DetectiveBlockTests(unittest.TestCase):
    def test_all_signals_but_only_focused_questions(self):
        block = build_detective_block(DEFAULT_CATALOG, _route(journey="J2", confidence="LOW"))
        j1, j2 = DEFAULT_CATALOG.journeys
        self.assertIn("JOURNEY J1 — Involuntary partial day attendance", block)
        self.assertIn(j1.detection_signals.splitlines()[0], block)
        self.assertIn(j2.detection_signals.splitlines()[0], block)
        self.assertIn(j2.detective_questions.splitlines()[0], block)
        self.assertNotIn(j1.detective_questions.splitlines()[0], block)
        self.assertIn("Situations: K Course selection", block)

    def test_cluster_owner_sets_focus_when_journey_unclear(self):
        block = build_detective_block(DEFAULT_CATALOG, _route(journey="UNCLEAR", situation="C"))
        j1, j2 = DEFAULT_CATALOG.journeys
        self.assertIn(j1.detective_questions.splitlines()[0], block)
        self.assertNotIn(j2.detective_questions.splitlines()[0], block)

    def test_unclear_includes_every_journeys_questions(self):
        block = build_detective_block(DEFAULT_CATALOG, None)
        for j in DEFAULT_CATALOG.journeys:
            self.assertIn(j.detective_questions.splitlines()[0], block)


class PromptAssemblyTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.multiple(
            config, HAIKU_ARN="haiku", SONNET_ARN="sonnet", ROUTING_MODE="dynamic",
            MIN_EXCHANGES_BEFORE_SUGGEST=4, JOURNEY_CATALOG=DEFAULT_CATALOG,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_suggestion_sends_base_and_routed_clusters_only(self):
        route = _route(journey="J1", situation="G", secondary_situation="F")
        _, _, _, instructions, _ = logic.get_current_prompt(SUGGESTION, 5, None, route)
        self.assertIn(config.SUGGESTION_PHASE_PROMPT, instructions)
        self.assertIn("SITUATION G —", instructions)
        self.assertNotIn("SITUATION K —", instructions)
        # Block order inside <phase>: base, journeys, routing hint.
        self.assertLess(instructions.index("</journeys>"), instructions.index("<routing_hint>\njourney:"))

    def test_partial_uses_routed_clusters(self):
        route = _route(confidence="MEDIUM", journey="J2", situation="L", info_needed="grade")
        _, _, phase, instructions, _ = logic.get_current_prompt(PARTIAL, 0, None, route)
        self.assertEqual(phase, "SUGGESTION")
        self.assertIn("SITUATION L —", instructions)
        self.assertNotIn("SITUATION A —", instructions)

    def test_detective_braces_in_journey_text_are_safe(self):
        catalog = JourneyCatalog((Journey("J1", "One {x}", "", "{signals}", "1. {q}?", ""),))
        with mock.patch.object(config, "JOURNEY_CATALOG", catalog):
            _, _, _, instructions, _ = logic.get_current_prompt(DETECTIVE, 0, None, None)
        self.assertIn("1. {q}?", instructions)

    def test_new_journey_is_used_end_to_end(self):
        catalog = _custom_catalog()
        with mock.patch.object(config, "JOURNEY_CATALOG", catalog):
            _, _, _, instructions, _ = logic.get_current_prompt(SUGGESTION, 5, None, _route(journey="J3", situation="P"))
        self.assertIn("JOURNEY J3 — POST-SECONDARY PLANNING", instructions)
        self.assertIn("SITUATION P — APPLYING TO COLLEGE (priority 2)", instructions)
        self.assertNotIn("JOURNEY J1", instructions)


class CatalogRouterTests(unittest.TestCase):
    def test_tool_spec_enums_follow_the_catalog(self):
        spec = routing.build_router_tool_spec(_custom_catalog())["toolSpec"]["inputSchema"]["json"]["properties"]
        self.assertEqual(spec["journey"]["enum"], ["BOTH", "J1", "J2", "J3", "UNCLEAR"])
        self.assertIn("P", spec["situation"]["enum"])
        self.assertIn("UNKNOWN", spec["situation"]["enum"])
        self.assertIn("NONE", spec["secondary_situation"]["enum"])

    def test_router_prompt_lists_journeys_and_situations(self):
        prompt = routing.build_router_prompt(_custom_catalog())
        self.assertIn("J3  Post-secondary planning: Planning for life after high school.", prompt)
        self.assertIn('signals: "college," "university," "after graduation"', prompt)
        self.assertIn("P  [J3] Applying to college: Parent asks about applications.", prompt)
        self.assertIn("C  [J1] Responding in the moment:", prompt)

    def test_parse_route_validates_against_catalog(self):
        catalog = _custom_catalog()
        route = parse_route({"journey": "j3", "situation": "p"}, "q", catalog)
        self.assertEqual((route.journey, route.situation), ("J3", "P"))
        # Not in the default catalog -> safe defaults.
        route = parse_route({"journey": "J3", "situation": "P"}, "q")
        self.assertEqual((route.journey, route.situation), ("UNCLEAR", "UNKNOWN"))

    def test_archived_keys_fall_back(self):
        catalog = JourneyCatalog((DEFAULT_CATALOG.journey("J2"),))
        route = parse_route({"journey": "J1", "situation": "C", "secondary_situation": "K"}, "q", catalog)
        self.assertEqual((route.journey, route.situation, route.secondary_situation), ("UNCLEAR", "UNKNOWN", "K"))

    def test_route_turn_sends_catalog_prompt_and_tool(self):
        class Fake:
            def __init__(self):
                self.calls = []

            def converse(self, **kwargs):
                self.calls.append(kwargs)
                return {"output": {"message": {"content": [{"toolUse": {
                    "name": "route_turn", "input": {"journey": "J3", "situation": "P"}}}]}}}

        client = Fake()
        route = routing.route_turn("q", [], None, "r", bedrock_client=client, catalog=_custom_catalog())
        self.assertEqual((route.journey, route.situation), ("J3", "P"))
        call = client.calls[0]
        self.assertIn("J3  Post-secondary planning", call["system"][0]["text"])
        tool = call["toolConfig"]["tools"][0]["toolSpec"]
        self.assertIn("J3", tool["inputSchema"]["json"]["properties"]["journey"]["enum"])


class SeenKeysTests(unittest.TestCase):
    def test_touched_keys_include_owner_journey(self):
        route = _route(journey="BOTH", situation="C", secondary_situation="K")
        self.assertEqual(touched_keys(route, SUGGESTION, DEFAULT_CATALOG), (["J1", "J2"], ["C", "K"]))

    def test_low_confidence_detective_turns_are_not_recorded(self):
        route = _route(mode="ASK", confidence="LOW", journey="J1", situation="A")
        self.assertEqual(touched_keys(route, DETECTIVE, DEFAULT_CATALOG), ([], []))
        self.assertEqual(touched_keys(route, SUGGESTION, DEFAULT_CATALOG), (["J1"], ["A"]))
        self.assertEqual(touched_keys(None, SUGGESTION, DEFAULT_CATALOG), ([], []))

    def test_seen_lists_accumulate_dedupe_and_round_trip(self):
        state = RoutingState().advance(DETECTIVE, ["J1"], ["A"]).advance(SUGGESTION, ["J1", "J2"], ["A", "K"])
        self.assertEqual(state.journeys_seen, ("J1", "J2"))
        self.assertEqual(state.clusters_seen, ("A", "K"))
        data = state.to_metadata(_route())
        self.assertEqual(data["clusters_seen"], ["A", "K"])
        self.assertEqual(RoutingState.from_metadata(data, 0, 4), state)

    def test_seen_lists_are_capped(self):
        keys = [f"K{i}" for i in range(30)]
        state = RoutingState().advance(SUGGESTION, keys, keys)
        self.assertEqual(len(state.journeys_seen), routing.MAX_SEEN_KEYS)

    def test_malformed_stored_lists_are_rejected(self):
        data = {"journeys_seen": "J1", "clusters_seen": ["A", "a", 3, None, "A", "</x>", "NONE"]}
        state = RoutingState.from_metadata(data, 0, 4)
        self.assertEqual(state.journeys_seen, ())
        self.assertEqual(state.clusters_seen, ("A",))


if __name__ == "__main__":
    unittest.main()
