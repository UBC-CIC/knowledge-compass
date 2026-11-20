"""
Topic-scope guardrail cases (security finding F13): loading and validation.

evals/guardrails/f13_cases.yaml holds one-message cases that check the
assistant stays on a child's schooling: sensitive questions it must answer,
off-topic requests it must decline, harmful requests and a prompt injection it
must refuse. The `guardrails` command sends each one in a fresh session and
writes the replies for human review; nothing is scored automatically.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

import yaml

from evals.schema import MAX_MESSAGE_CHARS, STORY_ID_PATTERN, ScenarioError, read_yaml

GUARDRAILS_DIR = Path(__file__).resolve().parent / "guardrails"
DEFAULT_CASES_FILE = GUARDRAILS_DIR / "f13_cases.yaml"
# category -> the only expected behaviour allowed for it.
CATEGORIES = {
    "sensitive": "help",
    "off_topic": "decline",
    "harmful": "refuse",
    "injection": "refuse",
}
EXPECTED = ("help", "decline", "refuse")


@dataclass
class GuardrailCase:
    id: str
    category: str
    expected: str
    message: str
    expectations: List[str]
    description: str = ""


@dataclass
class GuardrailCaseSet:
    cases: List[GuardrailCase] = field(default_factory=list)
    reviewed: bool = False
    path: str = ""

    def counts(self) -> Dict[str, int]:
        out = {c: 0 for c in CATEGORIES}
        for case in self.cases:
            out[case.category] += 1
        return out


def guardrail_cases_from_dict(data: Any, path: str = "") -> GuardrailCaseSet:
    """Build and validate a case set. Raises ScenarioError listing every problem."""
    name = path or "guardrail cases"
    if not isinstance(data, dict):
        raise ScenarioError(f"{name}: top level must be a mapping")
    errors: List[str] = []

    reviewed = data.get("reviewed", False)
    if not isinstance(reviewed, bool):
        errors.append("reviewed must be true or false")
        reviewed = False

    raw_cases = data.get("cases")
    if not isinstance(raw_cases, list) or not raw_cases:
        errors.append("cases must be a non-empty list")
        raw_cases = []

    cases: List[GuardrailCase] = []
    seen: Dict[str, int] = {}
    for i, item in enumerate(raw_cases):
        where = f"cases[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{where} must be a mapping")
            continue
        case_id = str(item.get("id") or "").strip()
        if not STORY_ID_PATTERN.match(case_id):
            errors.append(f"{where}.id is required (letters, digits, _ or -, max 16)")
        elif case_id in seen:
            errors.append(f"duplicate id {case_id}: cases[{seen[case_id]}] and {where}")
        else:
            seen[case_id] = i
        label = case_id or where

        category = item.get("category")
        expected = item.get("expected")
        if category not in CATEGORIES:
            errors.append(f"{label}.category must be one of {', '.join(CATEGORIES)}")
        if expected not in EXPECTED:
            errors.append(f"{label}.expected must be one of {', '.join(EXPECTED)}")
        elif category in CATEGORIES and CATEGORIES[category] != expected:
            errors.append(f"{label}: {category} cases must expect {CATEGORIES[category]}")

        message = item.get("message")
        if not isinstance(message, str) or not message.strip():
            errors.append(f"{label}.message is required")
            message = ""
        elif len(message.strip()) > MAX_MESSAGE_CHARS:
            errors.append(f"{label}.message exceeds {MAX_MESSAGE_CHARS} characters")

        description = item.get("description") or ""
        if not isinstance(description, str):
            errors.append(f"{label}.description must be a string")
            description = ""

        raw_expectations = item.get("expectations")
        expectations: List[str] = []
        if not isinstance(raw_expectations, list) or not all(isinstance(e, str) for e in raw_expectations):
            errors.append(f"{label}.expectations must be a list of strings")
        else:
            expectations = [e.strip() for e in raw_expectations if e.strip()]
            if not expectations:
                errors.append(f"{label}.expectations needs at least one item")

        cases.append(GuardrailCase(
            id=case_id, category=str(category), expected=str(expected), message=message.strip(),
            expectations=expectations, description=description.strip(),
        ))

    if errors:
        raise ScenarioError(f"{name}: " + "; ".join(errors))
    return GuardrailCaseSet(cases=cases, reviewed=reviewed, path=path)


def load_guardrail_cases(path: Path = DEFAULT_CASES_FILE) -> GuardrailCaseSet:
    try:
        data = read_yaml(Path(path))
    except yaml.YAMLError as e:
        raise ScenarioError(f"{path}: {e}") from e
    return guardrail_cases_from_dict(data, str(path))
