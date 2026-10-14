"""
Extract draft scenarios from the Inclusion Canada user-story Markdown files
(PDF-to-Markdown conversions, e.g. User_Stories_-_Journey_1_Feature_1.md).

The parse is deterministic: story text, acceptance criteria, the reference
conversation, content required and testing considerations are copied
verbatim (after repairing conversion artefacts). An optional Bedrock call per
story drafts only what needs judgement: a synthetic persona, hidden facts for
the parent simulator, natural parent messages for each testing-consideration
variant and negative case, and suggested situation clusters.

Drafts are written with reviewed: false; nothing counts in a scored run until
a person reviews it.
"""

from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from evals import catalog as catalog_mod
from evals.bedrock import converse_tool
from evals.schema import (
    LABEL_MAP_FILE,
    MAX_MESSAGE_CHARS,
    LabelMap,
    ProbeCase,
    ReferenceStep,
    Scenario,
    ScenarioError,
    label_map_from_dict,
    read_yaml,
    scenario_from_dict,
    write_yaml,
)

# ------------------------------------------------------------------
# Line-level helpers
# ------------------------------------------------------------------

MARKERS = {"🟦": "situation", "🟨": "criteria", "🟧": "flow", "🟥": "content", "🟪": "notes"}
BULLET_ONLY = {"•", "o", "▪", "◦", "●", "\uf0b7"}
INLINE_BULLET = re.compile(r"^[•▪◦●]\s+(.*\S)\s*$")
STORY_HEAD = re.compile(r"^\s*user\s+story\s+([0-9A-Za-z]+)\s*:\s*(.*)$", re.IGNORECASE)
JOURNEY_HEAD = re.compile(r"^\s*user\s+journey\s+(\d+)\s*:\s*(.+)$", re.IGNORECASE)
FEATURE_HEAD = re.compile(r"^\s*feature\s+(\d+)\s*:\s*(.+)$", re.IGNORECASE)
STEP_HEAD = re.compile(r"^(\d{1,2})\.\s+(.*)$")
QUOTE_OPEN = ("“", '"', "‘")
SKIP_LINES = {"*****", "⭐"}


def normalize_lines(text: str) -> List[str]:
    out = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.replace("\u00a0", " ").replace("\u200b", "").strip()
        if line in SKIP_LINES:
            line = ""
        out.append(line)
    return out


def merge_wrapped(lines: List[str], count: int) -> List[str]:
    """
    Merge PDF-wrapped continuation lines so `lines` becomes `count` items.

    The conversion emits N bullet glyphs and then the N item texts, where a
    long item may have wrapped onto extra lines. A wrapped line ran to the
    page margin, so repeatedly join the line whose last physical segment is
    longest with the line after it.
    """
    if count <= 0 or len(lines) <= count:
        return list(lines)
    firsts: Dict[str, int] = {}
    for line in lines:
        word = _first_word(line)
        firsts[word] = firsts.get(word, 0) + 1
    items = [[line, len(line), _starts_like_item(line, firsts)] for line in lines]  # [text, tail len, item-like]
    while len(items) > count:
        # Prefer joining a line whose successor does not read like the start
        # of an item, then the line that ran furthest to the margin.
        best = max(
            range(len(items) - 1),
            key=lambda i: (not items[i + 1][2], items[i][1], -i),
        )
        text, _, like = items[best]
        nxt_text, nxt_tail, _ = items.pop(best + 1)
        items[best] = [f"{text} {nxt_text}", nxt_tail, like]
    return [t for t, _, _ in items]


# Words that commonly open an acceptance-criteria, testing or content item.
_ITEM_STARTS = {
    "recognize", "recognizes", "identify", "identifies", "explain", "explains", "help", "helps", "guide",
    "guides", "encourage", "encourages", "suggest", "suggests", "avoid", "avoids", "provide", "provides",
    "offer", "offers", "reassure", "reassures", "distinguish", "distinguishes", "connect", "connects",
    "promote", "promotes", "support", "supports", "clarify", "clarifies", "reinforce", "reinforces",
    "examples", "common", "definition", "guidance", "information", "indicators", "plain-language",
    "the", "a", "an", "lack", "being", "attending", "reduced", "does", "do", "is", "has",
}


def _first_word(line: str) -> str:
    token = line.split(" ", 1)[0] if line else ""
    return token.strip("“”\"'()[].,;:").lower()


def _starts_like_item(line: str, firsts: Dict[str, int]) -> bool:
    if not line:
        return False
    if line[0].isupper() or line[0] in "“\"'(":
        return True
    token = line.split(" ", 1)[0]
    if token.endswith((",", ";")):
        return False
    word = _first_word(line)
    return firsts.get(word, 0) >= 2 or word in _ITEM_STARTS


def _starts_quote(line: str) -> bool:
    return line.startswith(QUOTE_OPEN)


def blocks(lines: Sequence[str]) -> List[Tuple[str, Any]]:
    """
    Group lines into ("text", paragraph) and ("list", [items]) blocks,
    repairing runs of empty bullets followed by their item texts.
    """
    out: List[Tuple[str, Any]] = []
    i, n = 0, len(lines)
    while i < n:
        line = lines[i]
        if not line:
            i += 1
            continue
        if line in BULLET_ONLY:
            count = 0
            while i < n and (lines[i] in BULLET_ONLY or not lines[i]):
                if lines[i]:
                    count += 1
                i += 1
            texts: List[str] = []
            while i < n:
                cur = lines[i]
                if cur in BULLET_ONLY or INLINE_BULLET.match(cur):
                    break
                if not cur:
                    if len(texts) >= count:
                        break
                    i += 1
                    continue
                if len(texts) >= count and (cur.endswith(":") or _starts_quote(cur) or STEP_HEAD.match(cur)):
                    break
                texts.append(cur)
                i += 1
            out.append(("list", merge_wrapped(texts, count)))
            continue
        if INLINE_BULLET.match(line):
            items: List[str] = []
            while i < n:
                cur = lines[i]
                m = INLINE_BULLET.match(cur)
                if m:
                    items.append(m.group(1))
                    i += 1
                    continue
                if not cur or cur in BULLET_ONLY or cur.endswith(":") or not items:
                    break
                items[-1] = f"{items[-1]} {cur}"
                i += 1
            out.append(("list", items))
            continue
        para = [line]
        i += 1
        while i < n and lines[i] and lines[i] not in BULLET_ONLY and not INLINE_BULLET.match(lines[i]):
            if para[-1].endswith(":"):
                break
            para.append(lines[i])
            i += 1
        out.append(("text", " ".join(para)))
    return out


def _clean_item(text: str) -> str:
    return " ".join(text.split()).strip()


# ------------------------------------------------------------------
# Document structure
# ------------------------------------------------------------------

@dataclass
class RawStory:
    story_id: str
    story_text: str
    sections: Dict[str, List[str]] = field(default_factory=dict)


@dataclass
class StoryDoc:
    path: str
    journey_number: int
    journey_name: str
    journey_description: str
    feature_number: int
    feature_name: str
    feature_description: str
    stories: List[RawStory]
    problems: List[str] = field(default_factory=list)


def parse_document(text: str, path: str = "") -> StoryDoc:
    lines = normalize_lines(text)
    journey_number, journey_name, feature_number, feature_name = 0, "", 0, ""
    journey_desc: List[str] = []
    feature_desc: List[str] = []
    mode = None
    first_story = len(lines)
    for idx, line in enumerate(lines):
        if STORY_HEAD.match(line):
            first_story = idx
            break
        m = JOURNEY_HEAD.match(line)
        if m and not journey_number:
            journey_number, journey_name, mode = int(m.group(1)), _clean_item(m.group(2)), "journey"
            continue
        m = FEATURE_HEAD.match(line)
        if m and not feature_number:
            feature_number, feature_name, mode = int(m.group(1)), _clean_item(m.group(2)), "feature"
            continue
        if line.upper().startswith("STORIES:"):
            mode = None
            continue
        if line and mode == "journey":
            journey_desc.append(line)
        elif line and mode == "feature":
            feature_desc.append(line)

    problems: List[str] = []
    if not journey_number:
        problems.append(f"{path}: no 'USER JOURNEY N:' header")

    stories: List[RawStory] = []
    current: Optional[RawStory] = None
    section: Optional[str] = None
    heading_open = False
    for line in lines[first_story:]:
        m = STORY_HEAD.match(line)
        if m:
            current = RawStory(story_id=m.group(1).upper(), story_text=_clean_item(m.group(2)))
            stories.append(current)
            section, heading_open = None, True
            continue
        if current is None:
            continue
        marker = MARKERS.get(line[:1]) if line else None
        if marker:
            section, heading_open = marker, False
            current.sections.setdefault(section, [])
            # The marker line itself is the section title ("🟦 1. What's the situation here?").
            continue
        if heading_open:
            if line:
                current.story_text = _clean_item(f"{current.story_text} {line}")
                continue
            heading_open = False
        if section:
            current.sections[section].append(line)

    seen = set()
    for story in stories:
        if story.story_id in seen:
            problems.append(f"{path}: duplicate story {story.story_id}")
        seen.add(story.story_id)
        missing = [name for name in ("situation", "criteria", "flow") if name not in story.sections]
        if missing:
            problems.append(f"{path}: story {story.story_id} is missing section(s): {', '.join(missing)}")

    return StoryDoc(
        path=path,
        journey_number=journey_number,
        journey_name=journey_name,
        journey_description=" ".join(journey_desc),
        feature_number=feature_number,
        feature_name=feature_name,
        feature_description=" ".join(feature_desc),
        stories=stories,
        problems=problems,
    )


# ------------------------------------------------------------------
# Sections
# ------------------------------------------------------------------

_CRITERIA_HEADINGS = {"acceptance criteria", "the system should:", "content required", "the system needs:"}


def parse_list_section(lines: Sequence[str]) -> List[str]:
    """Items of an acceptance-criteria or content-required section."""
    items: List[str] = []
    loose: List[str] = []
    for kind, value in blocks(lines):
        if kind == "list":
            items.extend(_clean_item(v) for v in value if _clean_item(v))
        elif value.strip().lower() not in _CRITERIA_HEADINGS:
            loose.append(_clean_item(value))
    return items or loose


def parse_situation(lines: Sequence[str]) -> str:
    return " ".join(_clean_item(v) if k == "text" else "; ".join(v) for k, v in blocks(lines)).strip()


def _render(block_list: Sequence[Tuple[str, Any]]) -> str:
    parts = []
    for kind, value in block_list:
        if kind == "list":
            parts.append("; ".join(_clean_item(v) for v in value))
        else:
            parts.append(_clean_item(value))
    return " ".join(p for p in parts if p).strip()


def parse_flow(lines: Sequence[str]) -> Tuple[str, List[ReferenceStep]]:
    """(parent opening message, reference system steps) from the 🟧 section."""
    lines = list(lines)
    parent_at = next((i for i, l in enumerate(lines) if l.lower().startswith("parent:")), None)
    system_at = next((i for i, l in enumerate(lines) if l.lower().startswith("system:")), None)
    if parent_at is None:
        return "", []
    end = system_at if system_at is not None and system_at > parent_at else len(lines)
    first = lines[parent_at][len("parent:"):].strip()
    message_lines = ([first] if first else []) + [l for l in lines[parent_at + 1:end] if l]
    message = _clean_item(" ".join(message_lines)).strip().strip("“”\"")

    steps: List[ReferenceStep] = []
    if system_at is None:
        return message, steps
    current_label: Optional[str] = None
    body: List[str] = []

    def flush():
        if current_label is not None:
            steps.append(ReferenceStep(step=current_label, text=_render(blocks(body))))

    for line in lines[system_at + 1:]:
        m = STEP_HEAD.match(line)
        if m:
            flush()
            current_label, body = _clean_item(m.group(2)), []
            continue
        if current_label is not None:
            body.append(line)
    flush()
    return message, steps


def classify_intro(text: str) -> str:
    t = " ".join(text.lower().split())
    if "help parents answer" in t:
        return "guiding"
    if t.startswith("rather than"):
        return "avoid"
    if "classif" in t and "not" in t:
        return "negative"
    if t.startswith("testers") and re.search(
        r"\b(situations?|scenarios?|such as|when|involving|attributed to|preparing for)\b", t
    ):
        return "variant"
    if t.startswith("testers should verify") or t.startswith("the system should consistently:"):
        return "check"
    if "future enhancement" in t or t.startswith("this story could eventually support"):
        return "future"
    return "other"


@dataclass
class NotesInfo:
    complexity: str = ""
    variants: List[str] = field(default_factory=list)
    negatives: List[str] = field(default_factory=list)
    checks: List[str] = field(default_factory=list)
    guiding_question: Optional[str] = None
    avoid_framing: Optional[str] = None
    notes: List[str] = field(default_factory=list)


def _unquote(text: str) -> str:
    return text.strip().strip("“”\"‘’").strip()


def parse_notes(lines: Sequence[str]) -> NotesInfo:
    info = NotesInfo()
    target = "other"
    in_testing = False
    expect_complexity = False
    for kind, value in blocks(lines):
        if kind == "text":
            text = _clean_item(value)
            low = text.lower()
            if low == "estimated complexity" or low.startswith("estimated complexity"):
                expect_complexity = True
                rest = text[len("estimated complexity"):].strip(" –-:")
                if rest and any(ch in rest for ch in "🟢🟡🔴🟠"):
                    info.complexity, expect_complexity = rest, False
                continue
            if expect_complexity and any(ch in text for ch in "🟢🟡🔴🟠"):
                info.complexity, expect_complexity = text, False
                continue
            heading_at = low.find("testing considerations")
            if heading_at >= 0 and not in_testing:
                in_testing, target = True, "other"
                # The heading is often joined onto the paragraph before it or
                # onto the first intro line after it.
                text = text[heading_at + len("testing considerations"):].lstrip(" :")
                if not text:
                    continue
                low = text.lower()
                if text.endswith(":"):
                    target = classify_intro(text)
                    continue
            if low.startswith("potential future enhancement"):
                target = "future"
                continue
            if text.endswith(":"):
                target = classify_intro(text) if in_testing or "future" in low else "other"
                continue
            if _starts_quote(text) and target in ("guiding", "avoid"):
                if target == "guiding":
                    info.guiding_question = _unquote(text)
                else:
                    info.avoid_framing = _unquote(text)
                continue
            if target == "future":
                info.notes.append(f"Future enhancement: {text}")
            continue
        items = [_clean_item(v) for v in value if _clean_item(v)]
        if not in_testing and target != "future":
            continue
        if target == "variant":
            info.variants.extend(items)
        elif target == "negative":
            info.negatives.extend(items)
        elif target == "check":
            info.checks.extend(items)
        elif target == "future":
            info.notes.extend(f"Future enhancement: {i}" for i in items)
    if info.complexity:
        info.notes.insert(0, f"Complexity: {info.complexity}")
    return info


def story_to_scenario(doc: StoryDoc, story: RawStory, source_name: str) -> Scenario:
    sections = story.sections
    opening, steps = parse_flow(sections.get("flow", []))
    notes = parse_notes(sections.get("notes", []))
    return Scenario(
        story_id=story.story_id,
        journey_number=doc.journey_number,
        journey_name=doc.journey_name,
        feature_number=doc.feature_number,
        feature=doc.feature_name,
        story_text=story.story_text,
        situation_summary=parse_situation(sections.get("situation", [])),
        opening_message=opening[:MAX_MESSAGE_CHARS],
        reference_flow=steps,
        acceptance_criteria=parse_list_section(sections.get("criteria", [])),
        content_required=parse_list_section(sections.get("content", [])),
        testing_checks=notes.checks,
        guiding_question=notes.guiding_question,
        avoid_framing=notes.avoid_framing,
        variants=[ProbeCase(description=v) for v in notes.variants],
        negative_cases=[ProbeCase(description=v) for v in notes.negatives],
        notes=notes.notes,
        source={"file": source_name, "story_heading": f"User Story {story.story_id}"},
    )


# ------------------------------------------------------------------
# LLM drafting
# ------------------------------------------------------------------

DRAFT_TOOL = "draft_scenario"
DRAFT_SYSTEM = """You prepare synthetic test scenarios for a chat assistant that helps families in
Canada navigate inclusive education. You never use real people's names, schools, phone numbers,
emails or other personal details: everything you write is fictional and generic (for example
"my son", "Grade 4"). Write parent messages in a natural, plain voice, as a worried but
reasonable parent typing into a chat box. Do not use the technical term for the situation unless
the parent would plausibly know it (the assistant should recognise the situation itself). Keep
each message under 400 characters."""

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "persona": {
            "type": "string",
            "description": "2-3 sentences: who the parent is, the child's age/grade and needs, how they talk. Fictional.",
        },
        "hidden_facts": {
            "type": "array",
            "items": {"type": "string"},
            "description": "4-8 short facts the parent knows and reveals only when asked (what happened, how often, "
                           "what the school said, what they tried, what they want). Consistent with the opening message.",
        },
        "variant_messages": {
            "type": "array",
            "items": {"type": "string"},
            "description": "One opening parent message per variant, same order and count as given.",
        },
        "negative_messages": {
            "type": "array",
            "items": {"type": "string"},
            "description": "One opening parent message per negative case, same order and count as given.",
        },
        "suggested_clusters": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Catalog situation keys this story belongs to (most likely first). Empty if no catalog given.",
        },
    },
    "required": ["persona", "hidden_facts", "variant_messages", "negative_messages", "suggested_clusters"],
}


def build_draft_prompt(scenario: Scenario, journey: Optional[Dict[str, Any]]) -> str:
    def bullets(items):
        return "\n".join(f"{i + 1}. {x}" for i, x in enumerate(items)) or "(none)"

    catalog_text = (
        f"Catalog journey {journey['key']} ({journey['name']}) situations:\n{catalog_mod.describe_clusters(journey)}"
        if journey else "No catalog given: return an empty suggested_clusters list."
    )
    return f"""User story {scenario.story_id} (Journey {scenario.journey_number}: {scenario.journey_name};
Feature {scenario.feature_number}: {scenario.feature})

Story: {scenario.story_text}

Situation: {scenario.situation_summary}

Opening parent message (already written): {scenario.opening_message}

Variants (situations the assistant must still recognise as this story; write one parent message each):
{bullets([v.description for v in scenario.variants])}

Negative cases (situations the assistant must NOT treat as this journey; write one parent message each,
describing that situation plainly so it is clearly different):
{bullets([v.description for v in scenario.negative_cases])}

{catalog_text}

Call {DRAFT_TOOL} with the persona, hidden facts, one message per variant and per negative case (same
order and count), and the suggested situation keys."""


def apply_draft(scenario: Scenario, draft: Optional[Dict[str, Any]], valid_clusters: Sequence[str]) -> List[str]:
    """Fill LLM-drafted fields in place. Returns suggested cluster keys (validated)."""
    if not draft:
        return []
    persona = draft.get("persona")
    if isinstance(persona, str) and persona.strip():
        scenario.persona = persona.strip()
    facts = draft.get("hidden_facts")
    if isinstance(facts, list):
        scenario.hidden_facts = [f.strip() for f in facts if isinstance(f, str) and f.strip()]
    for cases, key in ((scenario.variants, "variant_messages"), (scenario.negative_cases, "negative_messages")):
        messages = draft.get(key)
        if isinstance(messages, list) and len(messages) == len(cases):
            for case, message in zip(cases, messages):
                if isinstance(message, str):
                    case.message = message.strip()[:MAX_MESSAGE_CHARS]
    suggested = draft.get("suggested_clusters")
    if not isinstance(suggested, list):
        return []
    allowed = set(valid_clusters)
    return [k for k in suggested if isinstance(k, str) and k in allowed]


# ------------------------------------------------------------------
# Writing drafts
# ------------------------------------------------------------------

def scenario_path(out_dir: Path, scenario: Scenario) -> Path:
    return Path(out_dir) / f"j{scenario.journey_number}_f{scenario.feature_number}" / f"{scenario.story_id}.yaml"


def _keep_drafted_fields(new: Scenario, old: Scenario) -> None:
    """When rewriting an unreviewed draft without the LLM, keep earlier LLM output."""
    if not new.persona:
        new.persona = old.persona
    if not new.hidden_facts:
        new.hidden_facts = list(old.hidden_facts)
    for new_cases, old_cases in ((new.variants, old.variants), (new.negative_cases, old.negative_cases)):
        old_by_desc = {c.description: c.message for c in old_cases}
        for case in new_cases:
            if not case.message:
                case.message = old_by_desc.get(case.description, "")
    new.modes = list(old.modes)
    new.testable = old.testable


def missing_drafted_fields(scenario: Scenario) -> bool:
    """True if any LLM-drafted field (persona, hidden facts, probe messages) is empty."""
    return (
        not scenario.persona
        or not scenario.hidden_facts
        or any(not c.message for c in scenario.variants + scenario.negative_cases)
    )


def fill_missing_fields(target: Scenario, drafted: Scenario) -> List[str]:
    """Copy drafted values into target's EMPTY drafted fields only. Returns what was filled."""
    filled: List[str] = []
    if not target.persona and drafted.persona:
        target.persona = drafted.persona
        filled.append("persona")
    if not target.hidden_facts and drafted.hidden_facts:
        target.hidden_facts = list(drafted.hidden_facts)
        filled.append("hidden_facts")
    for name, cases, new_cases in (("variants", target.variants, drafted.variants),
                                   ("negative_cases", target.negative_cases, drafted.negative_cases)):
        by_desc = {c.description: c.message for c in new_cases}
        for case in cases:
            if not case.message and by_desc.get(case.description):
                case.message = by_desc[case.description]
                filled.append(f"{name}: {case.description}")
    return filled


@dataclass
class ExtractResult:
    written: List[str] = field(default_factory=list)
    kept_reviewed: List[str] = field(default_factory=list)
    filled: Dict[str, List[str]] = field(default_factory=dict)
    reopened: List[str] = field(default_factory=list)
    problems: List[str] = field(default_factory=list)
    unmatched_journeys: List[int] = field(default_factory=list)
    stories_without_clusters: List[str] = field(default_factory=list)


def extract(
    source: Path,
    out_dir: Path,
    bedrock_client=None,
    model_id: Optional[str] = None,
    catalog: Optional[catalog_mod.Catalog] = None,
    overwrite: bool = False,
    fill_missing: bool = False,
    log=print,
) -> ExtractResult:
    """
    Parse every *.md story file in `source` and write drafts + label_map.yaml to `out_dir`.

    fill_missing: for existing files (reviewed or not), keep everything already
    in the file and only fill empty LLM-drafted fields (persona, hidden facts,
    probe messages). A reviewed file that gets new content is set back to
    reviewed: false so the new fields are checked.
    """
    result = ExtractResult()
    files = sorted(Path(source).glob("*.md"))
    if not files:
        raise ScenarioError(f"no .md files in {source}")

    label_path = Path(out_dir) / LABEL_MAP_FILE
    label_map = label_map_from_dict(read_yaml(label_path), str(label_path)) if label_path.exists() else LabelMap()
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")

    for file in files:
        doc = parse_document(file.read_text(encoding="utf-8"), str(file.name))
        result.problems.extend(doc.problems)
        journey = catalog_mod.journey_for_number(catalog, doc.journey_number, doc.journey_name) if catalog else {}
        entry = label_map.journeys.setdefault(doc.journey_number, {"name": doc.journey_name, "journey_key": None})
        entry["name"] = entry.get("name") or doc.journey_name
        if not entry.get("journey_key") and journey:
            entry["journey_key"] = journey["key"]
        if not entry.get("journey_key") and doc.journey_number not in result.unmatched_journeys:
            result.unmatched_journeys.append(doc.journey_number)
        cluster_keys = [c["key"] for c in (journey.get("clusters") or [])] if journey else []

        for story in doc.stories:
            scenario = story_to_scenario(doc, story, file.name)
            scenario.source["extracted_at"] = now
            if not scenario.opening_message or not scenario.acceptance_criteria:
                result.problems.append(f"{file.name}: story {story.story_id} has no parent message or acceptance criteria")
                continue

            path = scenario_path(out_dir, scenario)
            old: Optional[Scenario] = None
            if path.exists():
                try:
                    old = scenario_from_dict(read_yaml(path), str(path))
                except ScenarioError as e:
                    result.problems.append(f"existing draft unreadable, rewriting: {e}")
            if old and fill_missing and not overwrite:
                if not missing_drafted_fields(old) or bedrock_client is None or not model_id:
                    if old.reviewed:
                        result.kept_reviewed.append(old.story_id)
                    continue
                try:
                    draft = converse_tool(
                        bedrock_client, model_id, DRAFT_SYSTEM, build_draft_prompt(old, journey or None),
                        DRAFT_TOOL, "Draft the synthetic parts of a test scenario.", DRAFT_SCHEMA,
                        max_tokens=3000, temperature=0.4,
                    )
                except Exception as e:  # noqa: BLE001 - one failed draft must not stop extraction
                    result.problems.append(f"{old.story_id}: LLM draft failed ({type(e).__name__})")
                    continue
                drafted = scenario_from_dict(old.to_dict(), str(path))
                for c in drafted.variants + drafted.negative_cases:
                    c.message = ""
                drafted.persona, drafted.hidden_facts = "", []
                apply_draft(drafted, draft, cluster_keys)
                filled = fill_missing_fields(old, drafted)
                if not filled:
                    result.problems.append(f"{old.story_id}: draft returned nothing usable; still missing fields")
                    continue
                if old.reviewed:
                    old.reviewed = False
                    result.reopened.append(old.story_id)
                data = old.to_dict()
                scenario_from_dict(data, str(path))
                write_yaml(path, data)
                result.filled[old.story_id] = filled
                if missing_drafted_fields(old):
                    result.problems.append(f"{old.story_id}: some drafted fields are still empty (count mismatch); re-run to retry")
                continue

            if old and old.reviewed and not overwrite:
                result.kept_reviewed.append(scenario.story_id)
                continue

            suggested: List[str] = []
            if bedrock_client is not None and model_id:
                try:
                    draft = converse_tool(
                        bedrock_client, model_id, DRAFT_SYSTEM, build_draft_prompt(scenario, journey or None),
                        DRAFT_TOOL, "Draft the synthetic parts of a test scenario.", DRAFT_SCHEMA,
                        max_tokens=3000, temperature=0.4,
                    )
                    suggested = apply_draft(scenario, draft, cluster_keys)
                except Exception as e:  # noqa: BLE001 - one failed draft must not stop extraction
                    result.problems.append(f"{scenario.story_id}: LLM draft failed ({type(e).__name__}); deterministic fields only")
            if old and not overwrite:
                _keep_drafted_fields(scenario, old)

            scenario.reviewed = False
            data = scenario.to_dict()
            # Validate what we are about to write.
            scenario_from_dict(data, str(path))
            write_yaml(path, data)
            result.written.append(scenario.story_id)

            story_entry = label_map.stories.get(scenario.story_id)
            if story_entry is None or (not story_entry.get("clusters") and suggested):
                label_map.stories[scenario.story_id] = (
                    {"clusters": suggested, "suggested_by": "llm"} if suggested else {"clusters": []}
                )
            if not label_map.stories[scenario.story_id].get("clusters"):
                result.stories_without_clusters.append(scenario.story_id)
        log(f"{file.name}: journey {doc.journey_number} feature {doc.feature_number}, {len(doc.stories)} stories")

    write_yaml(label_path, label_map.to_dict())
    return result
