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

# Fetch extra candidates because per-source and canonical-content de-duplication
# can collapse many row-specific variants of one fetched page.
CANDIDATE_MULTIPLIER = 8
MAX_CANDIDATE_PAGES = 20


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
    public_url = url or ""
    return {
        # Legacy keys consumed by bedrock.format_context_for_prompt / chat.py
        "type": st.upper(),
        "uri": public_url,
        "url": public_url,
        "content": body,
        "score": round(float(score), 4),
        # Richer fields for later use
        "title": title or public_url or "Untitled resource",
        "source_type": st,
        "metadata": metadata or {},
    }


def _canonical_content_key(metadata: dict | None) -> str | None:
    """Identity shared by row variants of the same canonical fetched chunk."""
    value = (metadata or {}).get("canonical_content_key")
    return str(value) if value else None


def _distinct_candidate_count(rows: list) -> int:
    """Count results that survive source and canonical-content de-duplication."""
    seen_sources = set()
    seen_canonical_content = set()
    count = 0
    for row in rows:
        metadata, source_id = row[1], row[6]
        canonical_key = _canonical_content_key(metadata)
        if source_id in seen_sources:
            continue
        if canonical_key and canonical_key in seen_canonical_content:
            continue
        seen_sources.add(source_id)
        if canonical_key:
            seen_canonical_content.add(canonical_key)
        count += 1
    return count


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
            # Row-resource citations live on the matched chunk/source. Internal
            # csvrow:// identities are never exposed as public links, and the
            # canonical csvlink cache is hidden once row variants are available.
            page_size = max(num_results * CANDIDATE_MULTIPLIER, min_results)
            rows = []
            for page_number in range(MAX_CANDIDATE_PAGES):
                cur.execute(
                    """
                    SELECT c.body, c.metadata,
                           COALESCE(
                             NULLIF(c.metadata->>'citation_url', ''),
                             NULLIF(s.metadata->>'citation_url', ''),
                             CASE
                               WHEN s.source_type = 'csv_row'::source_type THEN NULL
                               ELSE s.url
                             END
                           ) AS url,
                           s.name AS title, s.source_type,
                           1 - (c.embedding <=> %s::vector) AS score,
                           s.id AS source_id
                    FROM chunks c
                    JOIN sources s ON s.id = c.source_id
                    WHERE c.embedding IS NOT NULL
                      AND COALESCE(s.metadata->>'retrieval_hidden', 'false') <> 'true'
                      AND (
                        s.source_type <> 'csv_row'::source_type
                        OR EXISTS (
                          SELECT 1
                          FROM csv_row_links l
                          WHERE l.row_source_id = s.id AND l.row_indexed = true
                        )
                      )
                    ORDER BY c.embedding <=> %s::vector
                    LIMIT %s OFFSET %s
                    """,
                    (embedding_str, embedding_str, page_size, page_number * page_size),
                )
                page = cur.fetchall()
                rows.extend(page)
                if len(page) < page_size or _distinct_candidate_count(rows) >= num_results:
                    break
    except Exception as e:  # noqa: BLE001
        logger.error(f"pgvector retrieval query failed: {e}")
        return []

    # Keep one chunk per row/source and one row variant per canonical fetched
    # chunk. Standalone row chunks have no canonical key and remain discrete.
    seen_sources = set()
    seen_canonical_content = set()
    results: List[Dict[str, Any]] = []

    def append_row(row) -> bool:
        body, metadata, url, title, source_type, score, source_id = row
        canonical_key = _canonical_content_key(metadata)
        if source_id in seen_sources:
            return False
        if canonical_key and canonical_key in seen_canonical_content:
            return False
        seen_sources.add(source_id)
        if canonical_key:
            seen_canonical_content.add(canonical_key)
        results.append(_row_to_source(body, metadata, url, title, source_type, score))
        return True

    for row in rows:
        if float(row[5]) < min_score:
            continue
        append_row(row)
        if len(results) >= num_results:
            break

    # Backfill so the model always has at least min_results of context.
    if len(results) < min_results:
        for row in rows:
            append_row(row)
            if len(results) >= min_results:
                break

    logger.info(
        f"pgvector retrieval: {len(results)} result(s) "
        f"(min_score={min_score}, requested={num_results})"
    )
    return results
