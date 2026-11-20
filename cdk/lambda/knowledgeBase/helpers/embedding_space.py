"""
Embedding space registry access for the knowledgeBase Lambda (migration 032).

The writers (document, CSV and guideline ingestion) and the re-embed jobs need
to know which embedding space to write to and with which model. This is the
resolve-only counterpart of textGeneration's helpers/embedding_space.py: it has
no cache and no probe, because an ingestion run resolves the space once per
write call and a failure simply fails that run.

An "embedding space" is one model + dimension + version. The single-row
`embedding_active_space` pointer says which space is live; `chunk_embeddings`
holds one vector per (chunk, space), with embed_hash = md5(chunks.embed_text) so
a vector is only trusted while the chunk text it was made from is unchanged.

Never log chunk text. Errors carry codes and space names only.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from kc_shared import embeddings


class EmbeddingSpaceError(RuntimeError):
    """The embedding space is missing or unusable. `code` is stable and safe to log."""

    def __init__(self, code: str, detail: str = ""):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


@dataclass(frozen=True)
class ActiveSpace:
    id: str
    name: str
    provider: str
    invoke_target: str
    dimensions: int
    status: str
    version: str = "1"
    model_id: str = ""
    min_score: Optional[float] = None
    split_threshold: Optional[float] = None
    settings: Dict[str, Any] = field(default_factory=dict)
    cutover_locked: bool = False

    @property
    def spec(self) -> "embeddings.ModelSpec":
        return embeddings.spec_from_row({
            "provider": self.provider,
            "invoke_target": self.invoke_target,
            "dimensions": self.dimensions,
            "settings": self.settings,
        })


_COLUMNS = """
    s.id::text, s.name, s.provider, s.model_id, s.invoke_target, s.dimensions,
    s.version, s.status, s.min_score, s.split_threshold, s.settings"""


def index_name(space_id: str) -> str:
    """Partial HNSW index name; must match `create_space_index` in migration 032."""
    return "idx_ce_hnsw_" + str(space_id).replace("-", "")


def fetch_space(connection, space_id: Optional[str] = None) -> Optional[ActiveSpace]:
    """
    The space behind the `embedding_active_space` pointer, or the space
    `space_id` (any status except `purged`). None when there is no such row.
    SQL errors propagate: callers must not guess a model.
    """
    with connection.cursor() as cursor:
        if space_id is None:
            cursor.execute(
                f"""SELECT {_COLUMNS}, a.cutover_locked
                    FROM embedding_active_space a
                    JOIN embedding_spaces s ON s.id = a.space_id
                    WHERE a.id = 1"""
            )
        else:
            cursor.execute(
                f"""SELECT {_COLUMNS}, COALESCE(a.cutover_locked, false)
                    FROM embedding_spaces s
                    LEFT JOIN embedding_active_space a ON a.id = 1
                    WHERE s.id = %s::uuid AND s.status <> 'purged'""",
                (str(space_id),),
            )
        row = cursor.fetchone()
    if not row:
        return None
    settings = row[10]
    if isinstance(settings, str):
        settings = json.loads(settings)
    return ActiveSpace(
        id=str(row[0]),
        name=row[1],
        provider=row[2],
        model_id=row[3] or "",
        invoke_target=row[4],
        dimensions=int(row[5]),
        version=str(row[6] or "1"),
        status=row[7],
        min_score=float(row[8]) if row[8] is not None else None,
        split_threshold=float(row[9]) if row[9] is not None else None,
        settings=settings if isinstance(settings, dict) else {},
        cutover_locked=bool(row[11]),
    )


def resolve_active_space(connection) -> ActiveSpace:
    """
    The active embedding space for a writer. Raises EmbeddingSpaceError when
    the pointer row is missing or the provider has no adapter; the `spec`
    property raises ValueError for an out-of-range dimension or setting.
    """
    space = fetch_space(connection)
    if space is None:
        raise EmbeddingSpaceError("NO_ACTIVE_SPACE", "embedding_active_space has no row")
    if space.provider not in embeddings.ADAPTERS:
        raise EmbeddingSpaceError("UNKNOWN_PROVIDER", f"{space.name}: {space.provider}")
    try:
        space.spec
    except (ValueError, KeyError, TypeError) as e:
        raise EmbeddingSpaceError("SPEC_INVALID", f"{space.name}: {type(e).__name__}") from e
    return space
