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

`url`/`uri` are only ever public http(s) links. Internal storage identities
(`upload://...`, legacy `s3://bucket/key`, `csvlink://...`) are blanked so they
never reach the prompt, the client, or persisted chat history.

`to_public_source` is the smaller projection sent to the browser and stored in
chat_messages.sources; the full dict above stays server-side for the prompt
and the grounding verifier.
"""

import logging
from typing import Any, Dict, List
from urllib.parse import urlparse

from helpers import embeddings

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

# HNSW returns at most hnsw.ef_search rows per scan (pgvector default 40), and
# the WHERE filters plus de-duplication run after the scan, so the defaults cap
# a 120-row page at 40 and stop OFFSET paging. ef_search sizes the first batch;
# iterative scan (pgvector >= 0.8.0, migration 023) lets the scan keep going
# until LIMIT/OFFSET are satisfied. strict_order keeps exact distance order so
# successive OFFSET pages neither overlap nor skip rows.
HNSW_EF_SEARCH = 200
HNSW_ITERATIVE_SCAN = "strict_order"


def embed_query(query: str, region: str, embed_model_id: str = EMBED_MODEL_ID) -> List[float]:
    """
    Embed a query string with Cohere embed-english-v3 via Bedrock, using the
    'search_query' input space (must match the 'search_document' space used at
    ingest time). Returns a 1024-dim float vector. The request itself is built
    by helpers/embeddings.py.
    """
    spec = (
        embeddings.DEFAULT_SPEC
        if embed_model_id == EMBED_MODEL_ID
        else embeddings.with_invoke_target(embeddings.DEFAULT_SPEC, embed_model_id)
    )
    return embeddings.embed_query(query, spec, region)


def _vector_literal(embedding: List[float]) -> str:
    """Render a Python float list as a pgvector literal: [f1,f2,...]."""
    return "[" + ",".join(str(x) for x in embedding) + "]"


def public_http_url(url: Any) -> str:
    """Return `url` if it is an absolute http(s) link, otherwise ''."""
    if not isinstance(url, str):
        return ""
    candidate = url.strip()
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return ""
    if parsed.scheme.lower() in ("http", "https") and parsed.netloc:
        return candidate
    return ""


# Characters of chunk text sent to the client for the resource card preview.
# The frontend truncates to 320 characters, so this leaves a little headroom.
PUBLIC_PREVIEW_CHARS = 400
# Only video timestamps are rendered from chunk metadata.
_PUBLIC_METADATA_KEYS = ("chunk_start", "chunk_end")


def to_public_source(source: Dict[str, Any]) -> Dict[str, Any]:
    """
    Project a retrieval source dict onto the fields the chat UI renders.

    Drops the full chunk body, similarity score, and internal chunk metadata
    (CSV columns, fetch URLs, file names, canonical keys) so they are neither
    streamed to anonymous users nor persisted with every message.
    """
    url = public_http_url(source.get("url") or source.get("uri"))
    content = source.get("content") or ""
    if not isinstance(content, str):
        content = str(content)
    if len(content) > PUBLIC_PREVIEW_CHARS:
        content = content[:PUBLIC_PREVIEW_CHARS].rstrip() + "…"
    metadata = source.get("metadata") or {}
    public_metadata = {
        key: metadata[key]
        for key in _PUBLIC_METADATA_KEYS
        if isinstance(metadata, dict) and isinstance(metadata.get(key), str)
    }
    public = {
        "type": source.get("type") or "",
        "source_type": source.get("source_type") or "",
        "title": source.get("title") or url or "Untitled resource",
        "url": url,
        "uri": url,
        "content": content,
    }
    if public_metadata:
        public["metadata"] = public_metadata
    return public


def _row_to_source(body, metadata, url, title, source_type, score) -> Dict[str, Any]:
    """Map a DB row to the legacy-compatible source dict."""
    st = (source_type or "web")
    public_url = public_http_url(url)
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


def _apply_search_settings(cur) -> None:
    """
    Raise the HNSW candidate limits for this transaction only.

    SET LOCAL ends with the transaction, so nothing leaks to later queries on
    the cached connection. Each setting runs in its own savepoint: an older
    pgvector without hnsw.iterative_scan rejects that parameter, and without
    the savepoint the error would abort the transaction and the search after it.
    """
    for statement in (
        f"SET LOCAL hnsw.ef_search = {int(HNSW_EF_SEARCH)}",
        f"SET LOCAL hnsw.iterative_scan = {HNSW_ITERATIVE_SCAN}",
    ):
        cur.execute("SAVEPOINT retrieval_settings")
        try:
            cur.execute(statement)
        except Exception as e:  # noqa: BLE001 - keep searching with defaults
            cur.execute("ROLLBACK TO SAVEPOINT retrieval_settings")
            logger.warning("Retrieval setting skipped (%s): %s", statement, type(e).__name__)
        cur.execute("RELEASE SAVEPOINT retrieval_settings")


def _rollback_quietly(db_connection) -> None:
    """End an aborted transaction so later writes on this connection still work."""
    rollback = getattr(db_connection, "rollback", None)
    if rollback is None:
        return
    try:
        rollback()
    except Exception:  # noqa: BLE001
        pass


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
            _apply_search_settings(cur)
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
        # A failed statement aborts the transaction; roll back so chat.py can
        # still save the AI response on this connection.
        _rollback_quietly(db_connection)
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
