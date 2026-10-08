"""
Pure scoring helpers for retrieval evaluation (no AWS, no database).

Used by tests/eval/run_eval.py (offline golden-set comparison) and, mirrored
byte-for-byte into cdk/lambda/knowledgeBase/helpers/, by the space validation
task. Edit the textGeneration copy, then copy it over the mirror; the parity
test fails if they drift.

A golden entry is a dict with `question`, optional `kind` ("near_miss" or
"off_topic"; absent means a positive entry that should find an answer), and
either `expected` (URL fragments or exact titles) or `expected_topics`
(phrases that a relevant chunk should mention). Relevance by topics: a
retrieved source is relevant when its text mentions at least
`min_topic_hits` distinct topics (clamped to the number of topics the entry
has).

Only ids, ranks and aggregate numbers leave this module; it never returns or
logs chunk text.
"""

import math
from typing import Any, Dict, Iterable, List, Optional, Sequence

DEFAULT_MIN_TOPIC_HITS = 2
KIND_POSITIVE = "positive"
REPORT_ONLY_KINDS = ("near_miss", "off_topic")


def kind_of(item: Dict[str, Any]) -> str:
    """`positive` unless the entry is marked near_miss or off_topic."""
    kind = item.get("kind")
    return kind if kind in REPORT_ONLY_KINDS else KIND_POSITIVE


def matches(source: Dict[str, Any], expected: Sequence[str]) -> bool:
    """
    A source matches an `expected` entry when the entry is a case-insensitive
    substring of the source URL, equals its title, or (guideline sections)
    appears in its section key / heading path.
    """
    url = (source.get("url") or source.get("uri") or "").lower()
    title = (source.get("title") or "").strip().lower()
    metadata = source.get("metadata") or {}
    heading = f"{metadata.get('section_key') or ''} {metadata.get('heading_path') or ''}".lower()
    for entry in expected:
        needle = entry.strip().lower()
        if needle and (needle in url or needle == title or (heading.strip() and needle in heading)):
            return True
    return False


def topic_hits(text: str, topics: Iterable[str]) -> int:
    """Number of distinct topics that appear in `text` (case-insensitive substring)."""
    haystack = (text or "").lower()
    seen = set()
    for topic in topics or ():
        needle = (topic or "").strip().lower()
        if needle and needle in haystack:
            seen.add(needle)
    return len(seen)


def _source_text(source: Dict[str, Any]) -> str:
    # Retrieved results carry the chunk body as `content`; the offline candidate
    # index carries `embed_text`. Titles help short chunks.
    body = source.get("content") or source.get("embed_text") or ""
    return f"{body} {source.get('title') or ''}"


def is_relevant(
    source: Dict[str, Any],
    item: Dict[str, Any],
    min_topic_hits: int = DEFAULT_MIN_TOPIC_HITS,
    expected: Optional[Sequence[str]] = None,
) -> bool:
    """
    URL/title/heading match when the entry names `expected` sources (pass
    `expected` to override the entry's own list, e.g. guideline targets);
    otherwise topic coverage of the source text.
    """
    targets = item.get("expected") if expected is None else expected
    if targets:
        return matches(source, targets)
    topics = [t for t in (item.get("expected_topics") or []) if isinstance(t, str) and t.strip()]
    if not topics:
        return False
    needed = max(1, min(int(min_topic_hits), len(topics)))
    return topic_hits(_source_text(source), topics) >= needed


def first_relevant_rank(
    results: Sequence[Dict[str, Any]],
    item: Dict[str, Any],
    n: Optional[int] = None,
    min_topic_hits: int = DEFAULT_MIN_TOPIC_HITS,
    expected: Optional[Sequence[str]] = None,
) -> Optional[int]:
    """1-based rank of the first relevant result within the top `n`, else None."""
    limit = len(results) if n is None else min(n, len(results))
    for rank, source in enumerate(results[:limit], start=1):
        if is_relevant(source, item, min_topic_hits, expected):
            return rank
    return None


def recall_at_k(ranks: Sequence[Optional[int]], k: int) -> float:
    """Fraction of questions whose first relevant result is within the top k."""
    if not ranks:
        return 0.0
    return sum(1 for r in ranks if r and r <= k) / len(ranks)


def mrr(ranks: Sequence[Optional[int]]) -> float:
    """Mean reciprocal rank; a miss contributes 0."""
    if not ranks:
        return 0.0
    return sum(1.0 / r for r in ranks if r) / len(ranks)


def percentile(values: Sequence[float], p: float) -> float:
    """Linear-interpolated percentile (p in 0..100); 0.0 for an empty list."""
    ordered = sorted(values)
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return float(ordered[0])
    position = (max(0.0, min(100.0, p)) / 100.0) * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(ordered[lower])
    return float(ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower))


def summarize(per_question: Sequence[Dict[str, Any]], k_values: Sequence[int]) -> Dict[str, Any]:
    """
    Recall@k and MRR over POSITIVE entries only. `near_miss` and `off_topic`
    entries never count toward pass/fail metrics (see score_distribution).
    Each per_question item needs `rank` and may carry `kind`.
    """
    positives = [q for q in per_question if q.get("kind", KIND_POSITIVE) == KIND_POSITIVE]
    ranks = [q.get("rank") for q in positives]
    summary: Dict[str, Any] = {
        "questions": len(positives),
        "report_only_questions": len(per_question) - len(positives),
        "mrr": round(mrr(ranks), 4),
    }
    for k in k_values:
        summary[f"recall@{k}"] = round(recall_at_k(ranks, k), 4)
    return summary


def _stats(values: Sequence[float]) -> Dict[str, Any]:
    if not values:
        return {"count": 0, "min": None, "median": None, "p90": None, "max": None}
    return {
        "count": len(values),
        "min": round(min(values), 4),
        "median": round(percentile(values, 50), 4),
        "p90": round(percentile(values, 90), 4),
        "max": round(max(values), 4),
    }


def score_distribution(per_question: Sequence[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """min/median/p90/max of the top-1 score, grouped by kind. Needs `top_score` on each item."""
    grouped: Dict[str, List[float]] = {KIND_POSITIVE: [], **{kind: [] for kind in REPORT_ONLY_KINDS}}
    for q in per_question:
        score = q.get("top_score")
        if score is None:
            continue
        grouped.setdefault(q.get("kind", KIND_POSITIVE), []).append(float(score))
    return {kind: _stats(values) for kind, values in grouped.items()}


def suggest_min_score(distribution: Dict[str, Dict[str, Any]]) -> Optional[float]:
    """
    A value halfway between the near_miss p90 and the positive median, as a
    starting point for a space's min_score. None when the groups overlap or are
    missing. A suggestion only: it is never applied automatically.
    """
    near = (distribution.get("near_miss") or {}).get("p90")
    positive = (distribution.get("positive") or {}).get("median")
    if near is None or positive is None or near >= positive:
        return None
    return round((near + positive) / 2.0, 3)
