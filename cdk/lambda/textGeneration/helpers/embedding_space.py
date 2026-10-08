"""
The embedding space retrieval reads from, with fail-loud consistency checks.

An "embedding space" (migration 032) is one model + dimension + version. The
single-row `embedding_active_space` pointer says which space chat retrieval
uses. Query vectors must come from the same model as the stored vectors, so
this module refuses to serve (EmbeddingSpaceError) instead of quietly answering
from a mismatched space.

check_space runs on cold start and whenever the cached space is refreshed:

  1. the space exists, and has a usable status (the pointer's space must be
     `active`; an explicit override may be active/validated/building)
  2. its provider has an adapter and the dimension is one that adapter allows
  3. its partial HNSW index exists
  4. a cheap probe embedding returns a vector of the configured dimension
     (skipped when the same space/version/target probed fine in the last 15 min)

On failure it logs ERROR with the space NAME and a failure code only (never any
text), emits a CloudWatch Embedded Metric Format line (namespace
KnowledgeCompass/Embeddings, metric EmbeddingSpaceCheckFailed, dimension Code;
alarmed in api-stack.ts) and raises EmbeddingSpaceError.

Caching: the active space is cached for 60 s per container (CACHE_TTL_SECONDS),
so a pointer flip reaches every container within a minute. A failed check is
remembered for only 15 s (FAILURE_CACHE_SECONDS) so a broken space does not
re-probe Bedrock on every chat turn but recovery after a fix or rollback is
quick. An explicit `space_id` override is never cached. If the registry cannot
be read during a refresh (transient database error) the previous good space is
kept for another interval rather than failing chat; with nothing cached the
call fails loud.
"""

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from helpers import crud, embeddings

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

CACHE_TTL_SECONDS = 60
FAILURE_CACHE_SECONDS = 15
PROBE_REUSE_SECONDS = 15 * 60
PROBE_TEXT = "health check"
METRIC_NAMESPACE = "KnowledgeCompass/Embeddings"
METRIC_NAME = "EmbeddingSpaceCheckFailed"
OVERRIDE_STATUSES = ("active", "validated", "building")


class EmbeddingSpaceError(RuntimeError):
    """The embedding space is missing, inconsistent or unusable. `code` is stable and safe to log."""

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

    @classmethod
    def from_row(cls, row: Dict[str, Any]) -> "ActiveSpace":
        return cls(
            id=str(row["id"]),
            name=row["name"],
            provider=row["provider"],
            invoke_target=row["invoke_target"],
            dimensions=int(row["dimensions"]),
            status=row["status"],
            version=str(row.get("version") or "1"),
            model_id=row.get("model_id") or "",
            min_score=row.get("min_score"),
            split_threshold=row.get("split_threshold"),
            settings=row.get("settings") or {},
            cutover_locked=bool(row.get("cutover_locked")),
        )


def index_name(space_id: str) -> str:
    """Partial HNSW index name; must match `create_space_index` in migration 032."""
    return "idx_ce_hnsw_" + str(space_id).replace("-", "")


# ── Failure reporting ─────────────────────────────────────────────────────────

def emit_check_failed_metric(code: str) -> None:
    """
    CloudWatch Embedded Metric Format line on stdout (Lambda ships it to
    CloudWatch Logs, which extracts the metric; no PutMetricData call). Printed
    rather than logged because EMF must be the whole log line. The empty
    dimension set publishes an un-dimensioned aggregate the alarm uses.
    """
    print(json.dumps({
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [{
                "Namespace": METRIC_NAMESPACE,
                "Dimensions": [["Code"], []],
                "Metrics": [{"Name": METRIC_NAME, "Unit": "Count"}],
            }],
        },
        "Code": code,
        METRIC_NAME: 1,
    }))


def _fail(code: str, space_name: str, detail: str = "") -> EmbeddingSpaceError:
    logger.error("Embedding space check failed: space=%s code=%s", space_name or "-", code)
    emit_check_failed_metric(code)
    return EmbeddingSpaceError(code, detail)


# ── Checks ────────────────────────────────────────────────────────────────────

class _State:
    def __init__(self):
        self.reset()

    def reset(self):
        self.space: Optional[ActiveSpace] = None
        self.checked_at: float = 0.0
        self.error: Optional[EmbeddingSpaceError] = None
        self.error_at: float = 0.0
        self.probe_key = None
        self.probe_at: float = 0.0


_state = _State()


def reset_cache() -> None:
    """Forget the cached space and probe result (tests, rollback tooling)."""
    _state.reset()


def _index_exists(db_connection, space: ActiveSpace) -> bool:
    try:
        with db_connection.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM pg_indexes WHERE tablename = 'chunk_embeddings' AND indexname = %s",
                (index_name(space.id),),
            )
            return cur.fetchone() is not None
    except Exception as e:  # noqa: BLE001
        try:
            db_connection.rollback()
        except Exception:  # noqa: BLE001
            pass
        raise _fail("INDEX_CHECK_FAILED", space.name, type(e).__name__) from e


def check_space(db_connection, space: ActiveSpace, *, override: bool = False, region: Optional[str] = None) -> None:
    """Raise EmbeddingSpaceError unless `space` is consistent and usable (see module docstring)."""
    if override:
        if space.status not in OVERRIDE_STATUSES:
            raise _fail("SPACE_STATUS_INVALID", space.name, f"status {space.status}")
    elif space.status != "active":
        raise _fail("SPACE_NOT_ACTIVE", space.name, f"status {space.status}")

    adapter = embeddings.ADAPTERS.get(space.provider)
    if adapter is None:
        raise _fail("UNKNOWN_PROVIDER", space.name, space.provider)
    if adapter.allowed_dimensions is not None and space.dimensions not in adapter.allowed_dimensions:
        raise _fail("DIMENSION_NOT_ALLOWED", space.name, f"{space.provider} dimension {space.dimensions}")
    try:
        spec = space.spec
    except (ValueError, KeyError, TypeError) as e:
        raise _fail("SPEC_INVALID", space.name, type(e).__name__) from e

    if not _index_exists(db_connection, space):
        raise _fail("INDEX_MISSING", space.name, index_name(space.id))

    key = (space.id, space.version, space.invoke_target, space.dimensions)
    now = time.monotonic()
    if _state.probe_key == key and now - _state.probe_at < PROBE_REUSE_SECONDS:
        return
    try:
        vector = embeddings.embed_query(PROBE_TEXT, spec, region)
    except Exception as e:  # noqa: BLE001
        raise _fail("PROBE_FAILED", space.name, type(e).__name__) from e
    if len(vector) != space.dimensions:
        raise _fail("PROBE_DIMENSION_MISMATCH", space.name, f"expected {space.dimensions}, got {len(vector)}")
    _state.probe_key = key
    _state.probe_at = now


def _load_space(db_connection, space_id: Optional[str]) -> Optional[ActiveSpace]:
    row = crud.fetch_active_space(db_connection, space_id)
    return ActiveSpace.from_row(row) if row else None


def get_active_space(
    db_connection,
    *,
    force: bool = False,
    space_id: Optional[str] = None,
    region: Optional[str] = None,
) -> ActiveSpace:
    """
    The checked active space (cached 60 s), or the checked space `space_id`
    (never cached, used by validation to search a space that is not active yet).
    Raises EmbeddingSpaceError; callers on the chat path must not swallow it.
    """
    if space_id is not None:
        try:
            space = _load_space(db_connection, space_id)
        except Exception as e:  # noqa: BLE001
            raise _fail("REGISTRY_UNREADABLE", "-", type(e).__name__) from e
        if space is None:
            raise _fail("SPACE_NOT_FOUND", "-")
        check_space(db_connection, space, override=True, region=region)
        return space

    now = time.monotonic()
    if not force:
        if _state.space is not None and now - _state.checked_at < CACHE_TTL_SECONDS:
            return _state.space
        if _state.error is not None and now - _state.error_at < FAILURE_CACHE_SECONDS:
            # A fresh exception each time keeps tracebacks from piling up.
            raise EmbeddingSpaceError(_state.error.code, _state.error.detail)

    try:
        space = _load_space(db_connection, None)
    except Exception as e:  # noqa: BLE001
        if _state.space is not None:
            logger.warning("Embedding space registry unreadable (%s); keeping the previous space", type(e).__name__)
            _state.checked_at = now - CACHE_TTL_SECONDS + FAILURE_CACHE_SECONDS
            return _state.space
        error = _fail("REGISTRY_UNREADABLE", "-", type(e).__name__)
        _state.error, _state.error_at = error, now
        raise error from e

    try:
        if space is None:
            raise _fail("NO_ACTIVE_SPACE", "-", "embedding_active_space has no row")
        check_space(db_connection, space, region=region)
    except EmbeddingSpaceError as error:
        _state.space, _state.error, _state.error_at = None, error, now
        raise

    _state.space, _state.checked_at, _state.error = space, now, None
    return space
