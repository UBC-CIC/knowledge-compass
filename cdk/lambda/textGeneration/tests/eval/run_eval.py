"""
Offline retrieval evaluation for helpers/retrieval.py.

Runs every question in a question set through `retrieve_from_pgvector` against
a real (non-production) database and reports how often, and how high, the
expected sources come back. Use it to record a baseline before a retrieval
change and to compare after it. With `--candidate` it also compares embedding
models side by side (see "Candidate comparison" below).

Not a unit test: it needs database access and Bedrock (query embeddings), and
it is deliberately not named test_*.py so `unittest discover` skips it.

Usage (from cdk/lambda/textGeneration):

    set EVAL_DATABASE_URL=postgresql://user:pass@host:5432/dbname?sslmode=require
    python tests/eval/run_eval.py ../../layers/shared_python/python/kc_shared/golden_queries.json --label baseline

Compare standard and guideline mode on the same questions:

    python tests/eval/run_eval.py tests/eval/questions.json --mode standard  --label standard
    python tests/eval/run_eval.py tests/eval/questions.json --mode guideline --label guideline

In guideline mode each question may carry "expected_guideline": situation
labels or heading text that should be matched (falls back to "expected").

Environment:
    EVAL_DATABASE_URL  libpq connection string for the database to evaluate
                       (required; never point this at production with real
                       traffic, and never commit it).
    REGION             Bedrock region for query embeddings (default ca-central-1).

Question file format (JSON list):

    [
      {
        "id": "j1-reduced-schedule-01",
        "question": "The school wants my son to only attend mornings ...",
        "search_query": "optional router-style keywords; defaults to question",
        "expected": ["https://example.org/reduced-schedules", "Partial Day Guide"],
        "expected_topics": ["partial day", "reduced schedule"],
        "kind": "near_miss"
      }
    ]

A retrieved source matches an `expected` entry when the entry is a
case-insensitive substring of the source URL, or equals its title. When
`expected` is empty, `expected_topics` is used instead: a source is relevant
when its text mentions at least `--min-topic-hits` (default 2) distinct topics
(clamped to the number of topics the entry has). `kind` is optional: absent
means a positive entry scored pass/fail (recall@k, MRR); "near_miss" and
"off_topic" entries are report-only and never counted in recall/MRR, only in
the top-1 score distribution. Write questions in your own words; do not copy
real chat messages or personal details into the question set. The checked-in
kc_shared/golden_queries.json (shared layer) is synthetic and must stay that way.

Candidate comparison (`--candidate`)
------------------------------------
Reads a read-only snapshot of `chunks` (the same hidden/csv_row gating as
production), embeds every `embed_text` and every golden question with each
candidate model, ranks by cosine similarity in memory and reports per
candidate: recall@5/@15, MRR, query-embedding p50/p95 ms, storage estimate
(chunks x dimensions x 4 bytes), estimated tokens (chars / 4, an estimate) and
cost, and the top-1 score distribution for positive / near_miss / off_topic
entries with a SUGGESTED min_score. Nothing is written to the database.

    python tests/eval/run_eval.py ../../layers/shared_python/python/kc_shared/golden_queries.json --candidate
    python tests/eval/run_eval.py ../../layers/shared_python/python/kc_shared/golden_queries.json --candidate \\
        --candidates v3-baseline titan-v2-1024 titan-v2-512 \\
        --invoke-target titan-v2-1024=amazon.titan-embed-text-v2:0 \\
        --price titan-v2-1024=0.02

Built-in candidates: v3-baseline (Cohere v3, 1024), titan-v2-1024,
titan-v2-512 and cohere-v4 (dimensions via --cohere-v4-dimensions). Invoke
targets are configuration (model id or inference-profile ARN), not claims of
availability in your region. Prices are optional; without one the report says
"price not configured".

Output contains only question ids, ranks and aggregate metrics, never chunk
text, so it is safe to paste into a PR or ticket.
"""

import argparse
import heapq
import json
import math
import operator
import os
import statistics
import sys
import time
from typing import Any, Callable, Dict, List, Optional, Sequence

# Make `helpers` importable when running from the textGeneration directory.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
# And the shared layer source (kc_shared), mounted at /opt/python in Lambda.
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "layers", "shared_python", "python")))

from helpers import guideline_retrieval, retrieval  # noqa: E402
from kc_shared import embeddings, eval_scoring  # noqa: E402

DEFAULT_K_VALUES = (5, 15)
KNOWN_KINDS = eval_scoring.REPORT_ONLY_KINDS
CHARS_PER_TOKEN = 4  # estimate only; Titan's real token count is known after a call

# name -> (provider, default invoke target, dimensions). Targets are overridable.
CANDIDATES = {
    "v3-baseline": ("cohere_v3", "cohere.embed-english-v3", 1024),
    "titan-v2-1024": ("titan_v2", "amazon.titan-embed-text-v2:0", 1024),
    "titan-v2-512": ("titan_v2", "amazon.titan-embed-text-v2:0", 512),
    "cohere-v4": ("cohere_v4", "cohere.embed-v4:0", 1024),
}


def load_questions(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as handle:
        questions = json.load(handle)
    if not isinstance(questions, list):
        raise ValueError("Question file must contain a JSON list")
    for index, item in enumerate(questions):
        if not isinstance(item, dict) or not item.get("question"):
            raise ValueError(f"Question #{index} needs a non-empty 'question'")
        kind = item.get("kind")
        if kind is not None and kind not in KNOWN_KINDS:
            raise ValueError(f"Question #{index} has unknown 'kind' {kind!r} (use one of {KNOWN_KINDS})")
        if kind in KNOWN_KINDS:
            continue  # report-only entries have no expected answer by design
        if not item.get("expected") and not item.get("expected_topics"):
            raise ValueError(
                f"Question #{index} needs 'question' and a non-empty 'expected' or 'expected_topics' list"
            )
    return questions


def matches(source: Dict[str, Any], expected: List[str]) -> bool:
    return eval_scoring.matches(source, expected)


def expected_for(item: Dict[str, Any], mode: str) -> List[str]:
    """Guideline mode may name its own targets (situation labels or headings)."""
    if mode == "guideline" and item.get("expected_guideline"):
        return item["expected_guideline"]
    return item.get("expected") or []


def run_retrieval(mode: str, query: str, connection, region: str, num_results: int) -> List[Dict[str, Any]]:
    if mode == "guideline":
        return guideline_retrieval.retrieve_guideline_sections(
            query, connection, region, max_sections=num_results, max_words=10**6
        )
    return retrieval.retrieve_from_pgvector(query, connection, region, num_results=num_results)


def first_match_rank(results: List[Dict[str, Any]], expected: List[str]) -> Optional[int]:
    """1-based rank of the first expected source, or None if absent."""
    for rank, source in enumerate(results, start=1):
        if matches(source, expected):
            return rank
    return None


def _question_id(item: Dict[str, Any]) -> str:
    return item.get("id") or item["question"][:40]


def _top_score(results: Sequence[Dict[str, Any]]) -> Optional[float]:
    return float(results[0]["score"]) if results and results[0].get("score") is not None else None


def evaluate(
    connection,
    questions,
    region: str,
    num_results: int,
    k_values,
    mode: str = "standard",
    min_topic_hits: int = eval_scoring.DEFAULT_MIN_TOPIC_HITS,
) -> Dict[str, Any]:
    per_question = []
    for item in questions:
        kind = eval_scoring.kind_of(item)
        # Guideline mode has no router, so it always searches the raw question.
        query = item["question"] if mode == "guideline" else (item.get("search_query") or item["question"])
        started = time.perf_counter()
        results = run_retrieval(mode, query, connection, region, num_results)
        elapsed_ms = (time.perf_counter() - started) * 1000
        # retrieve_from_pgvector reads only; end its transaction so the next
        # question starts clean (and SET LOCAL settings do not leak).
        connection.rollback()
        rank = None
        if kind == eval_scoring.KIND_POSITIVE:
            rank = eval_scoring.first_relevant_rank(
                results, item, min_topic_hits=min_topic_hits, expected=expected_for(item, mode)
            )
        per_question.append({
            "id": _question_id(item),
            "kind": kind,
            "rank": rank,
            "returned": len(results),
            "top_score": _top_score(results),
            "latency_ms": round(elapsed_ms, 1),
        })

    total = len(per_question)
    latencies = sorted(q["latency_ms"] for q in per_question)
    summary = {"mode": mode, "num_results": num_results}
    summary.update(eval_scoring.summarize(per_question, k_values))
    summary.update({
        "avg_returned": round(statistics.mean(q["returned"] for q in per_question), 2) if total else 0.0,
        "full_result_rate": round(sum(q["returned"] >= num_results for q in per_question) / total, 4) if total else 0.0,
        "p50_latency_ms": latencies[len(latencies) // 2] if latencies else 0.0,
        "p95_latency_ms": latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else 0.0,
    })
    return {
        "summary": summary,
        "score_distribution": eval_scoring.score_distribution(per_question),
        "per_question": per_question,
    }


# ── Candidate comparison ──────────────────────────────────────────────────────

# Same visibility rules as kc_shared/retrieval_core.py's production query: hidden
# sources are excluded and csv_row sources only count when a link indexed them.
_SNAPSHOT_SQL = """
    SELECT c.id, c.embed_text, s.name, s.url, s.source_type, s.id,
           c.metadata->>'canonical_content_key'
    FROM chunks c
    JOIN sources s ON s.id = c.source_id
    WHERE c.embed_text IS NOT NULL
      AND COALESCE(s.metadata->>'retrieval_hidden', 'false') <> 'true'
      AND (
        s.source_type <> 'csv_row'::source_type
        OR EXISTS (
          SELECT 1 FROM csv_row_links l
          WHERE l.row_source_id = s.id AND l.row_indexed = true
        )
      )
    ORDER BY c.id
"""
_SNAPSHOT_FETCH = 500


def read_snapshot(connection) -> List[Dict[str, Any]]:
    """Read-only snapshot of the retrievable chunks (no writes, one transaction)."""
    chunks: List[Dict[str, Any]] = []
    with connection.cursor() as cur:
        cur.execute("SET TRANSACTION READ ONLY")
    cursor = connection.cursor(name="eval_snapshot")
    try:
        cursor.itersize = _SNAPSHOT_FETCH
        cursor.execute(_SNAPSHOT_SQL)
        for chunk_id, embed_text, title, url, source_type, source_id, canonical_key in cursor:
            chunks.append({
                "id": str(chunk_id),
                "embed_text": embed_text,
                "content": embed_text,
                "title": title,
                "url": retrieval.public_http_url(url),
                "source_type": source_type,
                "source_id": str(source_id),
                "canonical_key": canonical_key,
            })
    finally:
        cursor.close()
        connection.rollback()
    return chunks


def _normalize(vector: Sequence[float]) -> List[float]:
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def _dot(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(map(operator.mul, a, b))


def rank_chunks(
    query_vector: Sequence[float],
    chunks: Sequence[Dict[str, Any]],
    vectors: Sequence[Sequence[float]],
    num_results: int,
    scan_limit: int = 200,
) -> List[Dict[str, Any]]:
    """Top `num_results` sources by cosine similarity, de-duplicated like production."""
    query = _normalize(query_vector)
    best = heapq.nlargest(scan_limit, ((_dot(query, vec), idx) for idx, vec in enumerate(vectors)))
    seen_sources, seen_canonical = set(), set()
    results: List[Dict[str, Any]] = []
    for score, idx in best:
        chunk = chunks[idx]
        canonical = chunk.get("canonical_key")
        if chunk["source_id"] in seen_sources or (canonical and canonical in seen_canonical):
            continue
        seen_sources.add(chunk["source_id"])
        if canonical:
            seen_canonical.add(canonical)
        results.append({**chunk, "score": round(score, 4)})
        if len(results) >= num_results:
            break
    return results


def estimate_tokens(chunks: Sequence[Dict[str, Any]], spec: "embeddings.ModelSpec") -> int:
    chars = sum(min(len(c["embed_text"]), spec.max_chars) for c in chunks)
    return math.ceil(chars / CHARS_PER_TOKEN)


def run_candidate(
    name: str,
    spec: "embeddings.ModelSpec",
    chunks: Sequence[Dict[str, Any]],
    questions: Sequence[Dict[str, Any]],
    k_values: Sequence[int] = DEFAULT_K_VALUES,
    num_results: int = 15,
    min_topic_hits: int = eval_scoring.DEFAULT_MIN_TOPIC_HITS,
    price_per_1m_tokens: Optional[float] = None,
    embed_documents_fn: Callable[..., List[List[float]]] = embeddings.embed_documents,
    embed_query_fn: Callable[..., List[float]] = embeddings.embed_query,
    region: Optional[str] = None,
    doc_batch: int = 200,
) -> Dict[str, Any]:
    """Embed the snapshot and the golden questions with `spec` and score the ranking."""
    vectors: List[List[float]] = []
    texts = [c["embed_text"] for c in chunks]
    for start in range(0, len(texts), doc_batch):
        batch = embed_documents_fn(texts[start:start + doc_batch], spec, region)
        vectors.extend(_normalize(v) for v in batch)
        print(f"[{name}] embedded {len(vectors)}/{len(texts)} chunks", file=sys.stderr)

    per_question = []
    query_ms: List[float] = []
    for item in questions:
        query = item.get("search_query") or item["question"]
        started = time.perf_counter()
        query_vector = embed_query_fn(query, spec, region)
        query_ms.append((time.perf_counter() - started) * 1000)
        results = rank_chunks(query_vector, chunks, vectors, num_results)
        kind = eval_scoring.kind_of(item)
        rank = None
        if kind == eval_scoring.KIND_POSITIVE:
            rank = eval_scoring.first_relevant_rank(results, item, min_topic_hits=min_topic_hits)
        per_question.append({
            "id": _question_id(item),
            "kind": kind,
            "rank": rank,
            "returned": len(results),
            "top_score": _top_score(results),
        })

    tokens = estimate_tokens(chunks, spec)
    distribution = eval_scoring.score_distribution(per_question)
    cost = None if price_per_1m_tokens is None else round(tokens / 1e6 * price_per_1m_tokens, 4)
    summary = {"candidate": name, "provider": spec.provider, "dimensions": spec.dimensions}
    summary.update(eval_scoring.summarize(per_question, k_values))
    summary.update({
        "query_embed_p50_ms": round(eval_scoring.percentile(query_ms, 50), 1),
        "query_embed_p95_ms": round(eval_scoring.percentile(query_ms, 95), 1),
        "chunks": len(chunks),
        "storage_bytes_estimate": len(chunks) * spec.dimensions * 4,
        "storage_note": "vectors only; an HNSW index adds overhead on top (often similar in size or larger)",
        "estimated_tokens": tokens,
        "token_estimate_note": f"chars / {CHARS_PER_TOKEN}; an estimate, not a billed count",
        "estimated_cost_usd": cost if cost is not None else "price not configured",
        "suggested_min_score": eval_scoring.suggest_min_score(distribution),
        "suggested_min_score_note": "suggestion only, never applied automatically",
    })
    return {"summary": summary, "score_distribution": distribution, "per_question": per_question}


def parse_pairs(values: Optional[Sequence[str]], cast: Callable[[str], Any] = str) -> Dict[str, Any]:
    """Parse repeated NAME=VALUE flags."""
    parsed: Dict[str, Any] = {}
    for value in values or ():
        name, sep, raw = value.partition("=")
        if not sep or not name or not raw:
            raise ValueError(f"Expected NAME=VALUE, got {value!r}")
        parsed[name] = cast(raw)
    return parsed


def build_candidate_specs(
    names: Sequence[str],
    invoke_targets: Dict[str, str],
    cohere_v4_dimensions: int = 1024,
) -> Dict[str, "embeddings.ModelSpec"]:
    specs = {}
    for name in names:
        if name not in CANDIDATES:
            raise ValueError(f"Unknown candidate {name!r}; choose from {sorted(CANDIDATES)}")
        provider, target, dimensions = CANDIDATES[name]
        if name == "cohere-v4":
            dimensions = cohere_v4_dimensions
        specs[name] = embeddings.spec_from_row({
            "provider": provider,
            "invoke_target": invoke_targets.get(name, target),
            "dimensions": dimensions,
        })
    return specs


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate pgvector retrieval quality.")
    parser.add_argument("questions", help="Path to the JSON question set")
    parser.add_argument("--num-results", type=int, default=15, help="top-k passed to retrieval (default 15)")
    parser.add_argument("--label", default="run", help="Name recorded with the results, e.g. baseline")
    parser.add_argument("--output", help="Optional path to write the full JSON results")
    parser.add_argument(
        "--mode",
        choices=("standard", "guideline"),
        default="standard",
        help="standard = corpus retrieval (default); guideline = uploaded-guide sections (migration 031)",
    )
    parser.add_argument(
        "--min-topic-hits",
        type=int,
        default=eval_scoring.DEFAULT_MIN_TOPIC_HITS,
        help="distinct expected_topics a result must mention to count as relevant (default 2)",
    )
    parser.add_argument(
        "--candidate",
        action="store_true",
        help="compare embedding models over a read-only snapshot of chunks (needs EVAL_DATABASE_URL and Bedrock)",
    )
    parser.add_argument(
        "--candidates",
        nargs="+",
        default=list(CANDIDATES),
        help=f"candidates to compare with --candidate (default: all of {', '.join(CANDIDATES)})",
    )
    parser.add_argument(
        "--invoke-target",
        action="append",
        metavar="NAME=ID",
        help="override a candidate's Bedrock model id or inference-profile ARN (repeatable)",
    )
    parser.add_argument(
        "--price",
        action="append",
        metavar="NAME=USD",
        help="USD per 1M tokens for a candidate, for the cost estimate (repeatable, optional)",
    )
    parser.add_argument(
        "--cohere-v4-dimensions",
        type=int,
        default=1024,
        help="output dimensions for the cohere-v4 candidate (default 1024)",
    )
    args = parser.parse_args(argv)
    if args.mode == "guideline" and args.num_results == 15:
        args.num_results = 3  # guideline mode sends at most 3 sections per turn

    dsn = os.environ.get("EVAL_DATABASE_URL")
    if not dsn:
        print("EVAL_DATABASE_URL is not set", file=sys.stderr)
        return 2
    region = os.environ.get("REGION", "ca-central-1")

    import psycopg2  # imported here so the module loads without the driver

    questions = load_questions(args.questions)

    if args.candidate:
        specs = build_candidate_specs(
            args.candidates, parse_pairs(args.invoke_target), args.cohere_v4_dimensions
        )
        prices = parse_pairs(args.price, float)
        connection = psycopg2.connect(dsn)
        try:
            chunks = read_snapshot(connection)
        finally:
            connection.close()
        reports = {}
        for name, spec in specs.items():
            reports[name] = run_candidate(
                name, spec, chunks, questions, DEFAULT_K_VALUES, args.num_results,
                args.min_topic_hits, prices.get(name), region=region,
            )
            print(json.dumps(reports[name]["summary"], indent=2))
            print(json.dumps({"score_distribution": reports[name]["score_distribution"]}, indent=2))
        if args.output:
            with open(args.output, "w", encoding="utf-8") as handle:
                json.dump({"label": args.label, "candidates": reports}, handle, indent=2)
        return 0

    connection = psycopg2.connect(dsn)
    try:
        k_values = (1, 3) if args.mode == "guideline" else DEFAULT_K_VALUES
        report = evaluate(
            connection, questions, region, args.num_results, k_values,
            mode=args.mode, min_topic_hits=args.min_topic_hits,
        )
    finally:
        connection.close()

    report["label"] = args.label
    print(json.dumps(report["summary"], indent=2))
    print(json.dumps({"score_distribution": report["score_distribution"]}, indent=2))
    misses = [q["id"] for q in report["per_question"] if q["kind"] == "positive" and q["rank"] is None]
    if misses:
        print(f"Missed ({len(misses)}): {', '.join(misses)}")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
