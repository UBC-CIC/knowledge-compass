"""
Unit tests for the per-answer character cap in helpers/chat.py (finding A-06).
Bedrock, retrieval, routing and the DB are mocked. Run from textGeneration:

    python -m unittest discover -s tests -p test_answer_cap.py -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers import config  # noqa: E402
from helpers.chat import (  # noqa: E402
    ANSWER_CHAR_CAP_FALLBACK,
    ANSWER_TRUNCATION_MARKER,
    answer_char_cap,
    cap_answer_length,
)
from test_chat_guideline_mode import ChatModeTestBase  # noqa: E402

LONG_ANSWER = " ".join(f"word{i}" for i in range(200))  # ~1,290 characters


class CapAnswerLengthTest(unittest.TestCase):
    def test_short_text_is_unchanged(self):
        self.assertEqual(cap_answer_length("Keep a record.", 100), "Keep a record.")
        self.assertEqual(cap_answer_length("x" * 100, 100), "x" * 100)

    def test_long_text_is_cut_on_a_word_and_marked(self):
        capped = cap_answer_length(LONG_ANSWER, 100)
        self.assertLessEqual(len(capped), 100)
        self.assertTrue(capped.endswith(ANSWER_TRUNCATION_MARKER))
        body = capped[: -len(ANSWER_TRUNCATION_MARKER)]
        self.assertTrue(LONG_ANSWER.startswith(body))
        # Cut between words, not inside one.
        self.assertEqual(LONG_ANSWER[len(body)], " ")

    def test_text_without_spaces_is_cut_hard(self):
        capped = cap_answer_length("x" * 500, 100)
        self.assertEqual(capped, "x" * 99 + ANSWER_TRUNCATION_MARKER)

    def test_newline_counts_as_a_boundary(self):
        text = "a" * 60 + "\n" + "b" * 60
        self.assertEqual(cap_answer_length(text, 100), "a" * 60 + ANSWER_TRUNCATION_MARKER)


class AnswerCharCapSettingTest(unittest.TestCase):
    def setUp(self):
        self._cap = config.MAX_CHARACTERS_PER_AI_MESSAGE

    def tearDown(self):
        config.MAX_CHARACTERS_PER_AI_MESSAGE = self._cap

    def test_uses_the_admin_setting(self):
        config.MAX_CHARACTERS_PER_AI_MESSAGE = 1234
        self.assertEqual(answer_char_cap(), 1234)

    def test_invalid_setting_falls_back(self):
        for bad in (None, 0, -5, "abc"):
            config.MAX_CHARACTERS_PER_AI_MESSAGE = bad
            self.assertEqual(answer_char_cap(), ANSWER_CHAR_CAP_FALLBACK)


class AnswerCapResponseTest(ChatModeTestBase):
    reply = (
        f"<answer>{LONG_ANSWER}</answer>"
        "<cited_indices>[1]</cited_indices><journey_state>journey: J1</journey_state>"
    )
    cap = 200

    def setUp(self):
        super().setUp()
        self._cap = config.MAX_CHARACTERS_PER_AI_MESSAGE
        config.MAX_CHARACTERS_PER_AI_MESSAGE = self.cap

    def tearDown(self):
        config.MAX_CHARACTERS_PER_AI_MESSAGE = self._cap
        super().tearDown()

    def _saved_ai_text(self):
        ai_inserts = [c for c in self.patches["insert_message"].call_args_list if c.args[2] == "AI"]
        self.assertEqual(len(ai_inserts), 1)
        return ai_inserts[0].args[3]

    def test_long_answer_is_capped_everywhere(self):
        result, streamed = self.respond("standard")
        capped = cap_answer_length(LONG_ANSWER, self.cap)

        self.assertEqual(result["response"], capped)
        self.assertEqual(self._saved_ai_text(), capped)
        self.patches["invoke_output_guardrail"].assert_called_once_with(capped, config.REGION)
        self.assertLessEqual(len(streamed), self.cap)
        self.assertEqual(streamed, capped)

    def test_hidden_tags_after_a_long_answer_are_still_used(self):
        result, _ = self.respond("standard")
        self.assertEqual(len(result["sources_used"]), 1)
        self.patches["save_journey_state"].assert_called_once()

    def test_answer_within_cap_is_untouched(self):
        config.MAX_CHARACTERS_PER_AI_MESSAGE = 5000
        result, streamed = self.respond("standard")
        self.assertEqual(result["response"], LONG_ANSWER)
        self.assertEqual(streamed, LONG_ANSWER)


if __name__ == "__main__":
    unittest.main()
