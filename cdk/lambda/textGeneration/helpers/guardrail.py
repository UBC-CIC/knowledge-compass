import boto3
import logging
from helpers import config

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


def _apply_guardrail(text: str, source: str, region: str) -> dict:
    client = boto3.client('bedrock-runtime', region_name=region)
    return client.apply_guardrail(
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
    Calls the Bedrock apply_guardrail API on the model's final answer
    (source='OUTPUT'). Same return shape as invoke_guardrail:

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
