"""
Unit tests for the guideline-mode branch of helpers/chat.py. Bedrock,
retrieval, routing and the DB are mocked. Run from textGeneration:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import chat, config  # noqa: E402

SECTIONS = [
    {
        "type": "GUIDELINE", "source_type": "guideline", "title": "Child sent home early",
        "url": "", "uri": "", "content": "Keep a dated record of each early pickup.", "score": 0.8,
        "metadata": {"document_id": "d1", "section_key": "J1 > Sent home", "heading_path": "J1 > Sent home"},
    },
]

RESOURCES = [
    {
        "type": "VIDEO", "source_type": "video", "title": "Keeping a school log",
        "url": "https://example.org/video", "uri": "https://example.org/video",
        "content": "A short video on keeping a log.", "score": 0.6, "metadata": {},
    },
    {
        "type": "DOCUMENT", "source_type": "document", "title": "Unrelated PDF",
        "url": "", "uri": "", "content": "Other content.", "score": 0.5, "metadata": {},
    },
]

GUIDELINE_REPLY = (
    "<answer>It sounds hard. **Keep a record.** Note each early pickup. "
    "[Keeping a school log](https://example.org/video)</answer>\n"
    "<cited_indices>[1, 2]</cited_indices>\n"
    "<guide_state>section: 1</guide_state>"
)
CLARIFY_REPLY = (
    "<answer>Thanks for reaching out. **What has been happening at school?**</answer>\n"
    "<cited_indices>[]</cited_indices>\n"
    "<guide_state>section: 0</guide_state>"
)


GUIDE_ONLY_LINKED_REPLY = (
    "<answer>It sounds hard. **Keep a record.** Note each early pickup. "
    "[Keeping a school log](https://example.org/video)</answer>\n"
    "<cited_indices>[1]</cited_indices>\n"
    "<guide_state>section: 1</guide_state>"
)
GUIDE_ONLY_REPLY = (
    "<answer>It sounds hard. **Keep a record.** Note each early pickup.</answer>\n"
    "<cited_indices>[1]</cited_indices>\n"
    "<guide_state>section: 1</guide_state>"
)
NO_CITATIONS_REPLY = (
    "<answer>It sounds hard. **Keep a record.** Note each early pickup.</answer>\n"
    "<guide_state>section: 1</guide_state>"
)
EMPTY_CITATIONS_WITH_SECTION_REPLY = (
    "<answer>Thanks for sharing. **How long has this been happening?**</answer>\n"
    "<cited_indices>[]</cited_indices>\n"
    "<guide_state>section: 1</guide_state>"
)


def _is_guide(source):
    return (
        source.get("source_type") == "guideline"
        or str(source.get("type", "")).lower() == "guideline"
        or str(source.get("title", "")).startswith("Family guide")
    )


class FakeConnection:
    def commit(self):
        pass

    def rollback(self):
        pass


def _stream(text, size=7):
    return {"stream": [
        {"contentBlockDelta": {"delta": {"text": text[i:i + size]}}}
        for i in range(0, len(text), size)
    ]}


class ChatModeTestBase(unittest.TestCase):
    reply = GUIDELINE_REPLY

    def setUp(self):
        self._mode = config.PROMPT_MODE
        self.bedrock = mock.Mock()
        self.bedrock.converse_stream.side_effect = lambda **kw: _stream(self.reply)
        self.routing_state = mock.Mock()
        self.patches = {
            "fetch_recent_messages": mock.Mock(return_value=[{"sender": "user", "content": "hi"}, {"sender": "AI", "content": "hello"}]),
            "ensure_session_exists": mock.Mock(),
            "insert_message": mock.Mock(),
            "update_last_active_session": mock.Mock(),
            "get_exchange_count": mock.Mock(return_value=2),
            "get_session_context": mock.Mock(return_value=(None, None)),
            "get_session_title": mock.Mock(return_value="Existing"),
            "save_journey_state": mock.Mock(),
            "save_routing_state": mock.Mock(),
            "get_guide_state": mock.Mock(return_value=None),
            "save_guide_state": mock.Mock(),
            "get_prompt_mode_override": mock.Mock(return_value=None),
            "route_turn": mock.Mock(return_value=None),
            "decide_phase": mock.Mock(return_value="SUGGESTION"),
            "touched_keys": mock.Mock(return_value=([], [])),
            "get_current_prompt": mock.Mock(return_value=("static", 15, "SUGGESTION", "<phase>x</phase>", "sonnet")),
            "retrieve_from_pgvector": mock.Mock(return_value=list(RESOURCES)),
            "retrieve_guideline_sections": mock.Mock(return_value=SECTIONS),
            "assess_response": mock.Mock(return_value={"warning_text": None}),
            "invoke_guardrail": mock.Mock(side_effect=lambda q, r: {"action": "NONE", "text": q}),
        }
        self._patchers = [mock.patch.object(chat, name, value) for name, value in self.patches.items()]
        self._patchers.append(mock.patch.object(chat.RoutingState, "from_metadata", return_value=self.routing_state))
        self._patchers.append(mock.patch.object(chat.boto3, "client", return_value=self.bedrock))
        for p in self._patchers:
            p.start()

    def tearDown(self):
        for p in self._patchers:
            p.stop()
        config.PROMPT_MODE = self._mode

    def respond(self, mode):
        config.PROMPT_MODE = mode
        streamed = []
        result = chat.get_response(
            query="my child keeps getting sent home early",
            region="us-east-1",
            llm_region="us-east-1",
            chat_session_id="s1",
            user_id=None,
            db_connection=FakeConnection(),
            stream_callback=streamed.append,
        )
        return result, "".join(streamed)

    def _saved_ai_sources(self):
        """Sources saved with the single AI message (insert_message args[4])."""
        ai_inserts = [c for c in self.patches["insert_message"].call_args_list if c.args[2] == "AI"]
        self.assertEqual(len(ai_inserts), 1)
        return ai_inserts[0].args[4]

    def assert_resources_shown(self, result, titles):
        self.assertEqual([s["title"] for s in result["sources_used"]], titles)
        self.assertEqual(self._saved_ai_sources(), result["sources_used"])
        self.assertFalse(any(_is_guide(s) for s in result["sources_used"]))
        self.assertFalse(any(_is_guide(s) for s in self._saved_ai_sources()))


class StandardModeTest(ChatModeTestBase):
    reply = "<answer>Standard answer.</answer><cited_indices>[]</cited_indices><journey_state>journey: J1</journey_state>"

    def test_standard_mode_uses_existing_pipeline(self):
        result, streamed = self.respond("standard")
        self.patches["route_turn"].assert_called_once()
        self.patches["get_current_prompt"].assert_called_once()
        self.patches["retrieve_from_pgvector"].assert_called_once()
        self.patches["retrieve_guideline_sections"].assert_not_called()
        self.patches["save_journey_state"].assert_called_once()
        self.patches["save_routing_state"].assert_called_once()
        self.patches["save_guide_state"].assert_not_called()
        self.assertEqual(result["response"], "Standard answer.")
        self.assertEqual(streamed, "Standard answer.")


class GuidelineModeTest(ChatModeTestBase):
    def test_guideline_mode_skips_router_but_searches_library(self):
        result, streamed = self.respond("guideline")
        self.patches["route_turn"].assert_not_called()
        self.patches["decide_phase"].assert_not_called()
        self.patches["get_current_prompt"].assert_not_called()
        self.patches["retrieve_guideline_sections"].assert_called_once()
        self.patches["retrieve_from_pgvector"].assert_called_once()
        self.assertEqual(
            self.patches["retrieve_from_pgvector"].call_args.kwargs["num_results"],
            chat.GUIDELINE_RESOURCE_COUNT,
        )
        self.assertEqual(result["phase"], "SUGGESTION")

        payload = self.bedrock.converse_stream.call_args.kwargs
        self.assertEqual(payload["modelId"], config.SONNET_ARN)
        self.assertIn("<instructions>", payload["system"][0]["text"])
        dynamic = payload["system"][2]["text"]
        self.assertIn("[1] Situation: Child sent home early", dynamic)
        # Resources continue the numbering after the guide sections.
        self.assertIn("<source_2>", dynamic)
        self.assertIn("<source_3>", dynamic)
        self.assertNotIn("<source_1>", dynamic)
        self.assertEqual(len(payload["messages"]), 3)

    def test_cited_resources_get_normal_cards(self):
        result, _ = self.respond("guideline")
        titles = [s["title"] for s in result["sources_used"]]
        self.assertEqual(titles, ["Keeping a school log"])
        video = result["sources_used"][0]
        self.assertEqual(video["url"], "https://example.org/video")
        self.assertEqual(video["source_type"], "video")

    def test_previous_situation_feeds_library_search(self):
        self.patches["get_guide_state"].return_value = {
            "document_id": "d1", "section_key": "J1 > Sent home", "label": "Child sent home early",
        }
        self.respond("guideline")
        query = self.patches["retrieve_from_pgvector"].call_args.args[0]
        self.assertIn("Child sent home early", query)

    def test_guide_state_is_hidden_and_persisted(self):
        result, streamed = self.respond("guideline")
        self.assertNotIn("guide_state", streamed)
        self.assertNotIn("section:", streamed)
        self.assertNotIn("guide_state", result["response"])
        self.patches["save_guide_state"].assert_called_once_with(
            mock.ANY, "s1",
            {"document_id": "d1", "section_key": "J1 > Sent home", "label": "Child sent home early"},
        )
        self.patches["save_journey_state"].assert_not_called()
        self.patches["save_routing_state"].assert_not_called()

    _is_guide = staticmethod(_is_guide)

    def test_guide_citations_are_never_public(self):
        result, _ = self.respond("guideline")
        self.assertEqual(len(result["sources_used"]), 1)
        self.assertFalse(any(self._is_guide(s) for s in result["sources_used"]))

        # Nothing guide-related is saved with the AI message either.
        ai_inserts = [c for c in self.patches["insert_message"].call_args_list if c.args[2] == "AI"]
        self.assertEqual(len(ai_inserts), 1)
        saved_sources = ai_inserts[0].args[4]
        self.assertEqual([s["title"] for s in saved_sources], ["Keeping a school log"])
        self.assertFalse(any(self._is_guide(s) for s in saved_sources))

        # Grounding check still runs against the full guide section.
        sources_arg = self.patches["assess_response"].call_args.kwargs["sources"]
        self.assertEqual(sources_arg[0]["content"], SECTIONS[0]["content"])
        self.assertEqual(sources_arg[0]["source_type"], "guideline")

    def test_previous_section_is_passed_to_retrieval(self):
        previous = {"document_id": "d1", "section_key": "J1 > Sent home", "label": "Child sent home early"}
        self.patches["get_guide_state"].return_value = previous
        self.respond("guideline")
        kwargs = self.patches["retrieve_guideline_sections"].call_args.kwargs
        self.assertEqual(kwargs["previous_section"], previous)


class GuidelineClarifyTest(ChatModeTestBase):
    reply = CLARIFY_REPLY

    def test_clarifying_question_skips_grounding_and_state(self):
        result, streamed = self.respond("guideline")
        self.assertIn("What has been happening at school?", streamed)
        self.assertEqual(result["sources_used"], [])
        self.assertEqual(self._saved_ai_sources(), [])
        self.patches["assess_response"].assert_not_called()
        self.patches["save_guide_state"].assert_not_called()


class GuidelineEmptyCitationsWithSectionTest(ChatModeTestBase):
    """Explicit [] marks a clarifying turn even when a section is chosen."""
    reply = EMPTY_CITATIONS_WITH_SECTION_REPLY

    def test_explicit_empty_citations_show_no_resources(self):
        result, _ = self.respond("guideline")
        self.assertEqual(result["sources_used"], [])
        self.assertEqual(self._saved_ai_sources(), [])


class GuidelineGuideOnlyCitationTest(ChatModeTestBase):
    """Regression: the model cited only the guide section, so "More resources"
    was empty. main.py sends sources_used unchanged as complete.sources, so
    asserting sources_used covers the streamed complete payload."""
    reply = GUIDE_ONLY_LINKED_REPLY

    def test_library_resources_still_shown(self):
        result, _ = self.respond("guideline")
        # Linked resource first, then by score; both are >= DEFAULT_MIN_SCORE.
        self.assert_resources_shown(result, ["Keeping a school log", "Unrelated PDF"])

    def test_fallback_resources_are_not_grounding(self):
        self.respond("guideline")
        sources_arg = self.patches["assess_response"].call_args.kwargs["sources"]
        self.assertEqual(len(sources_arg), 1)
        self.assertEqual(sources_arg[0]["source_type"], "guideline")
        self.patches["save_guide_state"].assert_called_once()


class GuidelineGuideOnlyNoLinkTest(ChatModeTestBase):
    """Guide-only citation, no link in the answer: resources ordered by score;
    complete.sources is sources_used (see main.py)."""
    reply = GUIDE_ONLY_REPLY

    def test_resources_ordered_by_score_and_low_scores_excluded(self):
        low = {
            "type": "WEB", "source_type": "http", "title": "Low score page",
            "url": "https://example.org/low", "uri": "https://example.org/low",
            "content": "Barely related.", "score": 0.2, "metadata": {},
        }
        higher_pdf = dict(RESOURCES[1], title="Better PDF", score=0.7)
        self.patches["retrieve_from_pgvector"].return_value = [RESOURCES[0], low, higher_pdf]
        result, _ = self.respond("guideline")
        self.assert_resources_shown(result, ["Better PDF", "Keeping a school log"])
        self.assertLessEqual(len(result["sources_used"]), chat.GUIDELINE_FALLBACK_RESOURCE_COUNT)

    def test_only_low_scores_shows_nothing(self):
        low = dict(RESOURCES[1], score=0.1)
        self.patches["retrieve_from_pgvector"].return_value = [low]
        result, _ = self.respond("guideline")
        self.assertEqual(result["sources_used"], [])
        self.assertEqual(self._saved_ai_sources(), [])


class GuidelineMissingCitationsTest(ChatModeTestBase):
    """No <cited_indices> block at all on a guidance answer."""
    reply = NO_CITATIONS_REPLY

    def test_resources_still_shown(self):
        result, _ = self.respond("guideline")
        self.assert_resources_shown(result, ["Keeping a school log", "Unrelated PDF"])
        self.patches["save_guide_state"].assert_called_once()


if __name__ == "__main__":
    unittest.main()
