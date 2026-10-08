"""
Guideline-mode retrieval (migration 031).

Searches only the hidden guideline chunks (sources.metadata.kb_role =
'guideline') of `ready` guideline documents, then expands the best matches to
their full sections so the model sees the whole response pattern, not a
fragment. Standard retrieval (helpers/retrieval.py) is untouched and never
sees these chunks because their sources carry retrieval_hidden = 'true'.

The guideline corpus is small (a few uploaded guides), so the candidate search
is an exact scan over a MATERIALIZED CTE rather than the HNSW index: a
filtered HNSW scan over a tiny subset of a large corpus can return too few
rows, an exact scan cannot.

Returned dicts are compatible with bedrock.format_context_for_prompt,
citations.select_cited_sources and retrieval.to_public_source:
    {type, source_type='guideline', title=<situation label>, url='', uri='',
     content=<full section text>, score, metadata={document_id, section_key,
     heading_path, file_name}}
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from helpers.embedding_space import get_active_space
from helpers.retrieval import EMBED_MODEL_ID, _rollback_quietly, _space_spec, _vector_literal, embed_query
from helpers.retrieval_core import space_literals

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

GUIDELINE_SOURCE_TYPE = "guideline"
DEFAULT_MAX_SECTIONS = 3
DEFAULT_MAX_WORDS = 2500
CANDIDATE_LIMIT = 40
_WINDOW_RE = re.compile(r"^window-(\d+)$")

def build_candidate_sql(space) -> str:
    """
    Candidate query over the guideline chunks' vectors in `space`. The space id
    is inlined as a validated literal and the dimension cast matches the space's
    index expression (see retrieval_core.build_standard_sql). A vector only
    counts when its embed_hash matches the chunk's current embed_text.
    Parameters: query vector (score), query vector (ORDER BY), LIMIT.
    """
    space_uuid, dims = space_literals(space)
    return f"""
    WITH g AS MATERIALIZED (
        SELECT s.metadata->>'guideline_document_id' AS document_id,
               c.metadata->>'section_key'          AS section_key,
               ce.embedding::vector({dims})        AS embedding
        FROM chunks c
        JOIN chunk_embeddings ce
          ON ce.chunk_id = c.id
         AND ce.space_id = '{space_uuid}'
         AND ce.embed_hash = md5(c.embed_text)
        JOIN sources s ON s.id = c.source_id
        JOIN guideline_documents d ON d.id::text = s.metadata->>'guideline_document_id'
        WHERE s.metadata->>'kb_role' = 'guideline'
          AND d.status = 'ready'
    )
    SELECT document_id, section_key, 1 - (embedding <=> %s::vector) AS score
    FROM g
    ORDER BY embedding <=> %s::vector
    LIMIT %s
"""


_SECTION_SQL = """
    SELECT s.metadata->>'guideline_document_id' AS document_id,
           c.metadata->>'section_key'          AS section_key,
           c.chunk_index,
           c.body,
           COALESCE(NULLIF(gs.label_override, ''), gs.auto_label, c.metadata->>'situation_label') AS label,
           COALESCE(gs.heading_path, c.metadata->>'heading_path') AS heading_path,
           d.file_name
    FROM chunks c
    JOIN sources s ON s.id = c.source_id
    JOIN guideline_documents d ON d.id::text = s.metadata->>'guideline_document_id'
    LEFT JOIN guideline_sections gs
           ON gs.document_id = d.id AND gs.section_key = c.metadata->>'section_key'
    WHERE s.metadata->>'kb_role' = 'guideline'
      AND d.status = 'ready'
      AND s.metadata->>'guideline_document_id' = ANY(%s)
      AND c.metadata->>'section_key' = ANY(%s)
    ORDER BY c.chunk_index
"""


def _window_neighbours(section_key: str) -> List[str]:
    """window-N -> [window-(N-1), window-N, window-(N+1)]; other keys unchanged."""
    match = _WINDOW_RE.match(section_key or "")
    if not match:
        return [section_key]
    n = int(match.group(1))
    return [f"window-{i}" for i in (n - 1, n, n + 1) if i >= 1]


def _search_text(query: str, previous_section: Optional[Dict[str, Any]]) -> str:
    label = (previous_section or {}).get("label")
    if label:
        return f"{query}\n\nEarlier in this conversation: {label}"
    return query


def _rank_sections(
    candidates: List[Tuple[Any, ...]],
    previous_section: Optional[Dict[str, Any]],
    max_sections: int,
) -> List[Tuple[Tuple[str, str], float]]:
    """Distinct (document_id, section_key) in score order, previous section first."""
    ranked: List[Tuple[Tuple[str, str], float]] = []
    seen = set()
    prev_key = None
    if previous_section and previous_section.get("document_id") and previous_section.get("section_key"):
        prev_key = (str(previous_section["document_id"]), str(previous_section["section_key"]))

    for document_id, section_key, score in candidates:
        if not document_id or not section_key:
            continue
        key = (str(document_id), str(section_key))
        if key in seen:
            continue
        seen.add(key)
        ranked.append((key, float(score)))

    top = ranked[:max_sections]
    if prev_key and prev_key not in {k for k, _ in top}:
        prev_score = next((s for k, s in ranked if k == prev_key), 0.0)
        top = [(prev_key, prev_score)] + top[: max(max_sections - 1, 0)]
    elif prev_key:
        # Keep the conversation anchored: previous section first.
        top = sorted(top, key=lambda item: item[0] != prev_key)
    return top


def _truncate_words(text: str, max_words: int) -> str:
    words = text.split(" ")
    if len(text.split()) <= max_words:
        return text
    kept, count = [], 0
    for word in words:
        if word.strip():
            count += 1
        if count > max_words:
            break
        kept.append(word)
    return " ".join(kept).rstrip() + " …"


def retrieve_guideline_sections(
    query: str,
    db_connection,
    region: str,
    previous_section: Optional[Dict[str, Any]] = None,
    max_sections: int = DEFAULT_MAX_SECTIONS,
    max_words: int = DEFAULT_MAX_WORDS,
    embed_model_id: str = EMBED_MODEL_ID,
) -> List[Dict[str, Any]]:
    """
    Up to `max_sections` full guideline sections most relevant to `query`,
    capped at `max_words` words in total. The previous turn's section is kept
    (first) while it still exists, so follow-ups like "what next?" stay on it.

    Returns [] on a transient failure so the model falls back to asking a
    clarifying question instead of the turn failing. A missing or inconsistent
    embedding space raises EmbeddingSpaceError instead; it is not swallowed.
    """
    space = get_active_space(db_connection, region=region)
    try:
        embedding = embed_query(
            _search_text(query, previous_section), region, embed_model_id,
            spec=_space_spec(space, embed_model_id),
        )
    except Exception as e:  # noqa: BLE001
        logger.error("Guideline query embedding failed: %s", type(e).__name__)
        return []

    vector = _vector_literal(embedding)
    try:
        with db_connection.cursor() as cur:
            cur.execute(build_candidate_sql(space), (vector, vector, CANDIDATE_LIMIT))
            candidates = cur.fetchall()

            top = _rank_sections(candidates, previous_section, max_sections)
            if not top:
                return []

            document_ids = sorted({doc for (doc, _), _ in top})
            wanted_keys = sorted({k for (_, key), _ in top for k in _window_neighbours(key)})
            cur.execute(_SECTION_SQL, (document_ids, wanted_keys))
            rows = cur.fetchall()
    except Exception as e:  # noqa: BLE001
        logger.error("Guideline retrieval query failed: %s", type(e).__name__)
        _rollback_quietly(db_connection)
        return []

    # (document_id, section_key) -> {"bodies": [(chunk_index, body)], label, heading_path, file_name}
    by_section: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for document_id, section_key, chunk_index, body, label, heading_path, file_name in rows:
        entry = by_section.setdefault((str(document_id), str(section_key)), {
            "bodies": [], "label": label, "heading_path": heading_path or "", "file_name": file_name,
        })
        entry["bodies"].append((int(chunk_index), body or ""))

    results: List[Dict[str, Any]] = []
    budget = max_words
    for (document_id, section_key), score in top:
        keys = _window_neighbours(section_key)
        parts = []
        for k in keys:
            entry = by_section.get((document_id, k))
            if entry:
                parts.extend(body for _, body in sorted(entry["bodies"]))
        main = by_section.get((document_id, section_key))
        if not main or not parts:
            continue  # section no longer exists (e.g. guide replaced)
        if budget <= 0:
            break
        text = "\n\n".join(p.strip() for p in parts if p.strip())
        words = len(text.split())
        if words > budget:
            text = _truncate_words(text, budget)
            words = budget
        budget -= words
        results.append({
            "type": "GUIDELINE",
            "source_type": GUIDELINE_SOURCE_TYPE,
            "title": main["label"] or "Guidance",
            "url": "",
            "uri": "",
            "content": text,
            "score": round(score, 4),
            "metadata": {
                "document_id": document_id,
                "section_key": section_key,
                "heading_path": main["heading_path"],
                "file_name": main["file_name"],
            },
        })

    logger.info("Guideline retrieval: %d section(s)", len(results))
    return results
