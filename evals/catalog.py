"""
Journey catalog for label suggestions: the live catalog from GET /admin/journeys
(needs an admin ID token) or the repo fallback DEFAULT_CATALOG in
cdk/lambda/textGeneration/helpers/journeys.py (mirrors the migration 024 seed;
the live catalog may have been edited since).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parent.parent
JOURNEYS_PY = REPO_ROOT / "cdk" / "lambda" / "textGeneration" / "helpers" / "journeys.py"

# [{key, name, description, detection_signals, clusters: [{key, name, matches_when}]}]
Catalog = List[Dict[str, Any]]


def catalog_from_repo(path: Path = JOURNEYS_PY) -> Catalog:
    spec = importlib.util.spec_from_file_location("kc_journeys_catalog", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    out: Catalog = []
    for j in module.DEFAULT_CATALOG.journeys:
        out.append({
            "key": j.key,
            "name": j.name,
            "description": j.description,
            "detection_signals": j.detection_signals,
            "clusters": [{"key": c.key, "name": c.name, "matches_when": c.matches_when} for c in j.clusters],
        })
    return out


def catalog_from_admin_tree(tree: Dict[str, Any]) -> Catalog:
    """Shape a GET /admin/journeys response, dropping archived items."""
    out: Catalog = []
    for j in tree.get("journeys") or []:
        if j.get("is_archived"):
            continue
        out.append({
            "key": j.get("key"),
            "name": j.get("name") or "",
            "description": j.get("description") or "",
            "detection_signals": j.get("detection_signals") or "",
            "clusters": [
                {"key": c.get("key"), "name": c.get("name") or "", "matches_when": c.get("matches_when") or ""}
                for c in (j.get("clusters") or [])
                if not c.get("is_archived")
            ],
        })
    return out


def journey_for_number(catalog: Catalog, number: int, name: str = "") -> Dict[str, Any]:
    """
    Best catalog journey for a document's journey number: key J{number} when
    present, otherwise the closest name by shared words. {} if none.
    """
    by_key = {j["key"]: j for j in catalog}
    if f"J{number}" in by_key:
        return by_key[f"J{number}"]
    words = set(_words(name))
    best, best_score = {}, 0
    for j in catalog:
        score = len(words & set(_words(j["name"] + " " + j.get("description", ""))))
        if score > best_score:
            best, best_score = j, score
    return best


def _words(text: str) -> List[str]:
    return [w for w in "".join(ch.lower() if ch.isalnum() else " " for ch in text).split() if len(w) > 3]


def describe_clusters(journey: Dict[str, Any]) -> str:
    lines = []
    for c in journey.get("clusters") or []:
        matches = " ".join((c.get("matches_when") or "").split())
        lines.append(f"- {c['key']}: {c['name']}. Matches when: {matches}")
    return "\n".join(lines)
