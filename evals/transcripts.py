"""
Readable, shareable transcripts of eval runs: one Markdown document with every
journey conversation (parent and assistant turns, phase, routing, cited
sources, grounding warnings), the judge's scores and notes, and the routing
probes. Built only from files already in evals/results/<run_id>/; it calls no
API and no model.

If a story/mode was run more than once, the latest run's conversation is used.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from evals.judge.judge import expectations
from evals.schema import Scenario

MODE_ORDER = {"standard": 0, "guideline": 1}


def _load(path: Path) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _story_key(story_id: str) -> Tuple[int, str]:
    return (len(story_id), story_id)


def _cell(value: Any) -> str:
    if value is None:
        return "–"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value).replace("|", "\\|").replace("\n", " ")


def _quote(text: str) -> str:
    lines = (text or "(no reply)").strip().splitlines() or [""]
    return "\n".join(f"> {line}" if line.strip() else ">" for line in lines)


def collect(run_dirs: Iterable[Path]) -> Dict[str, Any]:
    """Latest journey, judge result and probe file per story across the runs (oldest first)."""
    journeys: Dict[Tuple[str, str], Dict[str, Any]] = {}
    judged: Dict[Tuple[str, str], Dict[str, Any]] = {}
    probes: Dict[str, Dict[str, Any]] = {}
    runs: List[str] = []
    for run_dir in sorted(Path(d) for d in run_dirs):
        found = False
        for path in sorted((run_dir / "journeys").glob("*.json")):
            t = _load(path)
            if t and t.get("story_id"):
                key = (t["story_id"], t.get("mode") or "standard")
                journeys[key] = t
                judged.pop(key, None)
                j = _load(run_dir / "judge" / path.name)
                if j:
                    judged[key] = j
                found = True
        for path in sorted((run_dir / "probes").glob("*.json")):
            p = _load(path)
            if p and p.get("story_id"):
                probes[p["story_id"]] = p
                found = True
        if found:
            runs.append(run_dir.name)
    return {"runs": runs, "journeys": journeys, "judged": judged, "probes": probes}


def _routing_label(routing: Dict[str, Any]) -> str:
    if not routing:
        return ""
    parts = [routing.get("journey") or "?", routing.get("situation") or "?"]
    label = "/".join(parts)
    if routing.get("confidence"):
        label += f", {routing['confidence']}"
    return f" · routed {label}"


def _note(item: Dict[str, Any]) -> str:
    note = (item.get("note") or "").strip()
    return f": {note}" if note else ""


def _judge_notes(judge: Dict[str, Any], scenario: Optional[Scenario]) -> List[str]:
    a = judge.get("assessment") or {}
    items = expectations(scenario) if scenario else []
    flow = scenario.reference_flow if scenario else []
    out: List[str] = []
    for r in a.get("product_rules") or []:
        if r.get("verdict") in ("fail", "unclear"):
            out.append(f"- **Rule {r.get('verdict')}: {r.get('rule')}**" + _note(r))
    for c in a.get("criteria") or []:
        if c.get("verdict") in ("not_met", "partial"):
            i = c.get("item")
            text = items[i - 1] if isinstance(i, int) and 0 < i <= len(items) else f"expectation {i}"
            out.append(f"- Criterion {c['verdict'].replace('_', ' ')}: *{text}*" + _note(c))
    for s in a.get("reference_flow") or []:
        if s.get("verdict") in ("absent", "partial"):
            i = s.get("step")
            text = flow[i - 1].step if isinstance(i, int) and 0 < i <= len(flow) else f"step {i}"
            out.append(f"- Reference step {s['verdict']}: *{text}*" + _note(s))
    det = a.get("detective") or {}
    if det.get("note"):
        out.append(f"- Detective questions ({det.get('score')}/5): {det['note']}")
    g = a.get("grounding") or {}
    if g.get("note"):
        out.append(f"- Grounding ({g.get('score')}/5): {g['note']}")
    if a.get("overall_note"):
        out.append(f"- Overall: {a['overall_note']}")
    return out


def _scores_line(judge: Optional[Dict[str, Any]]) -> str:
    if not judge:
        return "Not judged."
    if judge.get("error"):
        return f"Judge error: {judge['error']}"
    s = judge.get("scores") or {}
    return (
        f"Criteria {_cell(s.get('acceptance_criteria'))} · Reference flow {_cell(s.get('reference_flow'))} · "
        f"Detective {_cell(s.get('detective'))} · Rules {_cell(s.get('product_rules_pass_rate'))} · "
        f"Grounding {_cell(s.get('grounding'))}"
        + (f" · **Rule failures: {', '.join(s['product_rule_failures'])}**" if s.get("product_rule_failures") else "")
    )


def render_journey(t: Dict[str, Any], judge: Optional[Dict[str, Any]], scenario: Optional[Scenario]) -> List[str]:
    mode = t.get("mode") or "standard"
    outcome = t.get("outcome") or {}
    turns_to = (outcome["guidance_turn"] + 1) if outcome.get("guidance_turn") is not None else None
    lines = [f"#### {mode.capitalize()} mode", ""]
    lines.append(
        f"Stopped: {outcome.get('stopped', '?')}"
        + (f" · guidance on turn {turns_to}" if turns_to else " · never reached guidance")
        + f" · run `{t.get('run_id')}`"
    )
    lines += ["", f"Scores (0-1, report-only): {_scores_line(judge)}", ""]
    for turn in t.get("turns") or []:
        n = turn.get("index", 0) + 1
        lines.append(f"**Turn {n}, Parent:** {turn.get('user', '')}")
        lines.append("")
        label = turn.get("phase") or "reply"
        if turn.get("error"):
            label += f" · error: {turn['error']}"
        lines.append(f"**Turn {n}, Assistant** ({label}{_routing_label(turn.get('routing') or {})}):")
        lines.append("")
        lines.append(_quote(turn.get("response") or ""))
        lines.append("")
        sources = turn.get("sources") or []
        if sources:
            refs = []
            for s in sources:
                title = s.get("title") or "Untitled"
                refs.append(f"[{title}]({s['url']})" if s.get("url") else title)
            lines.append(f"Sources: {'; '.join(refs)}")
            lines.append("")
        if turn.get("warning"):
            lines.append(f"Grounding warning shown: *{turn['warning']}*")
            lines.append("")
    if judge and not judge.get("error"):
        notes = _judge_notes(judge, scenario)
        if notes:
            lines += ["Judge notes:", ""] + notes + [""]
    return lines


def render_probes(p: Dict[str, Any]) -> List[str]:
    expected = p.get("expected") or {}
    want_j, want_c = expected.get("journey_key"), list(expected.get("clusters") or [])
    rows = []
    for x in p.get("probes") or []:
        r = x.get("routing") or {}
        if x.get("error") or not r:
            verdict = f"error: {x.get('error') or 'no routing'}"
        elif x.get("kind") == "negative":
            verdict = "false positive" if r.get("journey") == want_j else "ok (not this journey)"
        else:
            verdict = "ok" if r.get("journey") == want_j and r.get("situation") in want_c else (
                "journey ok, situation differs" if r.get("journey") == want_j else "wrong journey")
        rows.append(
            f"| {_cell(x.get('kind'))} | {_cell(x.get('description'))} | {_cell(x.get('message'))} | "
            f"{_cell(r.get('journey'))}/{_cell(r.get('situation'))} ({_cell(r.get('confidence'))}) | {verdict} |"
        )
    if not rows:
        return []
    return [
        f"#### Routing probes (expected {want_j or '?'} / {', '.join(want_c) or '?'})", "",
        "| Kind | Case | Parent message | Routed | Result |", "|---|---|---|---|---|", *rows, "",
    ]


def render(data: Dict[str, Any], scenarios: Dict[str, Scenario], title: str = "Knowledge Compass eval conversations") -> str:
    journeys, judged, probes = data["journeys"], data["judged"], data["probes"]
    story_ids = sorted({k[0] for k in journeys} | set(probes), key=_story_key)

    def info(sid: str) -> Dict[str, Any]:
        s = scenarios.get(sid)
        if s:
            return {"journey_number": s.journey_number, "journey_name": s.journey_name,
                    "feature_number": s.feature_number, "feature": s.feature, "story_text": s.story_text}
        t = next((v for k, v in journeys.items() if k[0] == sid), {})
        sc = t.get("scenario") or {}
        return {"journey_number": sc.get("journey_number") or 0, "journey_name": sc.get("journey_name") or "",
                "feature_number": 0, "feature": sc.get("feature") or "", "story_text": sc.get("story_text") or ""}

    story_ids.sort(key=lambda sid: (info(sid)["journey_number"], info(sid)["feature_number"], _story_key(sid)))
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out = [f"# {title}", ""]
    out.append(f"Generated {now} from runs: {', '.join(f'`{r}`' for r in data['runs'])}.")
    out += [
        "",
        "- The parent in every conversation is a **synthetic test persona** played by a model; none of it is real family data.",
        "- Each story ran once in **standard** mode (detective questions, then guidance) and/or once in **guideline** "
        "mode (answers from the uploaded guides).",
        "- Scores come from an LLM judge (Claude Opus), are 0-1 and **report-only**: use them to spot patterns and "
        "compare runs, not as pass/fail grades.",
        "- Sources listed are the previews the chat shows to families, so grounding notes are approximate.",
        "",
        "## Summary",
        "",
        "| Story | Mode | Turns to guidance | Criteria | Flow | Detective | Rules | Grounding | Rule failures |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for sid in story_ids:
        for mode in sorted({k[1] for k in journeys if k[0] == sid}, key=lambda m: MODE_ORDER.get(m, 9)):
            t, j = journeys[(sid, mode)], judged.get((sid, mode)) or {}
            s = j.get("scores") or {}
            g = (t.get("outcome") or {}).get("guidance_turn")
            out.append(
                f"| [{sid}](#story-{sid.lower()}) | {mode} | {_cell(g + 1 if g is not None else None)} | "
                f"{_cell(s.get('acceptance_criteria'))} | {_cell(s.get('reference_flow'))} | {_cell(s.get('detective'))} | "
                f"{_cell(s.get('product_rules_pass_rate'))} | {_cell(s.get('grounding'))} | "
                f"{_cell(', '.join(s.get('product_rule_failures') or []) or None)} |"
            )
    out.append("")

    current_journey = None
    for sid in story_ids:
        meta = info(sid)
        if meta["journey_number"] != current_journey:
            current_journey = meta["journey_number"]
            out += [f"## Journey {current_journey}: {meta['journey_name']}", ""]
        out += [f"### Story {sid}", "", f'<a id="story-{sid.lower()}"></a>', ""]
        if meta["feature"]:
            out.append(f"Feature {meta['feature_number'] or ''}: {meta['feature']}".replace("Feature : ", "Feature: "))
            out.append("")
        if meta["story_text"]:
            out += [f"*{meta['story_text']}*", ""]
        expected = next((v.get("expected") for k, v in journeys.items() if k[0] == sid), None) \
            or (probes.get(sid) or {}).get("expected") or {}
        if expected:
            out += [f"Expected routing: {expected.get('journey_key') or '?'} / {', '.join(expected.get('clusters') or []) or '?'}", ""]
        for mode in sorted({k[1] for k in journeys if k[0] == sid}, key=lambda m: MODE_ORDER.get(m, 9)):
            out += render_journey(journeys[(sid, mode)], judged.get((sid, mode)), scenarios.get(sid))
        if sid in probes:
            out += render_probes(probes[sid])
    return "\n".join(out).rstrip() + "\n"


def write(run_dirs: Iterable[Path], scenarios: Dict[str, Scenario], out_path: Path) -> Dict[str, Any]:
    data = collect(run_dirs)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(render(data, scenarios), encoding="utf-8")
    return {"runs": data["runs"], "conversations": len(data["journeys"]), "stories": len({k[0] for k in data["journeys"]}),
            "probe_files": len(data["probes"]), "path": str(out_path)}
