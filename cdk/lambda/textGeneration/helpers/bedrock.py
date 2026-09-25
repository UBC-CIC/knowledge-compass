
import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

def format_context_for_prompt(sources: List[Dict[str, Any]]) -> str:
    if not sources:
        return "No specific documents found."
    parts = []
    for i, source in enumerate(sources, 1):
        title = source.get("title") or source.get("url") or source.get("uri") or "Untitled"
        url = source.get("url") or source.get("uri") or ""
        source_type = source.get("source_type") or source.get("type") or ""
        content = source.get("content") or ""
        header = f"[{i}] {title}"
        if url:
            header += f"\n    URL: {url}"
        if source_type:
            header += f"\n    Type: {source_type}"
        metadata = source.get("metadata") or {}
        # csv_row chunks carry the exact row selected by retrieval. Older
        # canonical csv_link chunks may still carry the aggregate csv_rows key,
        # which remains as a compatibility fallback during rollout.
        csv_row = metadata.get("csv_row") or {}
        if csv_row:
            description = (csv_row.get("description") or "").strip()
            if description:
                header += f"\n    Resource description: {description[:500]}"
            columns = csv_row.get("columns") or {}
            described = ", ".join(f"{key}: {value}" for key, value in columns.items())
            if described:
                header += f"\n    CSV row: {described[:1000]}"
        else:
            csv_rows = metadata.get("csv_rows") or []
            if csv_rows:
                described = "; ".join(
                    ", ".join(f"{key}: {value}" for key, value in (row.get("columns") or {}).items())
                    for row in csv_rows[:3]
                )
                if described:
                    header += f"\n    Linked from CSV row(s): {described[:500]}"
        parts.append(f"<source_{i}>\n{header}\n    Content: {content}\n</source_{i}>")
    return "\n\n".join(parts)
