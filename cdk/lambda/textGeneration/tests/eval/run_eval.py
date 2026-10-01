"""
Offline retrieval evaluation for helpers/retrieval.py.

Runs every question in a question set through `retrieve_from_pgvector` against
a real (non-production) database and reports how often, and how high, the
expected sources come back. Use it to record a baseline before a retrieval
change and to compare after it.

Not a unit test: it needs database access and Bedrock (query embeddings), and
it is deliberately not named test_*.py so `unittest discover` skips it.

Usage (from cdk/lambda/textGeneration):

    set EVAL_DATABASE_URL=postgresql://user:pass@host:5432/dbname?sslmode=require
    python tests/eval/run_eval.py tests/eval/questions.json --label baseline

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
        "expected": ["https://example.org/reduced-schedules", "Partial Day Guide"]
      }
    ]

A retrieved source matches an `expected` entry when the entry is a
case-insensitive substring of the source URL, or equals its title. Write
questions in your own words; do not copy real chat messages or personal
details into the question set.

Output contains only question ids, ranks and aggregate metrics, never chunk
text, so it is safe to paste into a PR or ticket.
"""

import argparse
import json
import os
import statistics
import sys
import time
from typing import Any, Dict, List, Optional

# Make `helpers` importable when running from the textGeneration directory.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from helpers import retrieval  # noqa: E402

DEFAULT_K_VALUES = (5, 15)


def load_questions(path: str) -> List[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as handle:
        questions = json.load(handle)
    if not isinstance(questions, list):
        raise ValueError("Question file must contain a JSON list")
    for index, item in enumerate(questions):
        if not item.get("question") or not item.get("expected"):
            raise ValueError(f"Question #{index} needs 'question' and a non-empty 'expected' list")
    return questions


def matches(source: Dict[str, Any], expected: List[str]) -> bool:
    url = (source.get("url") or source.get("uri") or "").lower()
    title = (source.get("title") or "").strip().lower()
    for entry in expected:
        needle = entry.strip().lower()
        if needle and (needle in url or needle == title):
            return True
    return False


def first_match_rank(results: List[Dict[str, Any]], expected: List[str]) -> Optional[int]:
    """1-based rank of the first expected source, or None if absent."""
    for rank, source in enumerate(results, start=1):
        if matches(source, expected):
            return rank
    return None


def evaluate(connection, questions, region: str, num_results: int, k_values) -> Dict[str, Any]:
    per_question = []
    for item in questions:
        query = item.get("search_query") or item["question"]
        started = time.perf_counter()
        results = retrieval.retrieve_from_pgvector(query, connection, region, num_results=num_results)
        elapsed_ms = (time.perf_counter() - started) * 1000
        # retrieve_from_pgvector reads only; end its transaction so the next
        # question starts clean (and SET LOCAL settings do not leak).
        connection.rollback()
        per_question.append({
            "id": item.get("id") or item["question"][:40],
            "rank": first_match_rank(results, item["expected"]),
            "returned": len(results),
            "latency_ms": round(elapsed_ms, 1),
        })

    total = len(per_question)
    ranks = [q["rank"] for q in per_question]
    latencies = sorted(q["latency_ms"] for q in per_question)
    summary = {
        "questions": total,
        "num_results": num_results,
        "mrr": round(sum(1 / r for r in ranks if r) / total, 4) if total else 0.0,
        "avg_returned": round(statistics.mean(q["returned"] for q in per_question), 2) if total else 0.0,
        "full_result_rate": round(sum(q["returned"] >= num_results for q in per_question) / total, 4) if total else 0.0,
        "p50_latency_ms": latencies[len(latencies) // 2] if latencies else 0.0,
        "p95_latency_ms": latencies[min(len(latencies) - 1, int(len(latencies) * 0.95))] if latencies else 0.0,
    }
    for k in k_values:
        summary[f"recall@{k}"] = round(sum(1 for r in ranks if r and r <= k) / total, 4) if total else 0.0
    return {"summary": summary, "per_question": per_question}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Evaluate pgvector retrieval quality.")
    parser.add_argument("questions", help="Path to the JSON question set")
    parser.add_argument("--num-results", type=int, default=15, help="top-k passed to retrieval (default 15)")
    parser.add_argument("--label", default="run", help="Name recorded with the results, e.g. baseline")
    parser.add_argument("--output", help="Optional path to write the full JSON results")
    args = parser.parse_args(argv)

    dsn = os.environ.get("EVAL_DATABASE_URL")
    if not dsn:
        print("EVAL_DATABASE_URL is not set", file=sys.stderr)
        return 2
    region = os.environ.get("REGION", "ca-central-1")

    import psycopg2  # imported here so the module loads without the driver

    questions = load_questions(args.questions)
    connection = psycopg2.connect(dsn)
    try:
        report = evaluate(connection, questions, region, args.num_results, DEFAULT_K_VALUES)
    finally:
        connection.close()

    report["label"] = args.label
    print(json.dumps(report["summary"], indent=2))
    misses = [q["id"] for q in report["per_question"] if q["rank"] is None]
    if misses:
        print(f"Missed ({len(misses)}): {', '.join(misses)}")

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
