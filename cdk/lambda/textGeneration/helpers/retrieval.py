"""
pgvector retrieval for the text-generation Lambda.

The sole retrieval path since the Bedrock Knowledge Base / OpenSearch
Serverless cutover (see Docs/PGVECTOR_MIGRATION_PLAN.md). It embeds the query
with Cohere embed-english-v3 (search_query space) and runs a cosine-similarity
search against the unified `chunks` + `sources` tables created by migration
001_unified_chunks.js.

Output contract
---------------
`retrieve_from_pgvector` returns a list of dicts consumed by
`format_context_for_prompt` and the rest of `chat.py`:

    {
        "type":        "WEB" | "VIDEO" | "DOCUMENT" | "CSV_LINK",  # legacy key (uppercased)
        "uri":         <canonical url>,               # legacy key
        "url":         <canonical url>,               # legacy key
        "content":     <chunk body>,                  # legacy key used by format_context
        "score":       <cosine similarity 0..1>,      # legacy key
        # richer fields for later use (frontend rebuild / video timestamps):
        "title":       <source name or url>,
        "source_type": "web" | "video" | "document" | "csv_link",
        "metadata":    { ... },                       # csv_link chunks: csv_rows (linking rows' columns)
    }
"""

import json
import logging
from typing import Any, Dict, List

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# Reasonable defaults; callers pass explicit values from config in practice.
DEFAULT_TOP_K = 7
DEFAULT_MIN_SCORE = 0.40
DEFAULT_MIN_RESULTS = 2
EMBED_MODEL_ID = "cohere.embed-english-v3"

# Fetch more candidates than top_k so per-source de-duplication still yields top_k rows.
CANDIDATE_MULTIPLIER = 3


def embed_query(query: str, region: str, embed_model_id: str = EMBED_MODEL_ID) -> List[float]:
    """
    Embed a query string with Cohere embed-english-v3 via Bedrock, using the
    'search_query' input space (must match the 'search_document' space used at
    ingest time). Returns a 1024-dim float vector.
    """
    client = boto3.client("bedrock-runtime", region_name=region)
    response = client.invoke_model(
        modelId=embed_model_id,
        body=json.dumps(
            {
                "texts": [query[:2048]],
                "input_type": "search_query",
                "truncate": "END",
            }
        ),
        contentType="application/json",
        accept="application/json",
    )
    return json.loads(response["body"].read())["embeddings"][0]


def _vector_literal(embedding: List[float]) -> str:
    """Render a Python float list as a pgvector literal: [f1,f2,...]."""
    return "[" + ",".join(str(x) for x in embedding) + "]"


def _row_to_source(body, metadata, url, title, source_type, score) -> Dict[str, Any]:
    """Map a DB row to the legacy-compatible source dict."""
    st = (source_type or "web")
    return {
        # Legacy keys consumed by bedrock.format_context_for_prompt / chat.py
        "type": st.upper(),
        "uri": url,
        "url": url,
        "content": body,
        "score": round(float(score), 4),
        # Richer fields for later use
        "title": title or url,
        "source_type": st,
        "metadata": metadata or {},
    }


def retrieve_from_pgvector(
    query: str,
    db_connection,
    region: str,
    num_results: int = DEFAULT_TOP_K,
    min_score: float = DEFAULT_MIN_SCORE,
    min_results: int = DEFAULT_MIN_RESULTS,
    embed_model_id: str = EMBED_MODEL_ID,
) -> List[Dict[str, Any]]:
    """
    Retrieve the most relevant chunks for `query` from the unified pgvector corpus.

    Mirrors the notebook `retrieve()` behavior:
      1. Embed the query (search_query space).
      2. Cosine search over chunks joined to sources, ordered by distance.
      3. Filter by min_score, de-duplicate by source, cap at num_results.
      4. If fewer than min_results survive the score filter, backfill with the
         nearest results regardless of score (so the model always has some context).

    Returns [] on any failure (embedding error, DB error) so a retrieval
    hiccup degrades to an ungrounded response rather than a hard failure.
    """
    try:
        embedding = embed_query(query, region, embed_model_id)
    except Exception as e:  # noqa: BLE001 - fail soft like the Bedrock retriever
        logger.error(f"Query embedding failed: {e}")
        return []

    embedding_str = _vector_literal(embedding)

    try:
        with db_connection.cursor() as cur:
            # Uploaded documents are stored under an internal upload:// url;
            # their public link (if any) is sources.metadata.citation_url.
            cur.execute(
                """
                SELECT c.body, c.metadata,
                       COALESCE(NULLIF(s.metadata->>'citation_url', ''), s.url) AS url,
                       s.name AS title, s.source_type,
                       1 - (c.embedding <=> %s::vector) AS score,
                       s.id AS source_id
                FROM chunks c
                JOIN sources s ON s.id = c.source_id
                WHERE c.embedding IS NOT NULL
                ORDER BY c.embedding <=> %s::vector
                LIMIT %s
                """,
                (embedding_str, embedding_str, num_results * CANDIDATE_MULTIPLIER),
            )
            rows = cur.fetchall()
    except Exception as e:  # noqa: BLE001
        logger.error(f"pgvector retrieval query failed: {e}")
        return []

    # One result per source, not per url: two documents may share a citation link.
    seen_sources = set()
    results: List[Dict[str, Any]] = []
    for body, metadata, url, title, source_type, score, source_id in rows:
        if float(score) < min_score:
            continue
        if source_id in seen_sources:
            continue
        seen_sources.add(source_id)
        results.append(_row_to_source(body, metadata, url, title, source_type, score))
        if len(results) >= num_results:
            break

    # Backfill so the model always has at least min_results of context.
    if len(results) < min_results:
        for body, metadata, url, title, source_type, score, source_id in rows:
            if source_id in seen_sources:
                continue
            seen_sources.add(source_id)
            results.append(_row_to_source(body, metadata, url, title, source_type, score))
            if len(results) >= min_results:
                break

    logger.info(
        f"pgvector retrieval: {len(results)} result(s) "
        f"(min_score={min_score}, requested={num_results})"
    )
    return results
