"""
Scenario and label-map schema, loading and validation.

A scenario is one user story from the Inclusion Canada documents
(evals/scenarios/j{N}_f{M}/{story_id}.yaml). label_map.yaml maps the
documents' journey numbers and story ids onto the live journey catalog keys
used by the router (chat_sessions.metadata.routing.route.journey/situation).
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

import yaml

PROMPT_MODES = ("standard", "guideline")
STORY_ID_PATTERN = re.compile(r"^[0-9A-Za-z_-]{1,16}$")
CATALOG_KEY_PATTERN = re.compile(r"^[A-Z0-9_]{1,32}$")
# textGeneration rejects longer user messages (MAX_CHARACTERS_PER_USER_MESSAGE).
MAX_MESSAGE_CHARS = 2000
LABEL_MAP_FILE = "label_map.yaml"


class ScenarioError(ValueError):
    """A scenario or label map file failed validation."""


@dataclass
class ReferenceStep:
    step: str
    text: str = ""


@dataclass
class ProbeCase:
    """A one-message routing probe: a testing-consideration variant or negative case."""
    description: str
    message: str = ""


@dataclass
class Scenario:
    story_id: str
    journey_number: int
    journey_name: str
    opening_message: str
    acceptance_criteria: List[str]
    feature_number: int = 0
    feature: str = ""
    story_text: str = ""
    situation_summary: str = ""
    reference_flow: List[ReferenceStep] = field(default_factory=list)
    content_required: List[str] = field(default_factory=list)
    testing_checks: List[str] = field(default_factory=list)
    guiding_question: Optional[str] = None
    avoid_framing: Optional[str] = None
    variants: List[ProbeCase] = field(default_factory=list)
    negative_cases: List[ProbeCase] = field(default_factory=list)
    persona: str = ""
    hidden_facts: List[str] = field(default_factory=list)
    modes: List[str] = field(default_factory=lambda: ["standard"])
    testable: bool = True
    reviewed: bool = False
    notes: List[str] = field(default_factory=list)
    source: Dict[str, Any] = field(default_factory=dict)
    path: Optional[str] = None  # where it was loaded from; not serialized

    # Review-friendly key order for the YAML files.
    FIELD_ORDER = (
        "story_id", "reviewed", "testable", "modes", "journey_number", "journey_name", "feature_number",
        "feature", "story_text", "situation_summary", "opening_message", "persona", "hidden_facts",
        "reference_flow", "acceptance_criteria", "testing_checks", "guiding_question", "avoid_framing",
        "content_required", "variants", "negative_cases", "notes", "source",
    )

    def to_dict(self) -> Dict[str, Any]:
        data = asdict(self)
        data.pop("path", None)
        return {key: data[key] for key in self.FIELD_ORDER}


@dataclass
class LabelMap:
    journeys: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    stories: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    reviewed: bool = False

    def journey_key(self, scenario: Scenario) -> Optional[str]:
        story = self.stories.get(scenario.story_id) or {}
        if story.get("journey_key"):
            return story["journey_key"]
        return (self.journeys.get(scenario.journey_number) or {}).get("journey_key")

    def cluster_keys(self, scenario: Scenario) -> List[str]:
        story = self.stories.get(scenario.story_id) or {}
        return list(story.get("clusters") or [])

    def to_dict(self) -> Dict[str, Any]:
        return {
            "reviewed": self.reviewed,
            "journeys": {int(k): v for k, v in sorted(self.journeys.items())},
            "stories": {str(k): v for k, v in sorted(self.stories.items(), key=lambda kv: _story_sort_key(kv[0]))},
        }


def _story_sort_key(story_id: str):
    return (len(story_id), story_id)


# ------------------------------------------------------------------
# Parsing
# ------------------------------------------------------------------

def _str_list(value: Any, name: str, errors: List[str]) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        errors.append(f"{name} must be a list of strings")
        return []
    return [v.strip() for v in value if v.strip()]


def _probe_list(value: Any, name: str, errors: List[str]) -> List[ProbeCase]:
    out: List[ProbeCase] = []
    if value is None:
        return out
    if not isinstance(value, list):
        errors.append(f"{name} must be a list")
        return out
    for i, item in enumerate(value):
        if isinstance(item, str):
            out.append(ProbeCase(description=item.strip()))
        elif isinstance(item, dict) and isinstance(item.get("description", ""), str):
            message = item.get("message") or ""
            if not isinstance(message, str):
                errors.append(f"{name}[{i}].message must be a string")
                message = ""
            out.append(ProbeCase(description=(item.get("description") or "").strip(), message=message.strip()))
        else:
            errors.append(f"{name}[{i}] must be a string or {{description, message}}")
    return out


def scenario_from_dict(data: Any, path: Optional[str] = None) -> Scenario:
    """Build and validate a Scenario. Raises ScenarioError listing every problem."""
    errors: List[str] = []
    if not isinstance(data, dict):
        raise ScenarioError(f"{path or 'scenario'}: top level must be a mapping")

    story_id = str(data.get("story_id") or "").strip()
    if not STORY_ID_PATTERN.match(story_id):
        errors.append("story_id is required (letters, digits, _ or -, max 16)")

    journey_number = data.get("journey_number")
    if not isinstance(journey_number, int) or isinstance(journey_number, bool) or journey_number < 1:
        errors.append("journey_number must be a positive integer")
        journey_number = 0

    feature_number = data.get("feature_number", 0)
    if not isinstance(feature_number, int) or isinstance(feature_number, bool):
        errors.append("feature_number must be an integer")
        feature_number = 0

    def text(name: str, required: bool = False) -> str:
        value = data.get(name)
        if value is None:
            value = ""
        if not isinstance(value, str):
            errors.append(f"{name} must be a string")
            return ""
        value = value.strip()
        if required and not value:
            errors.append(f"{name} is required")
        return value

    journey_name = text("journey_name", required=True)
    opening_message = text("opening_message", required=True)
    if len(opening_message) > MAX_MESSAGE_CHARS:
        errors.append(f"opening_message exceeds {MAX_MESSAGE_CHARS} characters")

    acceptance = _str_list(data.get("acceptance_criteria"), "acceptance_criteria", errors)
    if not acceptance:
        errors.append("acceptance_criteria needs at least one item")

    flow: List[ReferenceStep] = []
    raw_flow = data.get("reference_flow") or []
    if not isinstance(raw_flow, list):
        errors.append("reference_flow must be a list")
        raw_flow = []
    for i, step in enumerate(raw_flow):
        if isinstance(step, dict) and isinstance(step.get("step"), str):
            flow.append(ReferenceStep(step=step["step"].strip(), text=str(step.get("text") or "").strip()))
        else:
            errors.append(f"reference_flow[{i}] must be {{step, text}}")

    variants = _probe_list(data.get("variants"), "variants", errors)
    negatives = _probe_list(data.get("negative_cases"), "negative_cases", errors)
    for name, cases in (("variants", variants), ("negative_cases", negatives)):
        for i, case in enumerate(cases):
            if len(case.message) > MAX_MESSAGE_CHARS:
                errors.append(f"{name}[{i}].message exceeds {MAX_MESSAGE_CHARS} characters")

    modes = data.get("modes") or ["standard"]
    if not isinstance(modes, list) or not modes or any(m not in PROMPT_MODES for m in modes):
        errors.append(f"modes must be a non-empty list of {', '.join(PROMPT_MODES)}")
        modes = ["standard"]

    for flag in ("testable", "reviewed"):
        if flag in data and not isinstance(data[flag], bool):
            errors.append(f"{flag} must be true or false")

    guiding = data.get("guiding_question")
    avoid = data.get("avoid_framing")
    for name, value in (("guiding_question", guiding), ("avoid_framing", avoid)):
        if value is not None and not isinstance(value, str):
            errors.append(f"{name} must be a string")

    source = data.get("source") or {}
    if not isinstance(source, dict):
        errors.append("source must be a mapping")
        source = {}

    content_required = _str_list(data.get("content_required"), "content_required", errors)
    testing_checks = _str_list(data.get("testing_checks"), "testing_checks", errors)
    hidden_facts = _str_list(data.get("hidden_facts"), "hidden_facts", errors)
    notes = _str_list(data.get("notes"), "notes", errors)
    feature = text("feature")
    story_text = text("story_text")
    situation_summary = text("situation_summary")
    persona = text("persona")

    if errors:
        raise ScenarioError(f"{path or story_id or 'scenario'}: " + "; ".join(errors))

    return Scenario(
        story_id=story_id,
        journey_number=journey_number,
        journey_name=journey_name,
        opening_message=opening_message,
        acceptance_criteria=acceptance,
        feature_number=feature_number,
        feature=feature,
        story_text=story_text,
        situation_summary=situation_summary,
        reference_flow=flow,
        content_required=content_required,
        testing_checks=testing_checks,
        guiding_question=(guiding or None) if isinstance(guiding, str) else None,
        avoid_framing=(avoid or None) if isinstance(avoid, str) else None,
        variants=variants,
        negative_cases=negatives,
        persona=persona,
        hidden_facts=hidden_facts,
        modes=list(dict.fromkeys(modes)),
        testable=bool(data.get("testable", True)),
        reviewed=bool(data.get("reviewed", False)),
        notes=notes,
        source=source,
        path=path,
    )


def label_map_from_dict(data: Any, path: Optional[str] = None) -> LabelMap:
    errors: List[str] = []
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ScenarioError(f"{path or LABEL_MAP_FILE}: top level must be a mapping")

    journeys: Dict[int, Dict[str, Any]] = {}
    for raw_number, entry in (data.get("journeys") or {}).items():
        try:
            number = int(raw_number)
        except (TypeError, ValueError):
            errors.append(f"journeys key {raw_number!r} must be a journey number")
            continue
        entry = entry or {}
        if not isinstance(entry, dict):
            errors.append(f"journeys.{number} must be a mapping")
            continue
        key = entry.get("journey_key")
        if key is not None and (not isinstance(key, str) or not CATALOG_KEY_PATTERN.match(key)):
            errors.append(f"journeys.{number}.journey_key {key!r} is not a catalog key")
        journeys[number] = {"name": entry.get("name") or "", "journey_key": key}

    stories: Dict[str, Dict[str, Any]] = {}
    for raw_id, entry in (data.get("stories") or {}).items():
        story_id = str(raw_id)
        entry = entry or {}
        if not isinstance(entry, dict):
            errors.append(f"stories.{story_id} must be a mapping")
            continue
        clusters = entry.get("clusters") or []
        if not isinstance(clusters, list) or any(
            not isinstance(c, str) or not CATALOG_KEY_PATTERN.match(c) for c in clusters
        ):
            errors.append(f"stories.{story_id}.clusters must be a list of catalog keys")
            clusters = []
        key = entry.get("journey_key")
        if key is not None and (not isinstance(key, str) or not CATALOG_KEY_PATTERN.match(key)):
            errors.append(f"stories.{story_id}.journey_key {key!r} is not a catalog key")
        cleaned = {"clusters": list(clusters)}
        if key:
            cleaned["journey_key"] = key
        if entry.get("suggested_by"):
            cleaned["suggested_by"] = str(entry["suggested_by"])
        stories[story_id] = cleaned

    reviewed = data.get("reviewed", False)
    if not isinstance(reviewed, bool):
        errors.append("reviewed must be true or false")
        reviewed = False

    if errors:
        raise ScenarioError(f"{path or LABEL_MAP_FILE}: " + "; ".join(errors))
    return LabelMap(journeys=journeys, stories=stories, reviewed=reviewed)


# ------------------------------------------------------------------
# Files
# ------------------------------------------------------------------

def read_yaml(path: Path) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def write_yaml(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        yaml.safe_dump(data, fh, sort_keys=False, allow_unicode=True, width=100)


def scenario_files(directory: Path) -> List[Path]:
    return sorted(
        p for p in Path(directory).rglob("*.yaml")
        if p.name != LABEL_MAP_FILE and ".venv" not in p.parts
    )


def load_scenario(path: Path) -> Scenario:
    return scenario_from_dict(read_yaml(path), str(path))


def load_label_map(directory: Path) -> LabelMap:
    path = Path(directory) / LABEL_MAP_FILE
    if not path.exists():
        return LabelMap()
    return label_map_from_dict(read_yaml(path), str(path))


def load_scenarios(directory: Path) -> List[Scenario]:
    """Load every scenario; raises ScenarioError naming each bad file."""
    scenarios, errors = [], []
    for path in scenario_files(directory):
        try:
            scenarios.append(load_scenario(path))
        except (ScenarioError, yaml.YAMLError) as e:
            errors.append(str(e))
    if errors:
        raise ScenarioError("\n".join(errors))
    seen: Dict[str, str] = {}
    for s in scenarios:
        if s.story_id in seen:
            errors.append(f"duplicate story_id {s.story_id}: {seen[s.story_id]} and {s.path}")
        seen[s.story_id] = s.path or ""
    if errors:
        raise ScenarioError("\n".join(errors))
    return scenarios


def validate_directory(directory: Path, for_scoring: bool = False) -> List[str]:
    """
    Every problem in a scenarios directory, as messages. Empty = valid.
    for_scoring additionally requires reviewed scenarios and labels.
    """
    problems: List[str] = []
    scenarios: List[Scenario] = []
    for path in scenario_files(directory):
        try:
            scenarios.append(load_scenario(path))
        except (ScenarioError, yaml.YAMLError) as e:
            problems.append(str(e))
    try:
        label_map = load_label_map(directory)
    except (ScenarioError, yaml.YAMLError) as e:
        problems.append(str(e))
        label_map = None

    ids: Dict[str, str] = {}
    for s in scenarios:
        if s.story_id in ids:
            problems.append(f"duplicate story_id {s.story_id}: {ids[s.story_id]} and {s.path}")
        ids[s.story_id] = s.path or ""

    if for_scoring:
        problems.extend(scoring_problems(scenarios, label_map))
    return problems


def scoring_problems(scenarios: Sequence[Scenario], label_map: Optional[LabelMap]) -> List[str]:
    """Why these scenarios cannot be scored yet (reviewed gate, labels)."""
    problems = []
    for s in scenarios:
        if not s.testable:
            continue
        if not s.reviewed:
            problems.append(f"{s.story_id}: not reviewed (set reviewed: true after checking the draft)")
        if label_map is not None:
            if not label_map.journey_key(s):
                problems.append(f"{s.story_id}: no journey_key in {LABEL_MAP_FILE} for journey {s.journey_number}")
            if "standard" in s.modes and not label_map.cluster_keys(s):
                problems.append(f"{s.story_id}: no expected clusters in {LABEL_MAP_FILE}")
    if label_map is not None and scenarios and not label_map.reviewed:
        problems.append(f"{LABEL_MAP_FILE}: not reviewed (set reviewed: true after checking the keys)")
    return problems


def select_scenarios(
    scenarios: Iterable[Scenario],
    stories: Optional[Sequence[str]] = None,
    journey: Optional[int] = None,
    limit: Optional[int] = None,
    for_scoring: bool = True,
) -> List[Scenario]:
    """
    Filter for a run. Scoring runs skip testable: false and reject unreviewed
    scenarios (raise ScenarioError) so drafts never count.
    """
    wanted = {s.strip() for s in stories} if stories else None
    picked = []
    for s in scenarios:
        if wanted is not None and s.story_id not in wanted:
            continue
        if journey is not None and s.journey_number != journey:
            continue
        if for_scoring and not s.testable:
            continue
        picked.append(s)
    if for_scoring:
        unreviewed = [s.story_id for s in picked if not s.reviewed]
        if unreviewed:
            raise ScenarioError(
                "unreviewed scenarios cannot be scored: " + ", ".join(unreviewed)
                + " (review the drafts and set reviewed: true)"
            )
    picked.sort(key=lambda s: (s.journey_number, s.feature_number, _story_sort_key(s.story_id)))
    if limit is not None:
        picked = picked[: max(0, limit)]
    return picked
