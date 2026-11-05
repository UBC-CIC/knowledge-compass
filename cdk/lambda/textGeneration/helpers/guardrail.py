import logging
import re
import time
from helpers import config
from helpers.bedrock_clients import bedrock_runtime

logger = logging.getLogger(__name__)

# Actions returned by this module (not raw Bedrock actions)
ACTION_NONE = 'NONE'
ACTION_ANONYMIZED = 'ANONYMIZED'       # PII redacted — continue to LLM with redacted text
ACTION_BLOCKED = 'BLOCKED'             # Prompt injection — skip LLM entirely

# Shown if Bedrock blocks an answer without returning its blocked-output
# message. Never fall back to the answer itself.
OUTPUT_BLOCKED_FALLBACK = "Sorry, I can't share that answer. Please try asking in a different way."

# Stored in place of a user message the input guardrail blocked. History is
# replayed to the model unscreened, so the raw text (and any PII it holds)
# must never reach chat_messages.
BLOCKED_INPUT_PLACEHOLDER = "[Message blocked by the content filter]"

# Streaming output screening (finding f-609f1065). Batches end on a sentence or
# line boundary; each call screens the whole visible answer so far.
STREAM_FIRST_BATCH_CHARS = 200      # first release: fast first paint
STREAM_MIN_BATCH_CHARS = 400        # later releases: at least this many new chars...
STREAM_BATCH_GROWTH = 0.5           # ...or half of what is already released, whichever is larger
STREAM_FORCE_FLUSH_CHARS = 1000     # no boundary in this much pending text: cut at a safe space
STREAM_MAX_WAIT_SECONDS = 1.5       # slow output: release at a boundary after this long
STREAM_MAX_SCREEN_CALLS = 8         # per answer; then the rest waits for the final check

_STREAM_BOUNDARY = re.compile(r"\n|[.!?](?=\s)")

# Screener states. A stream-call failure is a pause: the final check owns the
# fail-closed outcome.
_ACTIVE = 'active'
_PAUSED = 'paused'
_BLOCKED = 'blocked'


def _apply_guardrail(text: str, source: str, region: str) -> dict:
    return bedrock_runtime(region).apply_guardrail(
        guardrailIdentifier=config.GUARDRAIL_ID,
        guardrailVersion=config.GUARDRAIL_VERSION,
        source=source,
        content=[{'text': {'text': text}}],
    )


def _has_masked_pii(assessment: dict) -> bool:
    # PII is under sensitiveInformationPolicy.piiEntities (built-in entities)
    # or .regexes (custom filters, e.g. CA_POSTAL_CODE / STREET_ADDRESS).
    # Never log the 'match' values: they hold the raw PII.
    sensitive = assessment.get('sensitiveInformationPolicy', {})
    return bool(sensitive.get('piiEntities') or sensitive.get('regexes'))


def invoke_output_guardrail(answer_text: str, region: str) -> dict:
    """
    Calls the Bedrock apply_guardrail API on model output (source='OUTPUT'):
    the final answer, and each streamed prefix via OutputStreamScreener.
    Same return shape as invoke_guardrail:

    BLOCKED:    a content filter fired; 'text' is the blocked-answer message.
    ANONYMIZED: only high-risk identifiers (SIN, health number, card, bank)
                were masked; 'text' is the masked answer.
    NONE:       'text' is the answer unchanged.

    Raises any boto3 exception to the caller (do not swallow errors here).
    """
    response = _apply_guardrail(answer_text, 'OUTPUT', region)
    if response.get('action', 'NONE') != 'GUARDRAIL_INTERVENED':
        return {'action': ACTION_NONE, 'text': answer_text}

    outputs = response.get('outputs', [])
    output_text = outputs[0].get('text') if outputs else None

    has_blocked_content = False
    has_pii = False
    for assessment in response.get('assessments', []):
        for f in assessment.get('contentPolicy', {}).get('filters', []):
            if f.get('action') == 'BLOCKED':
                has_blocked_content = True
        if _has_masked_pii(assessment):
            has_pii = True

    if has_pii and not has_blocked_content and output_text:
        logger.info("Output guardrail: PII anonymized in answer")
        return {'action': ACTION_ANONYMIZED, 'text': output_text}

    if has_blocked_content and output_text:
        logger.info("Output guardrail: answer blocked by content filter")
        return {'action': ACTION_BLOCKED, 'text': output_text}

    # Unknown intervention: the returned text may still be the answer, so
    # show the fixed message instead.
    logger.warning("Output guardrail intervened for unknown reason, blocking")
    return {'action': ACTION_BLOCKED, 'text': OUTPUT_BLOCKED_FALLBACK}


def _release_end(visible, start):
    """
    End index of the next release in visible, or None. Prefers the last
    sentence/line boundary past start. With no boundary and enough pending
    text, cuts after the last whitespace that is not between two digits, so
    an identifier such as '046 454 286' stays in one batch.
    """
    end = None
    for m in _STREAM_BOUNDARY.finditer(visible):
        if m.end() > start:
            end = m.end()
    if end is not None:
        return end
    if len(visible) - start < STREAM_FORCE_FLUSH_CHARS:
        return None
    for i in range(len(visible) - 1, start - 1, -1):
        if not visible[i].isspace():
            continue
        before = visible[i - 1] if i - 1 >= 0 else ''
        after = visible[i + 1] if i + 1 < len(visible) else ''
        if before.isdigit() and after.isdigit():
            continue
        return i + 1
    return None


class OutputStreamScreener:
    """
    Gate between the stream sanitisers and the client (finding f-609f1065).
    Model text is buffered and released at sentence or line boundaries.
    Before each release the whole visible answer so far is screened, and only
    the guardrail's returned text is sent. A block stops the stream; a failed
    or unusable call pauses it and the final check decides the answer.

    Never logs model text: only exception type names, counts and state.
    """

    def __init__(self, send, screen, region, clock=time.monotonic):
        # send(text): posts one chunk. screen(text, region) -> {'action', 'text'}.
        self._send = send
        self._screen = screen
        self._region = region
        self._clock = clock
        self._state = _ACTIVE
        self._released_raw = ""      # visible prefix last screened and released
        self.sent_text = ""          # everything sent so far (masked where masked)
        self.calls = 0
        self.blocked_result = None
        self._last_release_at = None  # set on the first offer with visible text

    @property
    def stopped(self):
        """Blocked: the caller must stop reading the model stream."""
        return self._state == _BLOCKED

    def offer(self, visible):
        """Offer the sanitised, capped, left-stripped answer so far."""
        if self._state != _ACTIVE:
            return
        if not visible.startswith(self._released_raw):
            # Sanitising rewrote released text; a later delta may extend it.
            return
        pending = visible[len(self._released_raw):]
        if not pending.strip():
            return
        if self._last_release_at is None:
            self._last_release_at = self._clock()

        if self._released_raw:
            threshold = max(STREAM_MIN_BATCH_CHARS, int(len(self._released_raw) * STREAM_BATCH_GROWTH))
        else:
            threshold = STREAM_FIRST_BATCH_CHARS
        if (len(pending) < threshold
                and self._clock() - self._last_release_at < STREAM_MAX_WAIT_SECONDS):
            return

        end = _release_end(visible, len(self._released_raw))
        if end is None:
            return
        candidate = visible[:end]
        if not candidate[len(self._released_raw):].strip():
            # A release must add visible text.
            return

        self.calls += 1
        try:
            result = self._screen(candidate, self._region)
        except Exception as e:
            logger.error("Stream output guardrail invocation failed: %s", type(e).__name__)
            self._state = _PAUSED
            return

        if not isinstance(result, dict) or not isinstance(result.get('text'), str):
            logger.error("Stream output guardrail returned an unusable result")
            self._state = _PAUSED
            return

        action = result.get('action')
        if action not in (ACTION_NONE, ACTION_ANONYMIZED):
            # An unknown action's text may be the candidate itself: never use it.
            if action == ACTION_BLOCKED and result['text']:
                text = result['text']
            else:
                text = OUTPUT_BLOCKED_FALLBACK
            self.blocked_result = {'action': ACTION_BLOCKED, 'text': text}
            self._state = _BLOCKED
            return

        screened = result['text']
        if not screened.startswith(self.sent_text):
            logger.info("Stream output screening paused: screened text no longer extends sent text")
            self._state = _PAUSED
            return
        delta = screened[len(self.sent_text):]
        if delta:
            self._send(delta)
        self.sent_text = screened
        self._released_raw = candidate
        self._last_release_at = self._clock()
        if self.calls >= STREAM_MAX_SCREEN_CALLS:
            # The rest of the answer waits for the final check.
            self._state = _PAUSED

    def finish(self, final_text):
        """
        Send the rest of the screened final answer, or nothing when it was
        blocked or failed (None), or no longer extends what was sent.
        """
        # Also covers a last release that ended on the newline before
        # </answer>: the stripped final text then does not extend sent_text.
        if (isinstance(final_text, str) and self._state != _BLOCKED
                and final_text.startswith(self.sent_text)
                and len(final_text) > len(self.sent_text)):
            self._send(final_text[len(self.sent_text):])
        logger.info(
            "Stream output screening: calls=%d sent_chars=%d state=%s",
            self.calls, len(self.sent_text), self._state,
        )


def invoke_guardrail(user_message: str, region: str) -> dict:
    """
    Calls the Bedrock apply_guardrail API for the given user message.

    Returns a dict with:
      - 'action': str  ('NONE' | 'ANONYMIZED' | 'BLOCKED')
      - 'text': str    (redacted text if ANONYMIZED, denial message if BLOCKED,
                        original text if NONE)

    ANONYMIZED: PII was found and masked — caller should pass redacted text to LLM.
    BLOCKED:    Prompt injection detected — caller should skip LLM and return denial.

    Raises any boto3 exception to the caller (do not swallow errors here).
    """
    response = _apply_guardrail(user_message, 'INPUT', region)

    raw_action = response.get('action', 'NONE')
    outputs = response.get('outputs', [])
    output_text = outputs[0].get('text', user_message) if outputs else user_message

    if raw_action != 'GUARDRAIL_INTERVENED':
        return {'action': ACTION_NONE, 'text': user_message}

    # Bedrock uses GUARDRAIL_INTERVENED for both PII masking and prompt injection.
    # Inspect assessments to distinguish: if only sensitiveInformationPolicy fired
    # (no promptAttack), it's a PII redaction — continue to LLM with redacted text.
    assessments = response.get('assessments', [])
    has_prompt_attack = False
    has_pii = False

    for assessment in assessments:
        # Prompt attack is under contentPolicy.filters with type PROMPT_ATTACK
        for f in assessment.get('contentPolicy', {}).get('filters', []):
            if f.get('type') == 'PROMPT_ATTACK' and f.get('action') == 'BLOCKED':
                has_prompt_attack = True
        if _has_masked_pii(assessment):
            has_pii = True

    if has_prompt_attack:
        logger.info("Guardrail: prompt injection blocked")
        return {'action': ACTION_BLOCKED, 'text': output_text}

    if has_pii:
        logger.info("Guardrail: PII anonymized, continuing to LLM")
        return {'action': ACTION_ANONYMIZED, 'text': output_text}

    # Intervened for some other reason — treat as blocked to be safe
    logger.warning("Guardrail intervened for unknown reason, blocking")
    return {'action': ACTION_BLOCKED, 'text': output_text}
