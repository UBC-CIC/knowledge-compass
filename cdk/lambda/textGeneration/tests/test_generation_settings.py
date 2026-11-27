"""
Bedrock call settings in helpers/chat.py and helpers/intervention.py: the
title and grounding calls use config.HAIKU_ARN, maxTokens follows the
per-answer character cap, and token usage is logged as counts only.
Bedrock, retrieval, routing and the DB are mocked. Run from textGeneration:

    python -m unittest discover -s tests -p test_generation_settings.py -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers import chat, config, intervention  # noqa: E402
from test_chat_guideline_mode import ChatModeTestBase  # noqa: E402

REPLY = (
    "<answer>Keep a dated record of each early pickup.</answer>"
    "<cited_indices>[1]</cited_indices><journey_state>journey: J1</journey_state>"
)


class ConfiguredModelTest(ChatModeTestBase):
    reply = REPLY

    def setUp(self):
        super().setUp()
        self._haiku = config.HAIKU_ARN
        config.HAIKU_ARN = "configured-haiku-profile"

    def tearDown(self):
        config.HAIKU_ARN = self._haiku
        super().tearDown()

    def test_grounding_check_uses_the_configured_model(self):
        self.respond("standard")
        kwargs = self.patches["assess_response"].call_args.kwargs
        self.assertEqual(kwargs["verifier_model_id"], "configured-haiku-profile")

    def test_title_uses_the_configured_model(self):
        self.patches["get_session_title"].return_value = None
        self.patches["get_exchange_count"].return_value = 1
        self.bedrock.converse.return_value = {"output": {"message": {"content": [{"text": "Sent Home Early"}]}}}
        result, _ = self.respond("standard")
        self.assertEqual(result["session_name"], "Sent Home Early")
        self.assertEqual(self.bedrock.converse.call_args.kwargs["modelId"], "configured-haiku-profile")


class ModelDefaultsTest(unittest.TestCase):
    def setUp(self):
        self._haiku = config.HAIKU_ARN
        config.HAIKU_ARN = "configured-haiku-profile"
        self.bedrock = mock.Mock()

    def tearDown(self):
        config.HAIKU_ARN = self._haiku

    def test_title_defaults_to_config(self):
        self.bedrock.converse.return_value = {"output": {"message": {"content": [{"text": "A Title"}]}}}
        with mock.patch.object(chat, "bedrock_runtime", return_value=self.bedrock):
            chat._generate_session_title("q", "a", "ca-central-1")
        self.assertEqual(self.bedrock.converse.call_args.kwargs["modelId"], "configured-haiku-profile")

    def test_grounding_defaults_to_config(self):
        self.bedrock.converse.return_value = {"output": {"message": {"content": [{"text": "{}"}]}}}
        with mock.patch.object(intervention, "bedrock_runtime", return_value=self.bedrock):
            intervention.assess_response("q", "an answer", [], "ca-central-1")
        self.assertEqual(self.bedrock.converse.call_args.kwargs["modelId"], "configured-haiku-profile")


# ── maxTokens and token usage ─────────────────────────────────────────────────

USAGE = {
    "inputTokens": 3100, "outputTokens": 240, "totalTokens": 3340,
    "cacheReadInputTokens": 2048, "cacheWriteInputTokens": 0,
}


def _stream_with_metadata(text, stop_reason="end_turn"):
    events = [{"contentBlockDelta": {"delta": {"text": text[i:i + 7]}}} for i in range(0, len(text), 7)]
    events.append({"messageStop": {"stopReason": stop_reason}})
    events.append({"metadata": {"usage": USAGE, "metrics": {"latencyMs": 900}}})
    return {"stream": events}


class GenerationMaxTokensTest(unittest.TestCase):
    def test_follows_the_character_cap_with_headroom(self):
        self.assertEqual(chat.generation_max_tokens(5000), 1667 + chat.HIDDEN_TAG_TOKEN_HEADROOM)
        self.assertEqual(chat.generation_max_tokens(300), 100 + chat.HIDDEN_TAG_TOKEN_HEADROOM)

    def test_never_exceeds_config_max_tokens(self):
        # The highest admin cap (LIMIT_CEILINGS) still fits under MAX_TOKENS.
        ceiling = config.LIMIT_CEILINGS["max_characters_per_ai_message"]
        self.assertLessEqual(chat.generation_max_tokens(ceiling), config.MAX_TOKENS)
        self.assertEqual(chat.generation_max_tokens(10 ** 6), config.MAX_TOKENS)


class GenerationRequestTest(ChatModeTestBase):
    reply = REPLY

    def setUp(self):
        super().setUp()
        self._cap = config.MAX_CHARACTERS_PER_AI_MESSAGE
        self.bedrock.converse_stream.side_effect = lambda **kw: _stream_with_metadata(self.reply)

    def tearDown(self):
        config.MAX_CHARACTERS_PER_AI_MESSAGE = self._cap
        super().tearDown()

    def test_max_tokens_follows_the_admin_cap(self):
        config.MAX_CHARACTERS_PER_AI_MESSAGE = 3000
        self.respond("standard")
        sent = self.bedrock.converse_stream.call_args.kwargs["inferenceConfig"]["maxTokens"]
        self.assertEqual(sent, chat.generation_max_tokens(3000))

    def test_usage_is_logged_as_counts_only(self):
        with self.assertLogs(chat.logger, level="INFO") as logs:
            self.respond("standard")
        usage_lines = [line for line in logs.output if "Generation usage" in line]
        self.assertEqual(len(usage_lines), 1)
        self.assertIn("input=3100 output=240 cache_read=2048 cache_write=0 stop_reason=end_turn", usage_lines[0])
        for line in logs.output:
            self.assertNotIn("early pickup", line)
            self.assertNotIn("sent home", line)

    def test_hitting_max_tokens_is_a_warning(self):
        self.bedrock.converse_stream.side_effect = lambda **kw: _stream_with_metadata(self.reply, "max_tokens")
        with self.assertLogs(chat.logger, level="WARNING") as logs:
            self.respond("standard")
        self.assertTrue(any("stopped at maxTokens" in line for line in logs.output))


if __name__ == "__main__":
    unittest.main()
