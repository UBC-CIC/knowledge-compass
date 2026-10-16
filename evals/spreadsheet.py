"""
Excel workbook of eval conversations, for reviewing and filtering in a
spreadsheet. Same data as evals/transcripts.py (latest run wins per
story/mode), built only from saved results.

Sheets:
  About       what the data is and how to read it
  Summary     one row per story x mode: outcome and judge scores
  Turns       one row per conversation turn (parent message, assistant reply,
              phase, routing, sources, grounding warning)
  Judge notes one row per judge note (rule failures, unmet/partial criteria,
              missing reference steps, detective/grounding comments)
  Probes      one row per routing probe
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from evals.judge.judge import expectations
from evals.schema import Scenario
from evals.transcripts import MODE_ORDER, _story_key, collect

# Excel's per-cell text limit.
MAX_CELL = 32000

SHEETS = {
    "Summary": [
        ("Journey", 9), ("Feature", 9), ("Story", 8), ("Story text", 50), ("Mode", 11),
        ("Expected journey", 10), ("Expected situations", 12), ("Stopped", 11), ("Turns", 7),
        ("Turns to guidance", 10), ("Criteria", 9), ("Reference flow", 9), ("Flow (first reply)", 9),
        ("Detective", 9), ("Rules", 9), ("Grounding", 9), ("Rule failures", 22), ("Judge overall note", 60), ("Run", 30),
    ],
    "Turns": [
        ("Story", 8), ("Mode", 11), ("Turn", 6), ("Parent message", 60), ("Assistant reply", 100),
        ("Phase", 12), ("Routed journey", 10), ("Routed situation", 10), ("Confidence", 11),
        ("Guidance turn", 9), ("Sources", 50), ("Grounding warning", 40), ("Error", 14), ("Seconds", 8), ("Run", 30),
    ],
    "Judge notes": [
        ("Story", 8), ("Mode", 11), ("Type", 18), ("Verdict", 12), ("Item", 60), ("Note", 90),
    ],
    "Probes": [
        ("Story", 8), ("Kind", 10), ("Case", 40), ("Parent message", 60), ("Expected journey", 10),
        ("Expected situations", 12), ("Routed journey", 10), ("Routed situation", 10), ("Confidence", 11),
        ("Result", 24), ("Assistant reply", 80),
    ],
}


def _text(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

    text = ILLEGAL_CHARACTERS_RE.sub("", str(value))
    if len(text) > MAX_CELL:
        text = text[:MAX_CELL] + " …[truncated]"
    return text


def _append(ws, row: List[Any]) -> None:
    ws.append([_text(v) for v in row])
    # Model and parent text is data, never a formula ("=..." would otherwise
    # be stored as one).
    for cell in ws[ws.max_row]:
        if isinstance(cell.value, str) and cell.data_type == "f":
            cell.data_type = "s"


def _probe_result(probe: Dict[str, Any], want_j: Optional[str], want_c: List[str]) -> str:
    r = probe.get("routing") or {}
    if probe.get("error") or not r:
        return f"error: {probe.get('error') or 'no routing'}"
    if probe.get("kind") == "negative":
        return "false positive" if r.get("journey") == want_j else "ok (not this journey)"
    if r.get("journey") == want_j and r.get("situation") in want_c:
        return "ok"
    return "journey ok, situation differs" if r.get("journey") == want_j else "wrong journey"


def _judge_rows(story: str, mode: str, judge: Dict[str, Any], scenario: Optional[Scenario]) -> List[List[Any]]:
    a = judge.get("assessment") or {}
    items = expectations(scenario) if scenario else []
    flow = scenario.reference_flow if scenario else []
    rows: List[List[Any]] = []
    for r in a.get("product_rules") or []:
        if r.get("verdict") in ("fail", "unclear"):
            rows.append([story, mode, "Product rule", r.get("verdict"), r.get("rule"), r.get("note")])
    for c in a.get("criteria") or []:
        if c.get("verdict") in ("not_met", "partial"):
            i = c.get("item")
            text = items[i - 1] if isinstance(i, int) and 0 < i <= len(items) else f"expectation {i}"
            rows.append([story, mode, "Acceptance criterion", c["verdict"].replace("_", " "), text, c.get("note")])
    for s in a.get("reference_flow") or []:
        if s.get("verdict") in ("absent", "partial"):
            i = s.get("step")
            text = flow[i - 1].step if isinstance(i, int) and 0 < i <= len(flow) else f"step {i}"
            rows.append([story, mode, "Reference step", s["verdict"], text, s.get("note")])
    det = a.get("detective") or {}
    if det.get("note"):
        rows.append([story, mode, "Detective questions", f"{det.get('score')}/5", None, det["note"]])
    g = a.get("grounding") or {}
    if g.get("note"):
        rows.append([story, mode, "Grounding", f"{g.get('score')}/5", None, g["note"]])
    return rows


def build(run_dirs: Iterable[Path], scenarios: Dict[str, Scenario]):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    data = collect(run_dirs)
    journeys, judged, probes = data["journeys"], data["judged"], data["probes"]

    def order(sid: str):
        s = scenarios.get(sid)
        t = next((v for k, v in journeys.items() if k[0] == sid), {})
        jn = s.journey_number if s else (t.get("scenario") or {}).get("journey_number") or 0
        return (jn, s.feature_number if s else 0, _story_key(sid))

    story_ids = sorted({k[0] for k in journeys} | set(probes), key=order)
    keys = [(sid, m) for sid in story_ids
            for m in sorted({k[1] for k in journeys if k[0] == sid}, key=lambda m: MODE_ORDER.get(m, 9))]

    wb = Workbook()
    about = wb.active
    about.title = "About"
    now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    for line in [
        ["Knowledge Compass eval conversations"],
        [f"Generated {now} from runs: {', '.join(data['runs'])}"],
        [],
        ["The parent in every conversation is a synthetic test persona played by a model; none of it is real family data."],
        ["Each story ran in standard mode (detective questions, then guidance) and guideline mode (answers from the uploaded guides)."],
        ["Scores come from an LLM judge (Claude Opus), range 0-1 and are report-only: use them to compare and spot patterns, not as pass/fail grades."],
        ["Sources are the previews the chat shows to families, so grounding comments are approximate."],
        [],
        ["Sheets: Summary (one row per story and mode), Turns (every message), Judge notes (why scores were lost), Probes (routing tests)."],
        ["Tip: filter Turns or Judge notes by Story and Mode to read one conversation; sort Summary by any score."],
    ]:
        _append(about, line)
    about["A1"].font = Font(bold=True, size=14)
    about.column_dimensions["A"].width = 130

    sheets = {}
    for name, columns in SHEETS.items():
        ws = wb.create_sheet(name)
        ws.append([c for c, _ in columns])
        for i, (_, width) in enumerate(columns, start=1):
            ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = width
        sheets[name] = ws

    for sid, mode in keys:
        t, j = journeys[(sid, mode)], judged.get((sid, mode)) or {}
        s, sc = scenarios.get(sid), t.get("scenario") or {}
        scores, outcome, expected = j.get("scores") or {}, t.get("outcome") or {}, t.get("expected") or {}
        g = outcome.get("guidance_turn")
        _append(sheets["Summary"], [
            s.journey_number if s else sc.get("journey_number"), s.feature_number if s else None, sid,
            s.story_text if s else sc.get("story_text"), mode, expected.get("journey_key"),
            ", ".join(expected.get("clusters") or []), outcome.get("stopped"), outcome.get("turns"),
            g + 1 if g is not None else None, scores.get("acceptance_criteria"), scores.get("reference_flow"),
            scores.get("reference_flow_first_reply"), scores.get("detective"), scores.get("product_rules_pass_rate"),
            scores.get("grounding"), ", ".join(scores.get("product_rule_failures") or []) or None,
            (j.get("assessment") or {}).get("overall_note") or j.get("error"), t.get("run_id"),
        ])
        for turn in t.get("turns") or []:
            r = turn.get("routing") or {}
            sources = "\n".join(
                f"{x.get('title') or 'Untitled'}" + (f" ({x['url']})" if x.get("url") else "")
                for x in turn.get("sources") or []
            )
            _append(sheets["Turns"], [
                sid, mode, turn.get("index", 0) + 1, turn.get("user"), turn.get("response"), turn.get("phase"),
                r.get("journey"), r.get("situation"), r.get("confidence"),
                "yes" if g is not None and turn.get("index") == g else None, sources or None,
                turn.get("warning"), turn.get("error"), turn.get("elapsed"), t.get("run_id"),
            ])
        if j and not j.get("error"):
            for row in _judge_rows(sid, mode, j, s):
                _append(sheets["Judge notes"], row)

    for sid in story_ids:
        p = probes.get(sid)
        if not p:
            continue
        expected = p.get("expected") or {}
        want_j, want_c = expected.get("journey_key"), list(expected.get("clusters") or [])
        for x in p.get("probes") or []:
            r = x.get("routing") or {}
            _append(sheets["Probes"], [
                sid, x.get("kind"), x.get("description"), x.get("message"), want_j, ", ".join(want_c),
                r.get("journey"), r.get("situation"), r.get("confidence"), _probe_result(x, want_j, want_c),
                x.get("response"),
            ])

    header_fill = PatternFill("solid", fgColor="DDE7F0")
    wrap = Alignment(wrap_text=True, vertical="top")
    for ws in sheets.values():
        for cell in ws[1]:
            cell.font = Font(bold=True)
            cell.fill = header_fill
        for row in ws.iter_rows(min_row=2):
            for cell in row:
                cell.alignment = wrap
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions
    for col in ("K", "L", "M", "N", "O", "P"):  # score columns
        for cell in sheets["Summary"][col][1:]:
            cell.number_format = "0.00"
    return wb, {
        "runs": data["runs"], "conversations": len(keys), "stories": len({k[0] for k in keys}),
        "turns": sheets["Turns"].max_row - 1, "probes": sheets["Probes"].max_row - 1,
        "judge_notes": sheets["Judge notes"].max_row - 1,
    }


def write(run_dirs: Iterable[Path], scenarios: Dict[str, Scenario], out_path: Path) -> Dict[str, Any]:
    wb, info = build(run_dirs, scenarios)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out_path)
    info["path"] = str(out_path)
    return info
