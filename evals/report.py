"""Build report.json and report.md for a run directory (evals/results/<run_id>/)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from evals.judge import routing_metrics

SCORE_KEYS = [
    "reference_flow",
    "reference_flow_first_reply",
    "acceptance_criteria",
    "detective",
    "product_rules_pass_rate",
    "grounding",
]


def _load_dir(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    out = []
    for f in sorted(path.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            continue
    return out


def load_run(run_dir: Path) -> Dict[str, Any]:
    run_dir = Path(run_dir)
    manifest = json.loads((run_dir / "run.json").read_text(encoding="utf-8")) if (run_dir / "run.json").exists() else {}
    return {
        "manifest": manifest,
        "probes": _load_dir(run_dir / "probes"),
        "journeys": _load_dir(run_dir / "journeys"),
        "judge": _load_dir(run_dir / "judge"),
        "bedrock": _load_dir(run_dir / "bedrock"),
    }


def _mean(values: List[float]) -> Optional[float]:
    vals = [v for v in values if isinstance(v, (int, float))]
    return round(sum(vals) / len(vals), 3) if vals else None


def judge_summary(judged: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_mode: Dict[str, List[Dict[str, Any]]] = {}
    for j in judged:
        if j.get("scores"):
            by_mode.setdefault(j.get("mode") or "standard", []).append(j)
    summary = {}
    for mode, items in sorted(by_mode.items()):
        summary[mode] = {
            "stories": len(items),
            "reached_guidance": sum(1 for i in items if i.get("reached_guidance")),
            "mean_turns_to_guidance": _mean([i.get("turns_to_guidance") for i in items]),
            **{k: _mean([i["scores"].get(k) for i in items]) for k in SCORE_KEYS},
        }
    return summary


def mode_deltas(judged: List[Dict[str, Any]]) -> Dict[str, Any]:
    """guideline minus standard, per story and on average, for stories judged in both modes."""
    by_story: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for j in judged:
        if j.get("scores"):
            by_story.setdefault(j["story_id"], {})[j.get("mode") or "standard"] = j["scores"]
    per_story = {}
    for story, modes in sorted(by_story.items()):
        if "standard" in modes and "guideline" in modes:
            per_story[story] = {
                k: (round(modes["guideline"][k] - modes["standard"][k], 3)
                    if isinstance(modes["guideline"].get(k), (int, float)) and isinstance(modes["standard"].get(k), (int, float))
                    else None)
                for k in SCORE_KEYS
            }
    overall = {k: _mean([d[k] for d in per_story.values()]) for k in SCORE_KEYS} if per_story else {}
    return {"stories": len(per_story), "mean_delta": overall, "per_story": per_story}


def build(run_dir: Path) -> Dict[str, Any]:
    data = load_run(run_dir)
    manifest = data["manifest"]
    report = {
        "run_id": manifest.get("run_id") or Path(run_dir).name,
        "manifest": {k: manifest.get(k) for k in (
            "started_at", "finished_at", "stories", "modes", "users_created", "sessions_created",
            "sessions_deleted", "cleanup_failed", "errors", "global_prompt_mode_before",
            "global_prompt_mode_after", "simulator_model", "judge_model",
        )},
        "routing": routing_metrics.compute(data["probes"], data["journeys"]),
        "journeys": [
            {"story_id": j.get("story_id"), "mode": j.get("mode"), **(j.get("outcome") or {})}
            for j in data["journeys"]
        ],
        "judge": judge_summary(data["judge"]),
        "judge_per_story": [
            {"story_id": j.get("story_id"), "mode": j.get("mode"), "error": j.get("error"),
             "turns_to_guidance": j.get("turns_to_guidance"), **(j.get("scores") or {})}
            for j in data["judge"]
        ],
        "mode_comparison": mode_deltas(data["judge"]),
        "bedrock": data["bedrock"],
        "notes": [
            "Scores are report-only (no pass/fail thresholds).",
            "LLM judge scores vary between runs; compare trends across runs, not single numbers.",
            "Faithfulness/grounding use the public source previews returned to the chat, so they are approximate.",
        ],
    }
    return report


def _fmt(v: Any) -> str:
    if v is None:
        return "–"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def to_markdown(report: Dict[str, Any]) -> str:
    m = report["manifest"]
    r = report["routing"]
    lines = [f"# Eval report: {report['run_id']}", ""]
    lines.append(f"Stories: {len(m.get('stories') or [])}. Modes: {m.get('modes')}. "
                 f"Users created: {_fmt(m.get('users_created'))}. Sessions created/deleted: "
                 f"{_fmt(m.get('sessions_created'))}/{_fmt(m.get('sessions_deleted'))}.")
    if m.get("global_prompt_mode_before") or m.get("global_prompt_mode_after"):
        lines.append(f"Global prompt mode before/after: {m.get('global_prompt_mode_before')}/{m.get('global_prompt_mode_after')}.")
    if m.get("cleanup_failed"):
        lines.append(f"Sessions NOT deleted: {len(m['cleanup_failed'])} (see report.json; they are tagged with this run id).")
    if m.get("errors"):
        lines.append(f"Errors: {len(m['errors'])} (see report.json).")
    lines += ["", "## Routing", ""]
    lines.append("| Measure | Count | Journey accuracy | Situation accuracy |")
    lines.append("|---|---|---|---|")
    for label, key in (("Probes (opening + variants)", "probes"), ("Journeys, first turn", "journeys_first_turn"),
                       ("Journeys, final turn", "journeys_final_turn")):
        s = r[key]
        lines.append(f"| {label} | {s['count']} | {_fmt(s['journey_accuracy'])} | {_fmt(s['situation_accuracy'])} |")
    neg = r["negatives"]
    lines.append("")
    lines.append(f"Negative cases: {neg['count']}, false positives: {neg['false_positives']} "
                 f"(rate {_fmt(neg['false_positive_rate'])}).")
    if r.get("journey_confusion"):
        lines += ["", "Journey confusion (expected → routed: count):", ""]
        for expected, routed in r["journey_confusion"].items():
            lines.append(f"- {expected} → " + ", ".join(f"{k}: {v}" for k, v in sorted(routed.items())))
    if report["judge"]:
        lines += ["", "## Judge scores (0-1, report-only)", ""]
        lines.append("| Mode | Stories | Reached guidance | Turns to guidance | Flow | Flow (first reply) | Criteria | Detective | Rules | Grounding |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|")
        for mode, s in report["judge"].items():
            lines.append(
                f"| {mode} | {s['stories']} | {s['reached_guidance']} | {_fmt(s['mean_turns_to_guidance'])} | "
                f"{_fmt(s['reference_flow'])} | {_fmt(s['reference_flow_first_reply'])} | {_fmt(s['acceptance_criteria'])} | "
                f"{_fmt(s['detective'])} | {_fmt(s['product_rules_pass_rate'])} | {_fmt(s['grounding'])} |"
            )
        lines += ["", "| Story | Mode | Turns to guidance | Flow | Criteria | Detective | Rules | Grounding | Rule failures |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for s in sorted(report["judge_per_story"], key=lambda x: (x["story_id"], x["mode"] or "")):
            if s.get("error"):
                lines.append(f"| {s['story_id']} | {s['mode']} | error: {s['error']} | | | | | | |")
                continue
            lines.append(
                f"| {s['story_id']} | {s['mode']} | {_fmt(s.get('turns_to_guidance'))} | {_fmt(s.get('reference_flow'))} | "
                f"{_fmt(s.get('acceptance_criteria'))} | {_fmt(s.get('detective'))} | {_fmt(s.get('product_rules_pass_rate'))} | "
                f"{_fmt(s.get('grounding'))} | {', '.join(s.get('product_rule_failures') or []) or '–'} |"
            )
    mc = report["mode_comparison"]
    if mc["stories"]:
        lines += ["", "## Guideline minus standard", ""]
        lines.append(f"Stories in both modes: {mc['stories']}. Mean deltas: " + ", ".join(
            f"{k} {_fmt(v)}" for k, v in mc["mean_delta"].items()))
    if report["bedrock"]:
        lines += ["", "## Bedrock Evaluations", ""]
        for job in report["bedrock"]:
            lines.append(f"- {job.get('mode')}: {job.get('status')} ({job.get('job_name')})")
            for name, s in (job.get("metrics") or {}).items():
                lines.append(f"  - {name}: {_fmt(s.get('mean'))} (n={s.get('count')})")
    lines += ["", "## Notes", ""] + [f"- {n}" for n in report["notes"]]
    return "\n".join(lines) + "\n"


def _turn_meta(turn: Dict[str, Any]) -> str:
    """One italic line of routing/phase metadata for a transcript turn."""
    routing = turn.get("routing") or {}
    parts = [f"phase {turn.get('phase') or '–'}"]
    if routing:
        parts.append(f"routed {routing.get('journey') or '–'}/{routing.get('situation') or '–'}")
        if routing.get("confidence"):
            parts.append(f"confidence {routing['confidence']}")
        if routing.get("mode"):
            parts.append(f"mode {routing['mode']}")
        if routing.get("urgent"):
            parts.append("urgent")
    if isinstance(turn.get("elapsed"), (int, float)):
        parts.append(f"{turn['elapsed']:.1f}s")
    return "_" + " · ".join(parts) + "_"


def _assistant_block(turn: Dict[str, Any]) -> List[str]:
    lines: List[str] = []
    if turn.get("error"):
        lines.append(f"> Error: {turn.get('error')} {turn.get('error_message') or ''}".rstrip())
    elif turn.get("limited"):
        lines.append("> Request was rate-limited.")
    response = (turn.get("response") or "").strip()
    if response:
        # Quote the reply so its own Markdown (lists, bold, rules) stays visually inside the turn.
        lines += [f"> {line}" if line else ">" for line in response.splitlines()]
    if turn.get("warning"):
        lines += ["", f"Grounding warning: {turn['warning']}"]
    sources = turn.get("sources") or []
    if sources:
        lines += ["", "Sources:"]
        for s in sources:
            title = s.get("title") or s.get("url") or "untitled"
            lines.append(f"- [{title}]({s['url']})" if s.get("url") else f"- {title}")
    return lines


def transcripts_markdown(run_dir: Path) -> str:
    """Readable chat transcripts for a run: every journey (with judge notes) and every probe."""
    data = load_run(run_dir)
    run_id = data["manifest"].get("run_id") or Path(run_dir).name
    judged = {(j.get("story_id"), j.get("mode") or "standard"): j for j in data["judge"]}
    lines = [f"# Chat transcripts: {run_id}", "",
             "Synthetic parent conversations from this eval run. Users are simulated; no real family data.", ""]

    journeys = sorted(data["journeys"], key=lambda j: (str(j.get("story_id")), j.get("mode") or ""))
    if journeys:
        lines += ["## Journeys", ""]
    current_story = None
    for j in journeys:
        story = j.get("story_id")
        scenario = j.get("scenario") or {}
        if story != current_story:
            current_story = story
            lines += [f"### Story {story}", ""]
            if scenario.get("story_text"):
                lines.append(f"Story: {scenario['story_text']}")
            if scenario.get("journey_name"):
                lines.append(f"Journey: {scenario.get('journey_number')}. {scenario['journey_name']}")
            expected = j.get("expected") or {}
            if expected:
                lines.append(f"Expected routing: {expected.get('journey_key')}/{', '.join(expected.get('clusters') or [])}")
            lines.append("")
        mode = j.get("mode") or "standard"
        outcome = j.get("outcome") or {}
        lines += [f"#### {story} · {mode}", "",
                  f"Outcome: stopped on {outcome.get('stopped') or '–'}, {_fmt(outcome.get('turns'))} turn(s) total"
                  + (f", guidance at turn {outcome['guidance_turn'] + 1}" if isinstance(outcome.get("guidance_turn"), int) else ""),
                  ""]
        for turn in j.get("turns") or []:
            n = (turn.get("index") or 0) + 1
            lines += [f"**Turn {n} · Parent**", "", (turn.get("user") or "").strip(), "",
                      f"**Turn {n} · Assistant**", "", _turn_meta(turn), ""]
            lines += _assistant_block(turn) + [""]
        verdict = judged.get((story, mode))
        if verdict:
            scores = verdict.get("scores") or {}
            assessment = verdict.get("assessment") or {}
            lines.append("**Judge**")
            lines.append("")
            if verdict.get("error"):
                lines.append(f"Judge error: {verdict['error']}")
            else:
                lines.append(", ".join(f"{k} {_fmt(scores.get(k))}" for k in SCORE_KEYS))
                failures = scores.get("product_rule_failures") or []
                if failures:
                    notes = {r.get("rule"): r.get("note") for r in assessment.get("product_rules") or []}
                    lines += ["", "Product rule failures:"] + [f"- {f}: {notes.get(f) or ''}".rstrip(": ") for f in failures]
                if assessment.get("overall_note"):
                    lines += ["", assessment["overall_note"]]
            lines.append("")

    probe_files = sorted(data["probes"], key=lambda p: str(p.get("story_id")))
    if any(p.get("probes") for p in probe_files):
        lines += ["## Routing probes", "", "Single opening messages sent in a fresh session to check routing.", ""]
        for pf in probe_files:
            expected = pf.get("expected") or {}
            lines += [f"### Story {pf.get('story_id')} probes", "",
                      f"Expected routing: {expected.get('journey_key')}/{', '.join(expected.get('clusters') or [])}", ""]
            for p in pf.get("probes") or []:
                lines += [f"**{p.get('kind') or 'probe'} · {p.get('mode') or 'standard'}**"
                          + (f" ({p['description']})" if p.get("description") else ""), "",
                          f"Parent: {(p.get('user') or p.get('message') or '').strip()}", "",
                          _turn_meta(p), ""]
                lines += _assistant_block(p) + [""]
    return "\n".join(lines).rstrip() + "\n"


def write(run_dir: Path) -> Dict[str, Any]:
    report = build(run_dir)
    (Path(run_dir) / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (Path(run_dir) / "report.md").write_text(to_markdown(report), encoding="utf-8")
    (Path(run_dir) / "transcripts.md").write_text(transcripts_markdown(run_dir), encoding="utf-8")
    return report
