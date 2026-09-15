#!/usr/bin/env python3
"""
compare_retrieval.py — R9 comparison harness (see PGVECTOR_MIGRATION_PLAN.md §6.2).

Runs a fixed query set through BOTH retrieval backends and reports how they compare,
so you can set cutover acceptance thresholds with real numbers.

For each query it:
  1. rewrites the query (optional — off by default to isolate retrieval),
  2. retrieves with Bedrock KB (retrieve_documents) AND pgvector (retrieve_from_pgvector),
  3. generates a grounded answer per backend (Claude via Bedrock converse),
  4. scores each answer with intervention.assess_response,
  5. records top-k URLs, latency, score, and label.

It then prints per-query rows and an aggregate summary (mean score, label mix,
mean latency, and URL overlap between the two backends).

RUN CONTEXT
-----------
This is a LIVE tool: it calls Bedrock, the Bedrock Knowledge Base, and RDS/pgvector.
Run it from an environment with AWS creds + DB access (e.g. the SageMaker instance
or a bastion in the VPC), NOT from CI. It reuses the production Lambda helpers in
cdk/lambda/textGeneration/helpers, so point PYTHONPATH at that dir (done automatically
below via --textgen-helpers or the default relative path).

Env / args:
  --kb-id            Bedrock Knowledge Base ID (or env KB_ID)
  --region           AWS region (default: env REGION or ca-central-1)
  --llm-region       region for generation/verifier (default: env LLM_REGION or --region)
  --queries          path to a JSON query set (default: ./comparison_queries.json)
  --top-k            results per retrieval (default: 7)
  --min-score        pgvector min cosine score (default: 0.40)
  --backends         which to run: both | bedrock | pgvector (default: both)
  --rewrite          enable query rewriting before retrieval (default: off)
  --output           JSON results file (default: comparison_results.json)
  --textgen-helpers  path to cdk/lambda/textGeneration (default: inferred)

DB config for the pgvector backend is read the same way the container tools read it
(see Project Refactoring/common/db_config.py): env DB_HOST/DB_NAME/DB_USER/DB_AUTH etc.
"""

import argparse
import importlib.util
import json
import os
import statistics
import sys
import time
from typing import Any, Dict, List


# ── Wiring: import the production Lambda helpers + the shared DB config ─────────

def _load_textgen_helpers(textgen_dir: str):
    """Put cdk/lambda/textGeneration on sys.path so `helpers.*` imports resolve."""
    if not os.path.isdir(os.path.join(textgen_dir, "helpers")):
        raise SystemExit(f"--textgen-helpers path has no helpers/ dir: {textgen_dir}")
    sys.path.insert(0, textgen_dir)
    from helpers import bedrock, retrieval, intervention  # type: ignore
    return bedrock, retrieval, intervention


def _load_db_config():
    """Load the shared secret-free DB config (Project Refactoring/common/db_config.py)."""
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "common", "db_config.py")
    spec = importlib.util.spec_from_file_location("db_config", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore
    return mod


# ── Generation (grounded answer) ────────────────────────────────────────────────

GEN_SYSTEM = (
    "You are an inclusive-education guide for families in Canada. Answer ONLY using "
    "the retrieved context. If the context does not support an answer, say you don't "
    "have enough grounded information. Wrap your reply in <answer>...</answer>."
)


def _generate_answer(boto3_mod, llm_region: str, model_id: str, query: str, context_block: str) -> str:
    import re
    client = boto3_mod.client("bedrock-runtime", region_name=llm_region)
    user = f"<retrieved_context>\n{context_block}\n</retrieved_context>\n\n<question>\n{query}\n</question>"
    resp = client.converse(
        modelId=model_id,
        messages=[{"role": "user", "content": [{"text": user}]}],
        system=[{"text": GEN_SYSTEM}],
        inferenceConfig={"maxTokens": 800, "temperature": 0.2},
    )
    raw = resp["output"]["message"]["content"][0]["text"]
    m = re.search(r"<answer>(.*?)</answer>", raw, re.DOTALL)
    return (m.group(1).strip() if m else raw.strip())


# ── One backend run for one query ────────────────────────────────────────────────

def _run_backend(
    *,
    backend: str,
    query: str,
    retrieval_mod,
    bedrock_mod,
    intervention_mod,
    boto3_mod,
    db_conn,
    kb_id: str,
    region: str,
    llm_region: str,
    top_k: int,
    min_score: float,
    gen_model_id: str,
    verifier_model_id: str,
) -> Dict[str, Any]:
    t0 = time.time()
    if backend == "bedrock":
        sources = bedrock_mod.retrieve_documents(query, kb_id, region, top_k, search_type="HYBRID")
    else:
        sources = retrieval_mod.retrieve_from_pgvector(
            query, db_conn, region, num_results=top_k, min_score=min_score
        )
    retrieve_ms = round((time.time() - t0) * 1000, 1)

    context_block = bedrock_mod.format_context_for_prompt(sources)

    t1 = time.time()
    answer = _generate_answer(boto3_mod, llm_region, gen_model_id, query, context_block)
    generate_ms = round((time.time() - t1) * 1000, 1)

    assessment = intervention_mod.assess_response(
        query=query,
        answer_text=answer,
        sources=sources,
        llm_region=llm_region,
        verifier_model_id=verifier_model_id,
    )

    urls = [s.get("url") for s in sources if s.get("url")]
    return {
        "backend": backend,
        "retrieve_ms": retrieve_ms,
        "generate_ms": generate_ms,
        "num_sources": len(sources),
        "top_urls": urls[:top_k],
        "answer": answer,
        "score": assessment.get("score"),
        "label": assessment.get("label"),
        "warning": assessment.get("warning_text"),
    }


def _overlap(a: List[str], b: List[str]) -> float:
    """Jaccard overlap of two URL lists."""
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 1.0
    if not sa or not sb:
        return 0.0
    return round(len(sa & sb) / len(sa | sb), 3)


def _summarize(rows: List[Dict[str, Any]], backend: str) -> Dict[str, Any]:
    runs = [r[backend] for r in rows if backend in r]
    if not runs:
        return {}
    scores = [r["score"] for r in runs if isinstance(r["score"], (int, float))]
    labels = [r["label"] for r in runs]
    return {
        "n": len(runs),
        "mean_score": round(statistics.mean(scores), 4) if scores else None,
        "label_counts": {lbl: labels.count(lbl) for lbl in set(labels)},
        "mean_retrieve_ms": round(statistics.mean([r["retrieve_ms"] for r in runs]), 1),
        "mean_generate_ms": round(statistics.mean([r["generate_ms"] for r in runs]), 1),
        "mean_sources": round(statistics.mean([r["num_sources"] for r in runs]), 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare Bedrock KB vs pgvector retrieval")
    parser.add_argument("--kb-id", default=os.environ.get("KB_ID"))
    parser.add_argument("--region", default=os.environ.get("REGION", "ca-central-1"))
    parser.add_argument("--llm-region", default=os.environ.get("LLM_REGION"))
    parser.add_argument("--queries", default=os.path.join(os.path.dirname(__file__), "comparison_queries.json"))
    parser.add_argument("--top-k", type=int, default=7)
    parser.add_argument("--min-score", type=float, default=0.40)
    parser.add_argument("--backends", choices=["both", "bedrock", "pgvector"], default="both")
    parser.add_argument("--rewrite", action="store_true")
    parser.add_argument("--output", default="comparison_results.json")
    parser.add_argument("--gen-model-id", default="us.anthropic.claude-haiku-4-5-20251001-v1:0")
    parser.add_argument("--verifier-model-id", default="us.anthropic.claude-haiku-4-5-20251001-v1:0")
    default_textgen = os.path.join(os.path.dirname(__file__), "..", "..", "cdk", "lambda", "textGeneration")
    parser.add_argument("--textgen-helpers", default=default_textgen)
    args = parser.parse_args()

    llm_region = args.llm_region or args.region
    run_bedrock = args.backends in ("both", "bedrock")
    run_pgvector = args.backends in ("both", "pgvector")

    if run_bedrock and not args.kb_id:
        raise SystemExit("--kb-id (or KB_ID env) is required to run the bedrock backend")

    import boto3  # deferred so --help works without boto3

    bedrock_mod, retrieval_mod, intervention_mod = _load_textgen_helpers(os.path.abspath(args.textgen_helpers))

    db_conn = None
    if run_pgvector:
        db_config = _load_db_config()
        db_conn = db_config.get_db_connection()

    with open(args.queries, "r", encoding="utf-8") as f:
        queries = json.load(f)["queries"]

    rows: List[Dict[str, Any]] = []
    for i, q in enumerate(queries, 1):
        query_text = q["query"] if isinstance(q, dict) else q
        print(f"[{i}/{len(queries)}] {query_text}", file=sys.stderr)
        row: Dict[str, Any] = {"query": query_text, "stage": q.get("stage") if isinstance(q, dict) else None}

        if run_bedrock:
            row["bedrock"] = _run_backend(
                backend="bedrock", query=query_text, retrieval_mod=retrieval_mod, bedrock_mod=bedrock_mod,
                intervention_mod=intervention_mod, boto3_mod=boto3, db_conn=db_conn, kb_id=args.kb_id,
                region=args.region, llm_region=llm_region, top_k=args.top_k, min_score=args.min_score,
                gen_model_id=args.gen_model_id, verifier_model_id=args.verifier_model_id,
            )
        if run_pgvector:
            row["pgvector"] = _run_backend(
                backend="pgvector", query=query_text, retrieval_mod=retrieval_mod, bedrock_mod=bedrock_mod,
                intervention_mod=intervention_mod, boto3_mod=boto3, db_conn=db_conn, kb_id=args.kb_id,
                region=args.region, llm_region=llm_region, top_k=args.top_k, min_score=args.min_score,
                gen_model_id=args.gen_model_id, verifier_model_id=args.verifier_model_id,
            )
        if run_bedrock and run_pgvector:
            row["url_overlap"] = _overlap(row["bedrock"]["top_urls"], row["pgvector"]["top_urls"])
        rows.append(row)

    summary = {
        "query_count": len(rows),
        "bedrock": _summarize(rows, "bedrock") if run_bedrock else None,
        "pgvector": _summarize(rows, "pgvector") if run_pgvector else None,
    }
    if run_bedrock and run_pgvector:
        overlaps = [r["url_overlap"] for r in rows if "url_overlap" in r]
        summary["mean_url_overlap"] = round(statistics.mean(overlaps), 3) if overlaps else None

    result = {"summary": summary, "rows": rows, "params": vars(args)}
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    # Human-readable summary to stdout.
    print("\n=== Comparison summary ===")
    print(json.dumps(summary, indent=2))
    print(f"\nFull results -> {args.output}")

    if db_conn is not None:
        db_conn.close()


if __name__ == "__main__":
    main()
