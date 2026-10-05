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

GUIDELINE_REPLY = (
    "<answer>It sounds hard. **Keep a record.** Note each early pickup.</answer>\n"
    "<cited_indices>[1]</cited_indices>\n"
    "<guide_state>section: 1</guide_state>"
)
CLARIFY_REPLY = (
    "<answer>Thanks for reaching out. **What has been happening at school?**</answer>\n"
    "<cited_indices>[]</cited_indices>\n"
    "<guide_state>section: 0</guide_state>"
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
            "route_turn": mock.Mock(return_value=None),
            "decide_phase": mock.Mock(return_value="SUGGESTION"),
            "touched_keys": mock.Mock(return_value=([], [])),
            "get_current_prompt": mock.Mock(return_value=("static", 15, "SUGGESTION", "<phase>x</phase>", "sonnet")),
            "retrieve_from_pgvector": mock.Mock(return_value=[]),
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
    def test_guideline_mode_skips_router_and_corpus(self):
        result, streamed = self.respond("guideline")
        self.patches["route_turn"].assert_not_called()
        self.patches["decide_phase"].assert_not_called()
        self.patches["get_current_prompt"].assert_not_called()
        self.patches["retrieve_from_pgvector"].assert_not_called()
        self.patches["retrieve_guideline_sections"].assert_called_once()
        self.assertEqual(result["phase"], "SUGGESTION")

        payload = self.bedrock.converse_stream.call_args.kwargs
        self.assertEqual(payload["modelId"], config.SONNET_ARN)
        self.assertIn("<instructions>", payload["system"][0]["text"])
        self.assertIn("[1] Situation: Child sent home early", payload["system"][2]["text"])
        self.assertEqual(len(payload["messages"]), 3)

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

    def test_citation_has_no_preview_or_link(self):
        result, _ = self.respond("guideline")
        self.assertEqual(len(result["sources_used"]), 1)
        source = result["sources_used"][0]
        self.assertEqual(source["title"], "Family guide: Child sent home early")
        self.assertEqual(source["content"], "")
        self.assertEqual(source["url"], "")
        self.assertNotIn("metadata", source)
        # Grounding check runs against the full section.
        sources_arg = self.patches["assess_response"].call_args.kwargs["sources"]
        self.assertEqual(sources_arg[0]["content"], SECTIONS[0]["content"])

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
        self.patches["assess_response"].assert_not_called()
        self.patches["save_guide_state"].assert_not_called()


if __name__ == "__main__":
    unittest.main()
