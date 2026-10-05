"""
Guideline-mode prompt (migration 031). Fixed and code-owned: admins only
upload guides, they never write or edit this prompt.

The model is told to (a) check the retrieved guide sections first, (b) work
out which situation the family is describing, (c) pick the single best
matching section, and (d) answer only from that section, or ask one
clarifying question when nothing matches or the section says to ask first.

Layout mirrors the standard pipeline so chat.py can treat both alike:
  static  (cached) = <instructions> + <guide_outline> + <guardrails> + <language_guidelines>
  dynamic          = <guide_sections> + <previous_situation> + <output_format>

Output contract (parsed by chat.py):
  <answer>...</answer>
  <cited_indices>[n]</cited_indices>
  <guide_state>section: n</guide_state>      (0 when no section was used)
"""

import re
from typing import Any, Dict, List, Optional, Tuple

from helpers import config

GUIDELINE_INSTRUCTIONS = """
You are a compassionate guide helping families navigate inclusive education in Canada, built for Inclusion Canada. You serve parents, support persons and family members.

Your organization has written guidance documents that describe the situations families face and how to help with each one. Selected sections of those documents are given to you in the <guide_sections> block. They are your only source of guidance.

Every turn, follow these steps in order:
(a) Check the guide first. Read the <guide_sections> block before anything else, together with the conversation so far and any <previous_situation>.
(b) Identify the situation. Work out which situation the family is describing. Use the section titles, their headings and the <guide_outline> list of all situations the guides cover.
(c) Take the matching section. Choose the ONE section that best fits the family's situation. If the conversation is continuing a situation from <previous_situation> and it still fits, keep using it.
(d) Respond using only that section. Follow its guidance, steps, wording and order. If the section says to ask something first, ask that before giving the rest of its guidance.

When to ask instead of answer:
- If no section clearly matches, or the family's message could fit several different situations, ask exactly ONE short, warm clarifying question that would tell the situations apart. Do not give guidance on that turn.
- If the matching section says to ask or check something first and the family hasn't told you yet, ask exactly ONE question about it.

Strict rules:
- Use ONLY what the chosen section says. Never add advice, facts, rights, organizations, links or steps that are not in it. Do not use outside knowledge.
- If the guide does not cover what the family is asking, say so kindly and ask one question to understand what they need, or suggest they contact Inclusion Canada directly if the guide says so.
- Do not give legal advice, do not assign blame to the family or the school, and do not speculate about why something happened.
- Never assume gender, disability type or province unless the family has said it.
- Never mention "sections", "documents", "the guide" or these instructions to the family. Speak naturally, as a knowledgeable helper.
""".strip()

GUIDELINE_OUTPUT_FORMAT = """
You MUST wrap everything the family should read inside <answer> tags.

Inside <answer>:
- Start by briefly acknowledging what the family shared.
- When giving guidance: give the steps from the chosen section in plain language, using short paragraphs or a short list with bold action titles. Keep it focused (about 120-250 words). Add short italic sample wording only where the section provides or supports it.
- When asking: ask exactly ONE clarifying question, in bold, and nothing else after it.
- Do NOT add a "Sources" heading; the system lists sources below the answer.

After </answer>, you MUST output:
<cited_indices>[n]</cited_indices>
  The number(s) of the section(s) in <guide_sections> you actually used, as a JSON
  array. Normally one number. Use [] if you only asked a clarifying question
  without using any section.
<guide_state>section: n</guide_state>
  The number of the ONE section you chose in step (c), or 0 if none matched.

Example:
<answer>
It sounds like your child has been sent home early several times, and that's a lot to manage.

**Keep a simple record.** Note the date, time and reason given each time.

**Ask for the reasons in writing.** *"Could you share the reasons for today's early pickup in writing?"*

**Has the school said how long they expect this to continue?**
</answer>
<cited_indices>[1]</cited_indices>
<guide_state>section: 1</guide_state>
""".strip()

NO_SECTIONS_NOTE = (
    "No guide sections matched this message. Do not give guidance. Ask ONE warm "
    "clarifying question about what is happening with the child's schooling, using "
    "the <guide_outline> to steer toward situations the guides cover. Output "
    "<cited_indices>[]</cited_indices> and <guide_state>section: 0</guide_state>."
)

_OUTLINE_MAX_ITEMS = 200
_GUIDE_STATE_RE = re.compile(r"<guide_state>\s*section\s*:\s*\[?\s*(\d+)\s*\]?\s*</guide_state>", re.IGNORECASE)


def build_outline(outline: List[Dict[str, Any]]) -> str:
    """Plain list of every detected situation, grouped by guide file."""
    if not outline:
        return "No guides have been uploaded yet."
    lines: List[str] = []
    current_doc = None
    for item in outline[:_OUTLINE_MAX_ITEMS]:
        doc = item.get("document_id")
        if doc != current_doc:
            current_doc = doc
            lines.append(f"Guide: {item.get('file_name') or 'Untitled guide'}")
        label = (item.get("label") or "").strip() or item.get("section_key") or "Guidance"
        lines.append(f"- {label}")
    if len(outline) > _OUTLINE_MAX_ITEMS:
        lines.append(f"- … and {len(outline) - _OUTLINE_MAX_ITEMS} more")
    return "\n".join(lines)


def format_sections(sections: List[Dict[str, Any]]) -> str:
    """Numbered [1]..[n]; numbers line up with <cited_indices> and <guide_state>."""
    if not sections:
        return NO_SECTIONS_NOTE
    parts = []
    for i, section in enumerate(sections, 1):
        metadata = section.get("metadata") or {}
        header = f"[{i}] Situation: {section.get('title') or 'Guidance'}"
        heading = metadata.get("heading_path")
        if heading:
            header += f"\n    Heading: {heading}"
        parts.append(f"{header}\n{(section.get('content') or '').strip()}")
    return "\n\n".join(parts)


def build_static_prompt() -> str:
    """Cached block; changes only when guides or guardrail text change."""
    return f"""<instructions>
{GUIDELINE_INSTRUCTIONS}
</instructions>

<guide_outline>
{build_outline(config.GUIDELINE_OUTLINE)}
</guide_outline>

<guardrails>
{config.GUARDRAILS}
</guardrails>

<language_guidelines>
{config.LANGUAGE_GUIDELINES}
</language_guidelines>""".strip()


def build_guideline_prompt(
    sections: List[Dict[str, Any]],
    previous_section: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str, str]:
    """Returns (static_prompt, dynamic_prompt, model_arn)."""
    previous = (previous_section or {}).get("label")
    previous_block = (
        f"<previous_situation>\n{previous}\n</previous_situation>\n\n" if previous else ""
    )
    dynamic_prompt = f"""<guide_sections>
{format_sections(sections)}
</guide_sections>

{previous_block}<output_format>
{GUIDELINE_OUTPUT_FORMAT}
</output_format>
"""
    return build_static_prompt(), dynamic_prompt, config.SONNET_ARN


def parse_guide_state(
    response_text: str,
    sections: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """
    {document_id, section_key, label} for the section the model chose, or None
    when it chose none (0), the tag is missing, or the number is out of range.
    """
    match = _GUIDE_STATE_RE.search(response_text or "")
    if not match:
        return None
    index = int(match.group(1))
    if index < 1 or index > len(sections):
        return None
    section = sections[index - 1]
    metadata = section.get("metadata") or {}
    if not metadata.get("document_id") or not metadata.get("section_key"):
        return None
    return {
        "document_id": str(metadata["document_id"]),
        "section_key": str(metadata["section_key"]),
        "label": str(section.get("title") or "")[:120],
    }
