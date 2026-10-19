"""
DB-sourced text placed inside the model's system prompt.

chat_sessions.metadata is client-reachable storage (POST /chat_sessions has
been able to write it), so values read back from it are treated as data, not
instructions: bounded, XML-escaped so they cannot close their prompt block,
and shape-checked before they are used as lookup keys.

Used by logic.py (<previous_journey_state>), guideline_prompt.py
(<previous_situation>) and crud.get_guide_state.
"""

import html
import re
from typing import Any, Optional, Tuple

# Matches routing.MAX_PREVIOUS_STATE_CHARS (the router's copy of the state).
MAX_JOURNEY_STATE_CHARS = 1500
# Matches the label cap in guideline_prompt.parse_guide_state.
MAX_GUIDE_LABEL_CHARS = 120
# Matches knowledgeBase/helpers/guideline_document._SECTION_KEY_MAX.
MAX_SECTION_KEY_CHARS = 500

# Same pattern as handlers/utils/validation.js UUID_REGEX.
_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def as_prompt_data(value: Any, max_chars: int) -> str:
    """
    `value` as bounded, XML-escaped text for an XML-style prompt block, or ""
    for non-str or blank input. Truncates before escaping so an entity is
    never split.
    """
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    return html.escape(text[:max_chars], quote=False)


def guide_state_key(value: Any) -> Optional[Tuple[str, str]]:
    """
    (document_id, section_key) from a stored guide_state, or None unless it is
    a dict with a canonical UUID document_id and a non-blank section_key of at
    most MAX_SECTION_KEY_CHARS. No str() coercion: stored dicts/lists fail.
    """
    if not isinstance(value, dict):
        return None
    document_id = value.get("document_id")
    section_key = value.get("section_key")
    if not isinstance(document_id, str) or not _UUID_RE.fullmatch(document_id):
        return None
    if not isinstance(section_key, str) or not section_key.strip() or len(section_key) > MAX_SECTION_KEY_CHARS:
        return None
    return document_id, section_key
