"""
Hidden metadata tags (<journey_state>, <cited_indices>, <detective_state>,
<guide_state>) never reach the family, even when the model puts them inside
<answer> or leaves out </answer>. Run from textGeneration:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
from test_chat_guideline_mode import ChatModeTestBase  # noqa: E402
from helpers import chat  # noqa: E402

ANSWER = "Here is your next step.\n\nWould it help to plan what you'll bring to the meeting?"
STATE = "journey: J2\nsituation: L\nnext_need: prepare for the meeting"


class StripHiddenTagsTest(unittest.TestCase):
    def test_removes_closed_block_inside_text(self):
        text = f"Before.<journey_state>{STATE}</journey_state> After."
        self.assertEqual(chat.strip_hidden_tags(text), "Before. After.")

    def test_drops_everything_after_unclosed_tag(self):
        self.assertEqual(chat.strip_hidden_tags(f"Answer.\n<journey_state>{STATE}"), "Answer.")

    def test_removes_stray_closing_and_answer_tags(self):
        self.assertEqual(chat.strip_hidden_tags("<answer>Answer.</answer></journey_state>"), "Answer.")

    def test_plain_text_is_unchanged(self):
        self.assertEqual(chat.strip_hidden_tags("Use a <b>-free answer? 3 < 4."), "Use a <b>-free answer? 3 < 4.")


class _LeakCase(ChatModeTestBase):
    def assert_hidden(self):
        result, streamed = self.respond("standard")
        self.assertEqual(result["response"], ANSWER)
        self.assertNotIn("journey_state", streamed)
        self.assertNotIn("journey:", streamed)
        self.patches["save_journey_state"].assert_called_once()
        saved = [c.args[3] for c in self.patches["insert_message"].call_args_list if c.args[2] == "AI"]
        self.assertEqual(saved, [ANSWER])


class StateInsideAnswerTest(_LeakCase):
    reply = f"<answer>{ANSWER}\n\n<journey_state>\n{STATE}\n</journey_state>\n</answer>\n<cited_indices>[]</cited_indices>"

    def test_state_is_hidden(self):
        self.assert_hidden()


class MissingAnswerCloseTest(_LeakCase):
    reply = f"<answer>{ANSWER}\n\n<journey_state>\n{STATE}\n</journey_state>"

    def test_state_is_hidden(self):
        self.assert_hidden()


class HistoryReplayTest(ChatModeTestBase):
    reply = f"<answer>{ANSWER}</answer><cited_indices>[]</cited_indices><journey_state>{STATE}</journey_state>"

    def test_leaked_state_in_history_is_not_replayed(self):
        self.patches["fetch_recent_messages"].return_value = [
            {"sender": "user", "content": "hi"},
            {"sender": "AI", "content": f"Earlier answer.\n<journey_state>{STATE}</journey_state>"},
        ]
        self.respond("standard")
        messages = self.bedrock.converse_stream.call_args.kwargs["messages"]
        self.assertEqual(messages[1]["content"][0]["text"], "Earlier answer.")
        router_history = self.patches["route_turn"].call_args.kwargs["chat_history"]
        self.assertEqual(router_history[1]["content"], "Earlier answer.")


if __name__ == "__main__":
    unittest.main()
