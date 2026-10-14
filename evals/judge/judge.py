"""
Direct LLM judge (default: a Claude Opus model, so Sonnet/Haiku never grade
their own answers). One forced-tool Converse call per journey transcript
scores:

  (a) the reference conversation flow from the user story, step by step
  (b) the guidance against each acceptance criterion and testing check
  (c) detective behaviour before the guidance turn
  (d) product rules (no legal advice, blame, speculation or deficit language;
      family-friendly and collaborative) and grounding in the cited sources

Report-only: scores are numbers for trend comparison, not pass/fail gates.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from evals.bedrock import converse_tool
from evals.schema import Scenario

RUBRIC_DIR = Path(__file__).resolve().parent / "rubrics"
JUDGE_TOOL = "record_assessment"
TRANSCRIPT_CHARS_PER_REPLY = 6000

FLOW_SCORES = {"present_first_reply": 1.0, "present_later": 0.75, "partial": 0.5, "absent": 0.0}
CRITERION_SCORES = {"met": 1.0, "partial": 0.5, "not_met": 0.0}


def _rubric(name: str) -> str:
    return (RUBRIC_DIR / name).read_text(encoding="utf-8").strip()


def product_rules() -> List[Tuple[str, str]]:
    rules = []
    for line in _rubric("product_rules.md").splitlines():
        if "|" in line:
            key, text = line.split("|", 1)
            rules.append((key.strip(), text.strip()))
    return rules


def judge_schema(rule_keys: Sequence[str]) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "reference_flow": {
                "type": "array",
                "description": "One entry per reference step, in order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "step": {"type": "integer"},
                        "verdict": {"type": "string", "enum": list(FLOW_SCORES)},
                        "note": {"type": "string"},
                    },
                    "required": ["step", "verdict"],
                },
            },
            "criteria": {
                "type": "array",
                "description": "One entry per numbered expectation, in order.",
                "items": {
                    "type": "object",
                    "properties": {
                        "item": {"type": "integer"},
                        "verdict": {"type": "string", "enum": [*CRITERION_SCORES, "not_applicable"]},
                        "note": {"type": "string"},
                    },
                    "required": ["item", "verdict"],
                },
            },
            "detective": {
                "type": "object",
                "properties": {
                    "score": {"type": "integer", "minimum": 1, "maximum": 5},
                    "repeated_questions": {"type": "boolean"},
                    "premature_guidance": {"type": "boolean"},
                    "note": {"type": "string"},
                },
                "required": ["score", "repeated_questions", "premature_guidance"],
            },
            "product_rules": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "rule": {"type": "string", "enum": list(rule_keys)},
                        "verdict": {"type": "string", "enum": ["pass", "fail", "unclear"]},
                        "note": {"type": "string"},
                    },
                    "required": ["rule", "verdict"],
                },
            },
            "grounding": {
                "type": "object",
                "properties": {
                    "score": {"type": "integer", "minimum": 1, "maximum": 5},
                    "note": {"type": "string"},
                },
                "required": ["score"],
            },
            "overall_note": {"type": "string"},
        },
        "required": ["reference_flow", "criteria", "detective", "product_rules", "grounding"],
    }


def guidance_index(transcript: Dict[str, Any]) -> Optional[int]:
    return (transcript.get("outcome") or {}).get("guidance_turn")


def render_transcript(transcript: Dict[str, Any]) -> str:
    g = guidance_index(transcript)
    lines = []
    for turn in transcript.get("turns") or []:
        i = turn.get("index", 0)
        lines.append(f"[Turn {i + 1}] Parent: {turn.get('user', '')}")
        label = "GUIDANCE TURN" if g is not None and i == g else (turn.get("phase") or "reply")
        reply = (turn.get("response") or "(no reply)")[:TRANSCRIPT_CHARS_PER_REPLY]
        lines.append(f"[Turn {i + 1}] Assistant ({label}): {reply}")
        sources = turn.get("sources") or []
        if sources:
            cited = "; ".join(
                f"{s.get('title') or 'Untitled'}: {(s.get('content') or '')[:300]}" for s in sources[:6]
            )
            lines.append(f"[Turn {i + 1}] Cited sources (previews): {cited}")
        if turn.get("warning"):
            lines.append(f"[Turn {i + 1}] Grounding warning shown: {turn['warning']}")
    if g is None:
        lines.append("(The conversation never reached a guidance turn; judge guidance expectations against the last reply.)")
    return "\n".join(lines)


def expectations(scenario: Scenario) -> List[str]:
    items = list(scenario.acceptance_criteria) + list(scenario.testing_checks)
    if scenario.guiding_question:
        framing = f"Helps the parent answer: \"{scenario.guiding_question}\""
        if scenario.avoid_framing:
            framing += f" rather than only: \"{scenario.avoid_framing}\""
        items.append(framing)
    return items


def build_prompt(scenario: Scenario, transcript: Dict[str, Any]) -> str:
    flow = "\n".join(
        f"{i + 1}. {step.step} {step.text}".strip() for i, step in enumerate(scenario.reference_flow)
    ) or "(no reference flow)"
    items = "\n".join(f"{i + 1}. {x}" for i, x in enumerate(expectations(scenario)))
    rules = "\n".join(f"- {k}: {t}" for k, t in product_rules())
    mode_note = (
        "This conversation used GUIDELINE mode (answers come only from uploaded family guides; it may ask "
        "one clarifying question before answering)."
        if transcript.get("mode") == "guideline" else
        "This conversation used STANDARD mode (detective questions first, then guidance)."
    )
    return f"""User story {scenario.story_id}: {scenario.story_text}
Situation: {scenario.situation_summary}
{mode_note}

REFERENCE FLOW (what the story's authors expect the assistant to do, in order). For each step say whether
it appears in the assistant's first reply (present_first_reply), only in a later reply up to and
including the guidance turn (present_later), only partly (partial), or not at all (absent):
{flow}

EXPECTATIONS for the guidance (acceptance criteria and testing checks). Judge each against the
guidance turn, using earlier turns as context: met, partial, not_met, or not_applicable:
{items}

DETECTIVE BEHAVIOUR:
{_rubric("detective.md")}

PRODUCT RULES (judge across every assistant reply; pass, fail, or unclear):
{rules}

GROUNDING: rate 1-5 how well the guidance stays within what the cited source previews support
(5 = fully supported or clearly general advice; 1 = specific claims with no support).

TRANSCRIPT:
{render_transcript(transcript)}

Call {JUDGE_TOOL} with every reference step, every expectation, the detective rating, every product
rule and the grounding rating."""


def _mean(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 3) if values else None


def score(assessment: Dict[str, Any], scenario: Scenario) -> Dict[str, Any]:
    flow = [FLOW_SCORES[x["verdict"]] for x in assessment.get("reference_flow") or [] if x.get("verdict") in FLOW_SCORES]
    first_reply = [1.0 if x.get("verdict") == "present_first_reply" else 0.0
                   for x in assessment.get("reference_flow") or [] if x.get("verdict") in FLOW_SCORES]
    criteria = [CRITERION_SCORES[x["verdict"]] for x in assessment.get("criteria") or []
                if x.get("verdict") in CRITERION_SCORES]
    rules = [x for x in assessment.get("product_rules") or [] if x.get("verdict") in ("pass", "fail")]
    detective = assessment.get("detective") or {}
    grounding = assessment.get("grounding") or {}
    det_score = detective.get("score")
    g_score = grounding.get("score")
    return {
        "reference_flow": _mean(flow),
        "reference_flow_first_reply": _mean(first_reply),
        "acceptance_criteria": _mean(criteria),
        "criteria_judged": len(criteria),
        "criteria_expected": len(expectations(scenario)),
        "detective": round(det_score / 5, 3) if isinstance(det_score, int) else None,
        "product_rules_pass_rate": _mean([1.0 if r["verdict"] == "pass" else 0.0 for r in rules]),
        "product_rule_failures": [r.get("rule") for r in rules if r["verdict"] == "fail"],
        "grounding": round(g_score / 5, 3) if isinstance(g_score, int) else None,
    }


class Judge:
    def __init__(self, client, model_id: str):
        self.client = client
        self.model_id = model_id

    def assess(self, scenario: Scenario, transcript: Dict[str, Any]) -> Dict[str, Any]:
        rule_keys = [k for k, _ in product_rules()]
        assessment = converse_tool(
            self.client, self.model_id, _rubric("judge_system.md"), build_prompt(scenario, transcript),
            JUDGE_TOOL, "Record the assessment of this conversation.", judge_schema(rule_keys),
            max_tokens=6000, temperature=0.0,
        )
        if assessment is None:
            return {"story_id": scenario.story_id, "mode": transcript.get("mode"), "error": "judge returned no assessment"}
        outcome = transcript.get("outcome") or {}
        return {
            "story_id": scenario.story_id,
            "mode": transcript.get("mode"),
            "judge_model": self.model_id,
            "reached_guidance": outcome.get("reached_guidance"),
            "turns_to_guidance": (outcome["guidance_turn"] + 1) if outcome.get("guidance_turn") is not None else None,
            "scores": score(assessment, scenario),
            "assessment": assessment,
        }
