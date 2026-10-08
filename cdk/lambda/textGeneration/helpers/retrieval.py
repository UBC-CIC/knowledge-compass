"""
pgvector retrieval for the text-generation Lambda.

The sole retrieval path since the Bedrock Knowledge Base / OpenSearch
Serverless cutover (see Docs/PGVECTOR_MIGRATION_PLAN.md). It embeds the query
with the ACTIVE embedding space's model (search_query space; Cohere
embed-english-v3 until another space is activated) and runs a cosine-similarity
search over that space's vectors in `chunk_embeddings` (migration 032), joined to
the `chunks` + `sources` tables created by migration 001_unified_chunks.js.

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
from typing import Any, Dict, List, Optional

from helpers import embeddings, retrieval_core
from helpers.embedding_space import EmbeddingSpaceError, get_active_space  # noqa: F401 - re-exported

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# Reasonable defaults; callers pass explicit values from config in practice.
DEFAULT_TOP_K = 7
DEFAULT_MIN_SCORE = 0.40
DEFAULT_MIN_RESULTS = 2
# The legacy model id. The model actually used is the active embedding space's
# (see retrieve_from_pgvector); this constant stays for callers that import it.
EMBED_MODEL_ID = "cohere.embed-english-v3"

# The SQL, paging constants, de-duplication and selection live in
# helpers/retrieval_core.py (shared with the validation task). Names that other
# modules and tests import from here are kept as aliases.
CANDIDATE_MULTIPLIER = retrieval_core.CANDIDATE_MULTIPLIER
MAX_CANDIDATE_PAGES = retrieval_core.MAX_CANDIDATE_PAGES
HNSW_EF_SEARCH = retrieval_core.HNSW_EF_SEARCH
HNSW_ITERATIVE_SCAN = retrieval_core.HNSW_ITERATIVE_SCAN
public_http_url = retrieval_core.public_http_url
_row_to_source = retrieval_core.row_to_source
_canonical_content_key = retrieval_core.canonical_content_key
_distinct_candidate_count = retrieval_core.distinct_candidate_count
_apply_search_settings = retrieval_core.apply_search_settings


def embed_query(
    query: str,
    region: str,
    embed_model_id: str = EMBED_MODEL_ID,
    spec: Optional["embeddings.ModelSpec"] = None,
) -> List[float]:
    """
    Embed a query string for similarity search. With `spec` (an embedding
    space's model spec) that model is used. Without it, `embed_model_id`
    selects a Cohere v3 invoke target, as before embedding spaces existed. The
    request itself is built by helpers/embeddings.py.
    """
    if spec is None:
        spec = (
            embeddings.DEFAULT_SPEC
            if embed_model_id == EMBED_MODEL_ID
            else embeddings.with_invoke_target(embeddings.DEFAULT_SPEC, embed_model_id)
        )
    return embeddings.embed_query(query, spec, region)


def _space_spec(space, embed_model_id: str):
    """
    The model spec to embed with. The space's invoke target wins; an explicit
    non-default `embed_model_id` argument (offline tooling) overrides just the
    invoke target of that spec.
    """
    spec = space.spec
    if embed_model_id != EMBED_MODEL_ID:
        spec = embeddings.with_invoke_target(spec, embed_model_id)
    return spec


def effective_min_score(db_connection, region: Optional[str] = None) -> float:
    """
    The active space's min_score, else DEFAULT_MIN_SCORE. Display-only callers
    (for example the "More resources" fallback) use this, so it never raises:
    if the space cannot be resolved the default applies.
    """
    try:
        space = get_active_space(db_connection, region=region)
    except EmbeddingSpaceError:
        return DEFAULT_MIN_SCORE
    return space.min_score if space.min_score is not None else DEFAULT_MIN_SCORE


def _vector_literal(embedding: List[float]) -> str:
    """Render a Python float list as a pgvector literal: [f1,f2,...]."""
    return "[" + ",".join(str(x) for x in embedding) + "]"


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
    min_score: Optional[float] = None,
    min_results: int = DEFAULT_MIN_RESULTS,
    embed_model_id: str = EMBED_MODEL_ID,
    space_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """
    Retrieve the most relevant chunks for `query` from the unified pgvector corpus.

    Mirrors the notebook `retrieve()` behavior:
      1. Embed the query (search_query space) with the active embedding space's
         model. `space_id` searches another space instead (validation only).
      2. Cosine search over that space's vectors joined to chunks and sources,
         ordered by distance (see helpers/retrieval_core.py for the SQL).
      3. Filter by min_score, de-duplicate by source, cap at num_results.
      4. If fewer than min_results survive the score filter, backfill with the
         nearest results regardless of score (so the model always has some context).

    `min_score` precedence: the explicit argument, else the space's own
    min_score, else DEFAULT_MIN_SCORE.

    A missing or inconsistent embedding space raises EmbeddingSpaceError. That is
    deliberately NOT swallowed: answering from vectors made by a different model
    returns wrong results without any sign of it. Transient embedding or
    database errors during the search itself still return [] so a retrieval
    hiccup degrades to an ungrounded response rather than a hard failure.
    """
    space = get_active_space(db_connection, space_id=space_id, region=region)
    if min_score is None:
        min_score = space.min_score if space.min_score is not None else DEFAULT_MIN_SCORE

    try:
        embedding = embed_query(query, region, embed_model_id, spec=_space_spec(space, embed_model_id))
    except Exception as e:  # noqa: BLE001 - fail soft like the Bedrock retriever
        logger.error(f"Query embedding failed: {type(e).__name__}")
        return []

    embedding_str = _vector_literal(embedding)

    try:
        with db_connection.cursor() as cur:
            # Row-resource citations live on the matched chunk/source. Internal
            # csvrow:// identities are never exposed as public links, and the
            # canonical csvlink cache is hidden once row variants are available.
            rows = retrieval_core.fetch_candidate_rows(cur, space, embedding_str, num_results, min_results)
    except Exception as e:  # noqa: BLE001
        logger.error(f"pgvector retrieval query failed: {type(e).__name__}")
        # A failed statement aborts the transaction; roll back so chat.py can
        # still save the AI response on this connection.
        _rollback_quietly(db_connection)
        return []

    results = retrieval_core.select_results(rows, num_results, min_score, min_results)

    logger.info(
        f"pgvector retrieval: {len(results)} result(s) "
        f"(space={space.name}, min_score={min_score}, requested={num_results})"
    )
    return results
