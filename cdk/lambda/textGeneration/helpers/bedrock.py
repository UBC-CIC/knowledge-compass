
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
        # Pages/PDFs linked from a CSV carry the linking rows' other columns.
        csv_rows = (source.get("metadata") or {}).get("csv_rows") or []
        if csv_rows:
            described = "; ".join(
                ", ".join(f"{k}: {v}" for k, v in (row.get("columns") or {}).items())
                for row in csv_rows[:3]
            )
            if described:
                header += f"\n    Linked from CSV row(s): {described[:500]}"
        parts.append(f"<source_{i}>\n{header}\n    Content: {content}\n</source_{i}>")
    return "\n\n".join(parts)
