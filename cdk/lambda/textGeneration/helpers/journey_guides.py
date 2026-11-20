"""
Ready guide documents attached to journeys (migration 042).

A journey may have many documents. Chat uses this to decide which typed
journey text to keep and which document ids to search. A missing table or a
failed query yields an empty coverage map so the typed prompts still work.
"""

import logging
from typing import Any, Dict, List, Optional

from helpers.prompt_data import neutralize_tags

logger = logging.getLogger(__name__)

_UNCLEAR = frozenset({None, "", "UNCLEAR", "BOTH"})


def situation_name(heading_path: Optional[str], section_key: Optional[str] = "") -> str:
    """Last heading segment, used to match a typed situation to a document section."""
    heading = (heading_path or "").strip()
    if not heading:
        heading = (section_key or "").strip()
    if " > " in heading:
        heading = heading.split(" > ")[-1]
    return " ".join(heading.casefold().split())


def fetch_journey_coverage(db_connection) -> Dict[str, Dict[str, Any]]:
    """
    journey key -> {
      document_ids: [uuid, ...],
      sections: [{section_key, heading_path, label, name}],
      names: set of situation names,
    }

    Only ready documents attached to an active journey.
    """
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                """
                SELECT j.key, d.id::text, s.section_key, s.heading_path,
                       COALESCE(NULLIF(s.label_override, ''), s.auto_label, '')
                FROM guideline_documents d
                JOIN journeys j ON j.id = d.journey_id
                LEFT JOIN guideline_sections s ON s.document_id = d.id
                WHERE d.status = 'ready' AND j.is_archived = false
                ORDER BY j.sort_order, j.key, d.created_at, d.id, s.sort_order, s.section_key
                """
            )
            rows = cur.fetchall()
    except Exception as e:  # noqa: BLE001
        logger.error("fetch_journey_coverage failed: %s", type(e).__name__)
        try:
            db_connection.rollback()
        except Exception:  # noqa: BLE001
            pass
        return {}

    coverage: Dict[str, Dict[str, Any]] = {}
    for journey_key, document_id, section_key, heading_path, label in rows:
        info = coverage.setdefault(journey_key, {"document_ids": [], "sections": [], "names": set()})
        if document_id not in info["document_ids"]:
            info["document_ids"].append(document_id)
        if not section_key:
            continue
        name = situation_name(heading_path, section_key)
        info["sections"].append({
            "section_key": section_key,
            "heading_path": heading_path or "",
            "label": label or name,
            "name": name,
        })
        if name:
            info["names"].add(name)
    return coverage


def document_ids_for_turn(route: Any, coverage: Dict[str, Dict[str, Any]]) -> List[str]:
    """
    Document ids to search on a guidance turn.

    A known journey searches only its own documents (empty when it has none).
    An unclear route searches every journey's documents.
    """
    if not coverage:
        return []
    journey_key = getattr(route, "journey", None) if route is not None else None
    if journey_key in coverage:
        return list(coverage[journey_key]["document_ids"])
    if journey_key in _UNCLEAR:
        ids: List[str] = []
        seen = set()
        for info in coverage.values():
            for document_id in info["document_ids"]:
                if document_id not in seen:
                    seen.add(document_id)
                    ids.append(document_id)
        return ids
    return []


def outlines_for(coverage: Dict[str, Dict[str, Any]]) -> Dict[str, str]:
    """Short situation list inserted into the detective block for each covered journey."""
    outlines = {}
    for key, info in coverage.items():
        labels = [s.get("label") or s.get("name") or "Guidance" for s in info.get("sections") or []]
        if not labels:
            continue
        lines = ["  Situations in the uploaded guides:"]
        # Labels come from uploaded guide headings: third-party text that must
        # not close the <journeys> block (finding f-26eea3ab).
        lines.extend(f"    - {neutralize_tags(str(label))}" for label in labels)
        outlines[key] = "\n".join(lines)
    return outlines
