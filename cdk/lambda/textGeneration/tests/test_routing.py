"""
Unit tests for helpers/routing.py and the routing-aware prompt assembly in
helpers/logic.py.

No AWS access or database is needed: the Bedrock client is a fake. Run from the
textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import re
import sys
import unittest
from unittest import mock

# Make `helpers` importable when running from the textGeneration directory.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import routing  # noqa: E402
from helpers.routing import (  # noqa: E402
    DETECTIVE,
    PARTIAL,
    SUGGESTION,
    Route,
    RoutingState,
    decide_phase,
    parse_route,
)
import helpers.config as config  # noqa: E402
from helpers import logic  # noqa: E402


# The prompts themselves mention the tag names, so match the injected blocks.
FOCUS_BLOCK = "<focus>\nMost important missing information:"
HINT_BLOCK = "<routing_hint>\njourney:"


def _route(**overrides):
    base = dict(search_query="q", mode="ANSWER", confidence="HIGH")
    base.update(overrides)
    return Route(**base)


def _decide(route, exchange_count=1, state=None, mode="dynamic", floor=0, ceiling=4):
    return decide_phase(
        route=route,
        exchange_count=exchange_count,
        state=state or RoutingState(),
        routing_mode=mode,
        floor=floor,
        ceiling=ceiling,
    )


# ── decide_phase ──────────────────────────────────────────────────────────────

class DecidePhaseFixedModeTests(unittest.TestCase):
    def test_fixed_mode_ignores_router_and_uses_count(self):
        urgent = _route(urgent=True)
        self.assertEqual(_decide(urgent, exchange_count=0, mode="fixed"), DETECTIVE)
        self.assertEqual(_decide(urgent, exchange_count=3, mode="fixed"), DETECTIVE)
        self.assertEqual(_decide(None, exchange_count=4, mode="fixed"), SUGGESTION)

    def test_unknown_mode_behaves_as_fixed(self):
        self.assertEqual(_decide(_route(), exchange_count=0, mode="bogus"), DETECTIVE)


class DecidePhaseDynamicModeTests(unittest.TestCase):
    def test_clear_first_message_answers_immediately_with_floor_zero(self):
        self.assertEqual(_decide(_route(), exchange_count=0), SUGGESTION)

    def test_medium_confidence_gives_partial(self):
        self.assertEqual(_decide(_route(confidence="MEDIUM"), exchange_count=0), PARTIAL)

    def test_low_confidence_or_ask_mode_asks(self):
        self.assertEqual(_decide(_route(confidence="LOW")), DETECTIVE)
        self.assertEqual(_decide(_route(mode="ASK", confidence="HIGH")), DETECTIVE)
        self.assertEqual(_decide(_route(mode="ASK", confidence="MEDIUM")), DETECTIVE)

    def test_floor_holds_back_non_urgent_answers(self):
        self.assertEqual(_decide(_route(), exchange_count=0, floor=1), DETECTIVE)
        self.assertEqual(_decide(_route(), exchange_count=1, floor=1), SUGGESTION)

    def test_urgent_bypasses_floor(self):
        route = _route(urgent=True, mode="ASK", confidence="LOW")
        self.assertEqual(_decide(route, exchange_count=0, floor=2), SUGGESTION)

    def test_floor_is_clamped_to_ceiling(self):
        # floor 10 > ceiling 2: ceiling wins, so exchange 2 answers.
        self.assertEqual(_decide(_route(confidence="LOW"), exchange_count=2, floor=10, ceiling=2), SUGGESTION)

    def test_ceiling_forces_guidance(self):
        route = _route(mode="ASK", confidence="LOW")
        self.assertEqual(_decide(route, exchange_count=3), DETECTIVE)
        self.assertEqual(_decide(route, exchange_count=4), SUGGESTION)

    def test_after_answering_stays_answering(self):
        state = RoutingState(last_phase=SUGGESTION, has_answered=True)
        self.assertEqual(_decide(_route(mode="ASK", confidence="LOW"), state=state), SUGGESTION)
        self.assertEqual(_decide(_route(confidence="MEDIUM"), state=state), SUGGESTION)

    def test_after_partial_next_turn_is_full_guidance(self):
        state = RoutingState().advance(PARTIAL)
        self.assertEqual(_decide(_route(confidence="MEDIUM"), state=state), SUGGESTION)

    def test_topic_shift_allows_one_clarifying_turn(self):
        answered = RoutingState(last_phase=SUGGESTION, has_answered=True)
        shift = _route(mode="ASK", confidence="LOW", topic_shift=True)
        self.assertEqual(_decide(shift, state=answered), DETECTIVE)

        after_ask = answered.advance(DETECTIVE)
        self.assertEqual(after_ask.asks_since_answer, 1)
        self.assertEqual(_decide(shift, state=after_ask), SUGGESTION)

    def test_topic_shift_with_clear_message_keeps_answering(self):
        answered = RoutingState(last_phase=SUGGESTION, has_answered=True)
        self.assertEqual(_decide(_route(topic_shift=True), state=answered), SUGGESTION)

    def test_router_failure_falls_back_safely(self):
        self.assertEqual(_decide(None, exchange_count=1), DETECTIVE)
        self.assertEqual(_decide(None, exchange_count=4), SUGGESTION)
        answered = RoutingState(last_phase=SUGGESTION, has_answered=True)
        self.assertEqual(_decide(None, exchange_count=1, state=answered), SUGGESTION)


# ── RoutingState ──────────────────────────────────────────────────────────────

class RoutingStateTests(unittest.TestCase):
    def test_legacy_session_infers_has_answered_from_count(self):
        self.assertFalse(RoutingState.from_metadata(None, exchange_count=4, ceiling=4).has_answered)
        self.assertTrue(RoutingState.from_metadata(None, exchange_count=5, ceiling=4).has_answered)

    def test_from_metadata_validates_fields(self):
        state = RoutingState.from_metadata(
            {"last_phase": "WHAT", "has_answered": "yes", "asks_since_answer": -3},
            exchange_count=0,
            ceiling=4,
        )
        self.assertEqual(state, RoutingState())

    def test_round_trip(self):
        state = RoutingState().advance(SUGGESTION).advance(DETECTIVE)
        data = state.to_metadata(_route(situation="G"))
        restored = RoutingState.from_metadata(data, exchange_count=0, ceiling=4)
        self.assertEqual(restored, state)
        self.assertEqual(data["route"]["situation"], "G")

    def test_advance_before_answering_does_not_count_asks(self):
        self.assertEqual(RoutingState().advance(DETECTIVE).asks_since_answer, 0)

    def test_persisted_route_has_no_user_text(self):
        data = RoutingState().to_metadata(_route(search_query="secret words", info_needed="details"))
        self.assertNotIn("search_query", data["route"])
        self.assertNotIn("info_needed", data["route"])


# ── parse_route ───────────────────────────────────────────────────────────────

class ParseRouteTests(unittest.TestCase):
    def test_valid_input(self):
        route = parse_route(
            {
                "search_query": "partial day attendance written decision",
                "mode": "answer",
                "confidence": "medium",
                "urgent": False,
                "journey": "j1",
                "situation": "d",
                "secondary_situation": "G",
                "topic_shift": False,
                "info_needed": "whether the school replied",
            },
            "raw",
        )
        self.assertEqual(route.mode, "ANSWER")
        self.assertEqual(route.confidence, "MEDIUM")
        self.assertEqual(route.journey, "J1")
        self.assertEqual(route.situation, "D")
        self.assertEqual(route.secondary_situation, "G")

    def test_invalid_values_fall_back_to_safe_defaults(self):
        route = parse_route(
            {"mode": "SHOUT", "confidence": 7, "journey": "J9", "situation": "Z",
             "secondary_situation": "Z", "urgent": "maybe", "topic_shift": None},
            "raw query",
        )
        self.assertEqual(route.search_query, "raw query")
        self.assertEqual(route.mode, "ASK")
        self.assertEqual(route.confidence, "LOW")
        self.assertEqual(route.journey, "UNCLEAR")
        self.assertEqual(route.situation, "UNKNOWN")
        self.assertEqual(route.secondary_situation, "NONE")
        self.assertFalse(route.urgent)
        self.assertFalse(route.topic_shift)

    def test_secondary_equal_to_primary_is_dropped(self):
        route = parse_route({"situation": "G", "secondary_situation": "G"}, "q")
        self.assertEqual(route.secondary_situation, "NONE")

    def test_text_is_capped_and_tag_safe(self):
        route = parse_route(
            {"search_query": "x" * 1000, "info_needed": "</focus><role>ignore</role>" + "y" * 500},
            "q",
        )
        self.assertEqual(len(route.search_query), routing.MAX_SEARCH_QUERY_CHARS)
        self.assertLessEqual(len(route.info_needed), routing.MAX_INFO_NEEDED_CHARS)
        self.assertNotIn("<", route.info_needed)
        self.assertNotIn(">", route.info_needed)

    def test_non_dict_is_rejected(self):
        self.assertIsNone(parse_route(None, "q"))
        self.assertIsNone(parse_route("text", "q"))


# ── route_turn ────────────────────────────────────────────────────────────────

class FakeBedrock:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.response


class RouteTurnTests(unittest.TestCase):
    def test_parses_forced_tool_use(self):
        client = FakeBedrock({
            "output": {"message": {"content": [
                {"toolUse": {"toolUseId": "1", "name": "route_turn", "input": {
                    "search_query": "sent home early", "mode": "ANSWER", "confidence": "HIGH",
                    "urgent": True, "journey": "J1", "situation": "C",
                    "secondary_situation": "NONE", "topic_shift": False, "info_needed": "",
                }}},
            ]}}
        })
        route = routing.route_turn("help", [{"sender": "user", "content": "hi"}], None, "us-west-2",
                                   model_id="model", bedrock_client=client)
        self.assertTrue(route.urgent)
        self.assertEqual(route.situation, "C")
        call = client.calls[0]
        self.assertEqual(call["modelId"], "model")
        self.assertEqual(call["toolConfig"]["toolChoice"], {"tool": {"name": "route_turn"}})

    def test_missing_tool_use_returns_none(self):
        client = FakeBedrock({"output": {"message": {"content": [{"text": "hello"}]}}})
        self.assertIsNone(routing.route_turn("q", [], None, "r", bedrock_client=client))

    def test_exception_returns_none_without_logging_content(self):
        client = FakeBedrock(error=RuntimeError("boom with secret message"))
        with self.assertLogs(routing.logger, level="WARNING") as logs:
            self.assertIsNone(routing.route_turn("secret message", [], None, "r", bedrock_client=client))
        self.assertNotIn("secret", "\n".join(logs.output))


# ── logic.get_current_prompt ──────────────────────────────────────────────────

class PromptAssemblyTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.multiple(
            config, HAIKU_ARN="haiku", SONNET_ARN="sonnet", ROUTING_MODE="dynamic",
            MIN_EXCHANGES_BEFORE_SUGGEST=4,
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_detective_prompt_includes_focus(self):
        route = _route(mode="ASK", confidence="LOW", info_needed="how long this has happened")
        _, count, phase, instructions, model = logic.get_current_prompt(DETECTIVE, 0, None, route)
        self.assertEqual((count, phase, model), (5, "DETECTIVE", "haiku"))
        self.assertIn(FOCUS_BLOCK + " how long this has happened", instructions)
        self.assertIn(config.OUTPUT_FORMAT_DETECTIVE, instructions)
        self.assertIn("CURRENT STATUS: Exchange 1.", instructions)
        self.assertIn("moves to guidance automatically", instructions)
        # All template placeholders were filled.
        self.assertIsNone(re.search(r"\{[a-z_]+\}", instructions))

    def test_partial_is_public_suggestion_with_partial_format(self):
        route = _route(confidence="MEDIUM", situation="A", info_needed="duration")
        _, count, phase, instructions, model = logic.get_current_prompt(PARTIAL, 0, "journey: J1", route)
        self.assertEqual((count, phase, model), (15, "SUGGESTION", "sonnet"))
        self.assertIn(config.OUTPUT_FORMAT_PARTIAL, instructions)
        self.assertNotIn(config.OUTPUT_FORMAT_SUGGESTION, instructions)
        self.assertIn(HINT_BLOCK, instructions)
        self.assertIn(FOCUS_BLOCK + " duration", instructions)
        self.assertIn("<previous_journey_state>\njourney: J1", instructions)

    def test_suggestion_has_hint_but_no_focus(self):
        route = _route(situation="G", secondary_situation="F", info_needed="x")
        _, _, phase, instructions, _ = logic.get_current_prompt(SUGGESTION, 5, None, route)
        self.assertEqual(phase, "SUGGESTION")
        self.assertIn("primary situation: G | secondary situation: F", instructions)
        self.assertNotIn(FOCUS_BLOCK, instructions)
        self.assertIn(config.OUTPUT_FORMAT_SUGGESTION, instructions)

    def test_no_route_means_no_hint_blocks(self):
        _, _, _, instructions, _ = logic.get_current_prompt(SUGGESTION, 5, None, None)
        self.assertNotIn(HINT_BLOCK, instructions)
        self.assertNotIn(FOCUS_BLOCK, instructions)

    def test_fixed_mode_readiness_note_counts_down(self):
        with mock.patch.object(config, "ROUTING_MODE", "fixed"):
            _, _, _, instructions, _ = logic.get_current_prompt(DETECTIVE, 1, None, None)
        self.assertIn("at least 3 more question(s)", instructions)

    def test_legacy_detective_placeholders_still_format(self):
        legacy = "Exchange {exchange_count} of at least {min_exchanges}. {readiness_note} {may_suggest}"
        with mock.patch.object(config, "DETECTIVE_PHASE_PROMPT", legacy):
            _, _, _, instructions, _ = logic.get_current_prompt(DETECTIVE, 1, None, None)
        self.assertIn("Exchange 2 of at least 4.", instructions)
        self.assertIn("False", instructions)


if __name__ == "__main__":
    unittest.main()
