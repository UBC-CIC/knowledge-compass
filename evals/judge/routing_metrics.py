"""
Deterministic routing metrics from probe results and standard-mode journey
transcripts, using the expected keys recorded from label_map.yaml.

  journey accuracy     route.journey == expected journey key
  situation accuracy   route.situation in the story's expected clusters
                       (secondary_situation matches are counted separately)
  false-positive rate  negative cases routed to the story's journey
"""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Dict, Iterable, List, Optional


def _rate(hits: int, total: int) -> Optional[float]:
    return round(hits / total, 3) if total else None


def classify_routing(routing: Dict[str, Any], expected: Dict[str, Any]) -> Dict[str, Any]:
    journey = routing.get("journey")
    situation = routing.get("situation")
    secondary = routing.get("secondary_situation")
    want_journey = expected.get("journey_key")
    want_clusters = list(expected.get("clusters") or [])
    return {
        "journey": journey,
        "situation": situation,
        "confidence": routing.get("confidence"),
        "journey_ok": bool(want_journey) and journey == want_journey,
        "situation_ok": bool(want_clusters) and situation in want_clusters,
        "secondary_ok": bool(want_clusters) and situation not in want_clusters and secondary in want_clusters,
        "seen_ok": bool(want_clusters) and bool(set(routing.get("clusters_seen") or []) & set(want_clusters)),
    }


class _Tally:
    def __init__(self):
        self.n = 0
        self.journey = 0
        self.situation = 0
        self.secondary = 0
        self.scored_situation = 0

    def add(self, c: Dict[str, Any], has_clusters: bool):
        self.n += 1
        self.journey += int(c["journey_ok"])
        if has_clusters:
            self.scored_situation += 1
            self.situation += int(c["situation_ok"])
            self.secondary += int(c["secondary_ok"])

    def summary(self) -> Dict[str, Any]:
        return {
            "count": self.n,
            "journey_accuracy": _rate(self.journey, self.n),
            "situation_accuracy": _rate(self.situation, self.scored_situation),
            "secondary_match_rate": _rate(self.secondary, self.scored_situation),
        }


def compute(probe_files: Iterable[Dict[str, Any]], journey_files: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    positive = _Tally()
    by_kind: Dict[str, _Tally] = defaultdict(_Tally)
    negatives_total = negatives_fp = 0
    journey_confusion: Dict[str, Counter] = defaultdict(Counter)
    situation_confusion: Dict[str, Counter] = defaultdict(Counter)
    confidence = Counter()
    per_story: Dict[str, Dict[str, Any]] = {}
    failures: List[Dict[str, Any]] = []

    for pf in probe_files:
        expected = pf.get("expected") or {}
        has_clusters = bool(expected.get("clusters"))
        story = per_story.setdefault(pf["story_id"], {"probes": _Tally(), "negatives": [0, 0]})
        for probe in pf.get("probes") or []:
            routing = probe.get("routing") or {}
            if probe.get("error") or not routing:
                failures.append({"story_id": pf["story_id"], "kind": probe.get("kind"), "error": probe.get("error") or "no routing"})
                continue
            c = classify_routing(routing, expected)
            confidence[c["confidence"] or "none"] += 1
            want_j = expected.get("journey_key") or "?"
            if probe.get("kind") == "negative":
                negatives_total += 1
                fp = c["journey"] == expected.get("journey_key")
                negatives_fp += int(fp)
                story["negatives"][0] += 1
                story["negatives"][1] += int(fp)
                journey_confusion[f"not {want_j}"][c["journey"] or "none"] += 1
                continue
            positive.add(c, has_clusters)
            by_kind[probe.get("kind") or "probe"].add(c, has_clusters)
            story["probes"].add(c, has_clusters)
            journey_confusion[want_j][c["journey"] or "none"] += 1
            if has_clusters:
                situation_confusion["/".join(expected["clusters"])][c["situation"] or "none"] += 1

    first_turn, final_turn = _Tally(), _Tally()
    for jf in journey_files:
        if jf.get("mode") != "standard":
            continue
        expected = jf.get("expected") or {}
        has_clusters = bool(expected.get("clusters"))
        routed = [t for t in jf.get("turns") or [] if t.get("routing")]
        if not routed:
            continue
        first = classify_routing(routed[0]["routing"], expected)
        last = classify_routing(routed[-1]["routing"], expected)
        first_turn.add(first, has_clusters)
        final_turn.add(last, has_clusters)
        story = per_story.setdefault(jf["story_id"], {"probes": _Tally(), "negatives": [0, 0]})
        story["journey_first"] = first
        story["journey_final"] = last

    stories_out = {}
    for story_id, s in per_story.items():
        entry = {"probes": s["probes"].summary()}
        total, fp = s["negatives"]
        if total:
            entry["negatives"] = {"count": total, "false_positives": fp, "false_positive_rate": _rate(fp, total)}
        for key in ("journey_first", "journey_final"):
            if key in s:
                entry[key] = s[key]
        stories_out[story_id] = entry

    return {
        "probes": positive.summary(),
        "probes_by_kind": {k: v.summary() for k, v in sorted(by_kind.items())},
        "negatives": {
            "count": negatives_total,
            "false_positives": negatives_fp,
            "false_positive_rate": _rate(negatives_fp, negatives_total),
        },
        "journeys_first_turn": first_turn.summary(),
        "journeys_final_turn": final_turn.summary(),
        "journey_confusion": {k: dict(v) for k, v in sorted(journey_confusion.items())},
        "situation_confusion": {k: dict(v) for k, v in sorted(situation_confusion.items())},
        "confidence": dict(confidence),
        "per_story": dict(sorted(stories_out.items())),
        "failures": failures,
    }
