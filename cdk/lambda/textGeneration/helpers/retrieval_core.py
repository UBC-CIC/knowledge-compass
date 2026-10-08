"""
Pure retrieval core shared by chat retrieval and space validation.

Holds the standard similarity-search SQL, the candidate paging loop and the
de-duplication / backfill selection, so the chat path (helpers/retrieval.py)
and the validation task that compares an old and a new embedding space run the
SAME query and filters. No embedding calls, no AWS, no database connection
management: callers pass a cursor.

Packaging
---------
The canonical copy lives in cdk/lambda/textGeneration/helpers/. A byte-identical
mirror is kept in cdk/lambda/knowledgeBase/helpers/ (the two Lambdas are packaged
separately); tests/test_shared_module_parity.py fails if they drift. Edit the
textGeneration copy, then copy it over the mirror. Standard library only.

Vectors live in `chunk_embeddings` (migration 032), one row per (chunk, space).
A space's vectors are searched through its partial HNSW index

    (embedding::vector(N)) vector_cosine_ops  WHERE space_id = '<uuid>'

so the SQL below uses a LITERAL space uuid (psycopg2 interpolates parameters on
the client, but this value is inlined here after UUID validation so the planner
can match it to the index predicate) and the SAME `::vector(N)` cast in the score
expression and in ORDER BY. A vector only counts when `embed_hash` equals
md5(chunks.embed_text): a chunk whose text changed after it was embedded is
never returned with a stale vector.

Never log chunk text or the query; only counts and settings.
"""

import logging
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

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


def _space_field(space: Any, name: str) -> Any:
    if isinstance(space, dict):
        return space[name]
    return getattr(space, name)


def space_literals(space: Any):
    """
    (uuid text, int dimensions) for SQL text. The id is re-parsed as a UUID and
    the dimension forced to int, so nothing but a canonical uuid and a number
    can ever be inlined into SQL.
    """
    space_uuid = str(uuid.UUID(str(_space_field(space, "id"))))
    dimensions = int(_space_field(space, "dimensions"))
    if dimensions < 1:
        raise ValueError("dimensions must be positive")
    return space_uuid, dimensions


def build_standard_sql(space: Any) -> str:
    """
    Candidate query for `space`. Parameters, in order: query vector (score),
    query vector (ORDER BY), LIMIT, OFFSET.
    """
    space_uuid, dims = space_literals(space)
    return f"""
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
               1 - (ce.embedding::vector({dims}) <=> %s::vector) AS score,
               s.id AS source_id
        FROM chunk_embeddings ce
        JOIN chunks c ON c.id = ce.chunk_id
        JOIN sources s ON s.id = c.source_id
        WHERE ce.space_id = '{space_uuid}'
          AND ce.embed_hash = md5(c.embed_text)
          AND COALESCE(s.metadata->>'retrieval_hidden', 'false') <> 'true'
          AND (
            s.source_type <> 'csv_row'::source_type
            OR EXISTS (
              SELECT 1
              FROM csv_row_links l
              WHERE l.row_source_id = s.id AND l.row_indexed = true
            )
          )
        ORDER BY ce.embedding::vector({dims}) <=> %s::vector
        LIMIT %s OFFSET %s
    """


def row_to_source(body, metadata, url, title, source_type, score) -> Dict[str, Any]:
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


def canonical_content_key(metadata: Optional[dict]) -> Optional[str]:
    """Identity shared by row variants of the same canonical fetched chunk."""
    value = (metadata or {}).get("canonical_content_key")
    return str(value) if value else None


def distinct_candidate_count(rows: list) -> int:
    """Count results that survive source and canonical-content de-duplication."""
    seen_sources = set()
    seen_canonical_content = set()
    count = 0
    for row in rows:
        metadata, source_id = row[1], row[6]
        canonical_key = canonical_content_key(metadata)
        if source_id in seen_sources:
            continue
        if canonical_key and canonical_key in seen_canonical_content:
            continue
        seen_sources.add(source_id)
        if canonical_key:
            seen_canonical_content.add(canonical_key)
        count += 1
    return count


def apply_search_settings(cur) -> None:
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


def fetch_candidate_rows(cur, space: Any, embedding_str: str, num_results: int, min_results: int) -> list:
    """
    Page through the nearest chunks of `space` until `num_results` distinct
    sources are available (or the pages run out). Rows are ordered by
    similarity, highest first.
    """
    page_size = max(num_results * CANDIDATE_MULTIPLIER, min_results)
    apply_search_settings(cur)
    sql = build_standard_sql(space)
    rows: list = []
    for page_number in range(MAX_CANDIDATE_PAGES):
        cur.execute(sql, (embedding_str, embedding_str, page_size, page_number * page_size))
        page = cur.fetchall()
        rows.extend(page)
        if len(page) < page_size or distinct_candidate_count(rows) >= num_results:
            break
    return rows


def select_results(rows: list, num_results: int, min_score: float, min_results: int) -> List[Dict[str, Any]]:
    """
    Keep one chunk per source and one row variant per canonical fetched chunk,
    drop rows below `min_score`, cap at `num_results`, and backfill with the
    nearest rows when fewer than `min_results` survive.
    """
    seen_sources = set()
    seen_canonical_content = set()
    results: List[Dict[str, Any]] = []

    def append_row(row) -> bool:
        body, metadata, url, title, source_type, score, source_id = row
        canonical_key = canonical_content_key(metadata)
        if source_id in seen_sources:
            return False
        if canonical_key and canonical_key in seen_canonical_content:
            return False
        seen_sources.add(source_id)
        if canonical_key:
            seen_canonical_content.add(canonical_key)
        results.append(row_to_source(body, metadata, url, title, source_type, score))
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

    return results
