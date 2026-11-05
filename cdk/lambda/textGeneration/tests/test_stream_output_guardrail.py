"""
Unit tests for screening streamed answer text with the output guardrail
(finding f-609f1065): OutputStreamScreener in helpers/guardrail.py and its use
in helpers/chat.get_response. Bedrock, retrieval, routing and the DB are
mocked. Run from textGeneration:

    python -m unittest discover -s tests -p test_stream_output_guardrail.py -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers import chat, config  # noqa: E402
from helpers.chat import GENERATION_ERROR_TEXT  # noqa: E402
from helpers.guardrail import (  # noqa: E402
    ACTION_ANONYMIZED,
    ACTION_BLOCKED,
    ACTION_NONE,
    OUTPUT_BLOCKED_FALLBACK,
    STREAM_MAX_SCREEN_CALLS,
    OutputStreamScreener,
)
from test_chat_guideline_mode import ChatModeTestBase, FakeConnection  # noqa: E402

SIN = "046 454 286"
SIN_MASK = "{CA_SOCIAL_INSURANCE_NUMBER}"
GUARDRAIL_LOGGER = "helpers.guardrail"


def sentences(n, start=0):
    """n fixed-width sentences ("Sentence 000 is calm. " = 22 chars each)."""
    return "".join(f"Sentence {i:03d} is calm. " for i in range(start, start + n))


class FakeClock:
    """Whole milliseconds, so elapsed-time comparisons are exact."""

    def __init__(self):
        self.now_ms = 0

    def __call__(self):
        return self.now_ms / 1000

    def advance(self, seconds):
        self.now_ms += round(seconds * 1000)


def identity(text):
    return {"action": ACTION_NONE, "text": text}


class OutputStreamScreenerTest(unittest.TestCase):
    def make_screener(self, screen_fn=identity):
        self.sent = []
        self.inputs = []
        self.clock = FakeClock()

        def screen(text, region):
            self.inputs.append((text, region))
            return screen_fn(text)

        return OutputStreamScreener(self.sent.append, screen, "us-east-1", clock=self.clock)

    def screened_args(self):
        return [text for text, _ in self.inputs]

    def release(self, screener, visible):
        """Release `visible` up to its last boundary via the time rule."""
        screener.offer(visible)
        self.clock.advance(2)
        screener.offer(visible)

    def test_u1_short_offer_makes_no_call(self):
        screener = self.make_screener()
        screener.offer(sentences(5))  # 110 chars
        self.assertEqual(self.inputs, [])
        self.assertEqual(self.sent, [])

    def test_u2_first_release_ends_on_the_last_boundary(self):
        screener = self.make_screener()
        visible = sentences(10) + "Partial sente"
        screener.offer(visible)
        expected = visible[:visible.rfind(". ") + 1]
        self.assertEqual(self.inputs, [(expected, "us-east-1")])
        self.assertEqual("".join(self.sent), expected)

    def test_u3_second_release_screens_the_full_prefix_and_sends_the_delta(self):
        screener = self.make_screener()
        screener.offer(sentences(10))
        first = self.screened_args()[0]
        self.assertEqual(len(first), 219)

        screener.offer(sentences(28) + "ab")  # 399 pending
        self.assertEqual(len(self.inputs), 1)

        visible = sentences(30)  # 441 pending
        screener.offer(visible)
        self.assertEqual(len(self.inputs), 2)
        second = self.screened_args()[1]
        self.assertEqual(second, visible[:-1])
        self.assertTrue(second.startswith(first))
        self.assertEqual(self.sent, [first, second[len(first):]])

    def test_u3_threshold_grows_with_released_text(self):
        screener = self.make_screener()
        screener.offer(sentences(46))  # releases 1,011 chars
        released = self.screened_args()[0]
        self.assertEqual(len(released), 1011)

        screener.offer(sentences(66))  # 441 pending: >= 400 but < 505
        self.assertEqual(len(self.inputs), 1)

        screener.offer(sentences(69))  # 507 pending
        self.assertEqual(len(self.inputs), 2)

    def test_u4_time_flush_releases_at_a_boundary(self):
        screener = self.make_screener()
        screener.offer("Hi there. More")
        self.assertEqual(self.inputs, [])
        self.clock.advance(1.6)
        screener.offer("Hi there. More")
        self.assertEqual(self.screened_args(), ["Hi there."])
        self.assertEqual(self.sent, ["Hi there."])

    def test_u4_time_flush_without_a_boundary_waits(self):
        screener = self.make_screener()
        screener.offer("Hi there and more")
        self.clock.advance(1.6)
        screener.offer("Hi there and more")
        self.assertEqual(self.inputs, [])
        self.assertEqual(self.sent, [])

    def test_u5_force_flush_never_cuts_between_digits(self):
        screener = self.make_screener()
        visible = "word " * 200 + "SIN " + SIN
        screener.offer(visible)
        self.assertEqual(self.screened_args(), ["word " * 200 + "SIN "])
        self.assertTrue(all(SIN not in text for text in self.screened_args()))
        self.assertNotIn(SIN, "".join(self.sent))

    def test_u6_anonymized_text_is_sent_masked(self):
        def mask(text):
            if SIN in text:
                return {"action": ACTION_ANONYMIZED, "text": text.replace(SIN, SIN_MASK)}
            return identity(text)

        screener = self.make_screener(mask)
        screener.offer(f"Your SIN {SIN} is not needed. " + sentences(9))
        streamed = "".join(self.sent)
        self.assertIn(SIN_MASK, streamed)
        self.assertNotIn(SIN, streamed)

    def test_u7_masked_divergence_pauses(self):
        calls = []

        def diverge(text):
            calls.append(text)
            if len(calls) == 2:
                return {"action": ACTION_ANONYMIZED, "text": "Masked " + text}
            return identity(text)

        screener = self.make_screener(diverge)
        screener.offer(sentences(10))
        self.assertEqual(len(self.sent), 1)
        with self.assertLogs(GUARDRAIL_LOGGER, "INFO") as logs:
            screener.offer(sentences(30))
        self.assertEqual(len(self.sent), 1)
        output = "\n".join(logs.output)
        self.assertIn("Stream output screening paused: screened text no longer extends sent text", output)
        self.assertNotIn("Sentence", output)

        self.clock.advance(2)
        screener.offer(sentences(60))
        self.assertEqual(len(self.inputs), 2)
        self.assertFalse(screener.stopped)

    def test_u8_blocked_stops_and_sends_nothing(self):
        for text, expected in (("Blocked.", "Blocked."), ("", OUTPUT_BLOCKED_FALLBACK)):
            with self.subTest(text=text):
                screener = self.make_screener(lambda _t, text=text: {"action": ACTION_BLOCKED, "text": text})
                screener.offer(sentences(10))
                self.assertEqual(self.sent, [])
                self.assertTrue(screener.stopped)
                self.assertEqual(screener.blocked_result, {"action": ACTION_BLOCKED, "text": expected})
                self.clock.advance(2)
                screener.offer(sentences(40))
                self.assertEqual(len(self.inputs), 1)

    def test_u9_unknown_action_is_a_block_with_the_fallback(self):
        screener = self.make_screener(lambda text: {"action": "WEIRD", "text": text})
        screener.offer(sentences(10))
        self.assertTrue(screener.stopped)
        self.assertEqual(screener.blocked_result, {"action": ACTION_BLOCKED, "text": OUTPUT_BLOCKED_FALLBACK})
        self.assertEqual(self.sent, [])

    def assert_paused_without_text_in_logs(self, screener, logs, message):
        self.assertFalse(screener.stopped)
        self.assertIsNone(screener.blocked_result)
        self.assertEqual(self.sent, [])
        output = "\n".join(logs.output)
        self.assertIn(message, output)
        self.assertNotIn("Sentence", output)

        self.clock.advance(2)
        screener.offer(sentences(40))
        self.assertEqual(len(self.inputs), 1)

    def test_u10_exception_pauses_streaming(self):
        def boom(_text):
            raise RuntimeError("boom secret")

        screener = self.make_screener(boom)
        with self.assertLogs(GUARDRAIL_LOGGER, "ERROR") as logs:
            screener.offer(sentences(10))
        self.assert_paused_without_text_in_logs(
            screener, logs, "Stream output guardrail invocation failed: RuntimeError"
        )
        self.assertNotIn("boom secret", "\n".join(logs.output))

        final = sentences(40).strip()
        screener.finish(final)
        self.assertEqual(self.sent, [final])

    def test_u11_unusable_result_pauses_streaming(self):
        for result in (None, {"action": ACTION_NONE}, {"action": ACTION_NONE, "text": 5}):
            with self.subTest(result=result):
                screener = self.make_screener(lambda _t, result=result: result)
                with self.assertLogs(GUARDRAIL_LOGGER, "ERROR") as logs:
                    screener.offer(sentences(10))
                self.assert_paused_without_text_in_logs(
                    screener, logs, "Stream output guardrail returned an unusable result"
                )

    def test_u12_call_cap(self):
        screener = self.make_screener()
        for n in range(1, 13):
            screener.offer(sentences(n))
            self.clock.advance(2)
            screener.offer(sentences(n))
        self.assertEqual(len(self.inputs), STREAM_MAX_SCREEN_CALLS)

    def test_u13_rewritten_released_text_makes_no_call(self):
        screener = self.make_screener()
        self.release(screener, "A. B. ")
        self.assertEqual(self.screened_args(), ["A. B."])
        self.clock.advance(2)
        screener.offer("X. B. C. D. ")
        self.assertEqual(len(self.inputs), 1)

    def test_u14_finish(self):
        def blocked(_text):
            return {"action": ACTION_BLOCKED, "text": "Blocked."}

        def boom(_text):
            raise RuntimeError("boom")

        cases = (
            # (name, screen_fn, released visible, final_text, expected sent after finish)
            ("tail", identity, "A. B. ", "A. B. C.", ["A. B.", " C."]),
            ("tail after pause", boom, "A. B. ", "A. B. C.", ["A. B. C."]),
            ("trailing newline", identity, "X.\n", "X.", ["X.\n"]),
            ("diverged", identity, "A. B. ", "Different.", ["A. B."]),
            ("none", identity, "A. B. ", None, ["A. B."]),
            ("blocked", blocked, "A. B. ", "A. B. C.", []),
        )
        for name, screen_fn, visible, final_text, expected in cases:
            with self.subTest(name):
                screener = self.make_screener(screen_fn)
                with self.assertLogs(GUARDRAIL_LOGGER, "INFO") as logs:
                    self.release(screener, visible)
                    screener.finish(final_text)
                self.assertEqual(self.sent, expected)
                output = "\n".join(logs.output)
                self.assertIn("Stream output screening: calls=1 sent_chars=", output)
                self.assertNotIn("A. B.", output)
                self.assertNotIn("X.", output)

    def test_u15_timer_starts_at_the_first_visible_text(self):
        screener = self.make_screener()
        self.clock.advance(5)
        screener.offer("\n")
        screener.offer("Hi.\n")
        self.assertEqual(self.inputs, [])
        self.clock.advance(1.4)
        screener.offer("Hi.\n")
        self.assertEqual(self.inputs, [])
        self.clock.advance(0.1)
        screener.offer("Hi.\n")
        self.assertEqual(self.screened_args(), ["Hi.\n"])

    def test_u16_whitespace_only_release_makes_no_call(self):
        screener = self.make_screener()
        self.release(screener, "A. B. ")
        self.assertEqual(self.screened_args(), ["A. B."])
        self.clock.advance(2)
        screener.offer("A. B.\n\n")
        screener.offer("A. B.\n\nC")
        self.assertEqual(len(self.inputs), 1)


ANSWER_SENTENCES = [f"Sentence {i} explains one calm next step for the family." for i in range(23)]
ANSWER = " ".join(ANSWER_SENTENCES)  # ~1,270 chars
BLOCKED_TEXT = "Blocked answer."
MARKER = "This marker sentence must never be shown."


def make_reply(answer):
    return (
        "<answer>\n" + answer + "\n</answer>\n<cited_indices>[1]</cited_indices>\n"
        "<journey_state>journey: J1</journey_state>"
    )


REPLY = make_reply(ANSWER)


def events(text, size=7):
    return [
        {"contentBlockDelta": {"delta": {"text": text[i:i + size]}}}
        for i in range(0, len(text), size)
    ]


class CountingStream:
    """Model stream fake that counts events read and records close()."""

    def __init__(self, items):
        self.items = items
        self.read = 0
        self.closed = False

    def __iter__(self):
        for item in self.items:
            self.read += 1
            yield item

    def close(self):
        self.closed = True


class StreamScreeningResponseTest(ChatModeTestBase):
    reply = REPLY

    def setUp(self):
        super().setUp()
        self.assertTrue(1200 <= len(ANSWER) <= 1300)
        self.order = []
        self.chunks = []
        self.screen_fn = identity
        self.patches["invoke_output_guardrail"].side_effect = self._screen

    def _screen(self, text, region):
        self.order.append(("screen", text))
        return self.screen_fn(text)

    def _on_chunk(self, text):
        self.chunks.append(text)
        self.order.append(("chunk", text))

    def stream(self, rest=False):
        config.PROMPT_MODE = "standard"
        return chat.get_response(
            query="my child keeps getting sent home early",
            region="us-east-1",
            llm_region="us-east-1",
            chat_session_id="s1",
            user_id=None,
            db_connection=FakeConnection(),
            stream_callback=None if rest else self._on_chunk,
        )

    def _saved_ai_text(self):
        ai_inserts = [c for c in self.patches["insert_message"].call_args_list if c.args[2] == "AI"]
        self.assertEqual(len(ai_inserts), 1)
        return ai_inserts[0].args[3]

    def screen_args(self):
        return [text for kind, text in self.order if kind == "screen"]

    def screen_positions(self):
        return [i for i, (kind, _) in enumerate(self.order) if kind == "screen"]

    def chunk_positions(self):
        return [i for i, (kind, _) in enumerate(self.order) if kind == "chunk"]

    def test_c1_clean_answer_streams_screened_prefixes(self):
        result = self.stream()
        args = self.screen_args()
        self.assertGreater(len(args), 1)
        for text in args[:-1]:
            self.assertTrue(result["response"].startswith(text))
            self.assertFalse(text[:1].isspace())
        self.assertEqual(args[-1], ANSWER)
        self.assertEqual("".join(self.chunks).strip(), result["response"])
        self.assertGreater(self.chunk_positions()[-1], self.screen_positions()[-1])

    def test_c2_mid_stream_block_stops_the_stream(self):
        answer = " ".join(ANSWER_SENTENCES[:12] + [MARKER] + ANSWER_SENTENCES[12:])
        self.assertTrue(600 < answer.index(MARKER) < 800)
        fake = CountingStream(events(make_reply(answer)))
        self.bedrock.converse_stream.side_effect = lambda **kw: {"stream": fake}

        def block_marker(text):
            if MARKER in text:
                return {"action": ACTION_BLOCKED, "text": BLOCKED_TEXT}
            return identity(text)

        self.screen_fn = block_marker
        result = self.stream()
        streamed = "".join(self.chunks)
        self.assertNotIn(MARKER, streamed)
        self.assertTrue(self.chunks)
        self.assertEqual(result["response"], BLOCKED_TEXT)
        self.assertEqual(result["sources_used"], [])
        self.assertEqual(self._saved_ai_text(), BLOCKED_TEXT)
        self.patches["assess_response"].assert_not_called()
        self.patches["save_journey_state"].assert_not_called()
        self.patches["save_routing_state"].assert_not_called()
        self.assertLess(fake.read, len(fake.items))
        self.assertTrue(fake.closed)

    def test_c3_mid_stream_masking(self):
        answer = f"Your SIN {SIN} is not needed. " + ANSWER
        self.reply = make_reply(answer)

        def mask(text):
            if SIN in text:
                return {"action": ACTION_ANONYMIZED, "text": text.replace(SIN, SIN_MASK)}
            return identity(text)

        self.screen_fn = mask
        result = self.stream()
        streamed = "".join(self.chunks)
        self.assertNotIn(SIN, streamed)
        self.assertIn(SIN_MASK, streamed)
        self.assertIn(SIN_MASK, result["response"])
        self.assertNotIn(SIN, result["response"])
        self.assertIn(SIN_MASK, self._saved_ai_text())
        self.assertNotIn(SIN, self._saved_ai_text())

    def test_c4_stream_call_error_pauses_then_final_check_decides(self):
        count = [0]

        def fail_second(text):
            count[0] += 1
            if count[0] == 2:
                raise RuntimeError("guardrail down")
            return identity(text)

        self.screen_fn = fail_second
        result = self.stream()
        screens = self.screen_positions()
        self.assertGreaterEqual(len(screens), 3)
        failing, final = screens[1], screens[-1]
        self.assertFalse([i for i in self.chunk_positions() if failing < i < final])
        self.assertEqual(self.screen_args()[-1], ANSWER)
        self.assertEqual(result["response"], ANSWER)
        self.assertEqual("".join(self.chunks).strip(), result["response"])
        self.assertTrue(result["sources_used"])

    def test_c4b_stream_error_and_final_error_fail_closed(self):
        count = [0]

        def fail_from_second(text):
            count[0] += 1
            if count[0] >= 2:
                raise RuntimeError("guardrail down")
            return identity(text)

        self.screen_fn = fail_from_second
        result = self.stream()
        self.assertEqual(result["response"], GENERATION_ERROR_TEXT)
        self.assertEqual(result["sources_used"], [])
        failing = self.screen_positions()[1]
        self.assertFalse([i for i in self.chunk_positions() if i > failing])
        self.patches["assess_response"].assert_not_called()
        self.patches["save_routing_state"].assert_not_called()
        # Pins today's behaviour on a failed final check.
        self.patches["save_journey_state"].assert_called_once()
        self.assertEqual(self._saved_ai_text(), GENERATION_ERROR_TEXT)

    def test_c5_hidden_tags_and_uris_never_stream(self):
        self.reply = make_reply("See [Handbook](s3://bucket/key.pdf) for details. " + ANSWER)
        self.stream()
        streamed = "".join(self.chunks)
        # The final call screens the answer before URI stripping, as before.
        stream_args = self.screen_args()[:-1]
        self.assertTrue(stream_args)
        for text in [streamed] + stream_args:
            self.assertNotIn("<cited", text)
            self.assertNotIn("journey_state", text)
            self.assertNotIn("s3://", text)
        self.assertIn("See Handbook for details.", streamed)

    def test_c6_final_block_after_clean_prefixes(self):
        def block_final(text):
            if text == ANSWER:
                return {"action": ACTION_BLOCKED, "text": BLOCKED_TEXT}
            return identity(text)

        self.screen_fn = block_final
        result = self.stream()
        stream_args = self.screen_args()[:-1]
        self.assertTrue(stream_args)
        self.assertEqual("".join(self.chunks), stream_args[-1])
        self.assertEqual(result["response"], BLOCKED_TEXT)

    def test_c7_rest_path_screens_once(self):
        self.stream(rest=True)
        self.patches["invoke_output_guardrail"].assert_called_once_with(ANSWER, config.REGION)

    def test_c8_release_on_trailing_newline_sends_no_duplicate_tail(self):
        answer = " ".join(ANSWER_SENTENCES[:5])
        self.assertGreater(len(answer), 200)
        self.bedrock.converse_stream.side_effect = lambda **kw: {"stream": [
            {"contentBlockDelta": {"delta": {"text": "<answer>\n" + answer + "\n"}}},
            {"contentBlockDelta": {"delta": {"text": "</answer>\n<cited_indices>[1]</cited_indices>"}}},
        ]}
        result = self.stream()
        self.assertEqual(len(self.chunks), 1)
        self.assertTrue(all(self.chunks))
        self.assertEqual("".join(self.chunks).strip(), result["response"])


if __name__ == "__main__":
    unittest.main()
