"""
Shared embedding interface for Knowledge Compass.

Every embedding call (query-time retrieval, document ingestion, the crawler and
the transcriber) goes through this module so the rest of the code does not know
which model is in use:

    embed_documents(texts, spec) -> list of vectors   (indexing side)
    embed_query(text, spec)      -> one vector        (search side)

A `ModelSpec` says which provider adapter to use, the Bedrock invoke target
(model id or inference-profile ARN), the vector dimension and the batching /
truncation limits. Model ids and profile ARNs are configuration, not claims of
verified availability in a region.

Packaging
---------
The canonical copy lives in cdk/containers/common/embeddings.py. Byte-identical
mirrors are kept in cdk/lambda/textGeneration/helpers/ and
cdk/lambda/knowledgeBase/helpers/ because the three deployables are packaged
separately. textGeneration/tests/test_shared_module_parity.py fails if the
copies drift. Edit the canonical file, then copy it over the mirrors. This file
imports only the standard library and boto3/botocore so it works in all three
packagings.

Privacy: never log or print input text. Errors carry counts and sizes only.
"""

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, replace
from typing import Any, Dict, FrozenSet, List, Optional

import boto3
from botocore.config import Config

SEARCH_DOCUMENT = "search_document"
SEARCH_QUERY = "search_query"

# Adaptive retry with client-side rate limiting backs off on Bedrock
# ThrottlingException (embedding models are throttled by requests per minute).
CLIENT_CONFIG = Config(retries={"mode": "adaptive", "max_attempts": 10})

# Query-time embedding runs inside a chat turn (60 s Lambda), where waiting on
# long client-side backoff is worse than failing fast. It keeps boto3's own
# default retry behavior (no Config), exactly as before this module existed.
QUERY_CLIENT_CONFIG = None


class EmbeddingError(RuntimeError):
    """An embedding call returned something the caller cannot use."""


class EmbeddingDimensionError(EmbeddingError):
    """A returned vector length did not match ModelSpec.dimensions."""


@dataclass(frozen=True)
class ModelSpec:
    provider: str            # key into ADAPTERS
    invoke_target: str       # Bedrock modelId: model id or inference-profile ARN
    dimensions: int          # expected vector length
    batch_size: int          # max texts per request (Titan sends one text per call)
    max_chars: int           # inputs are cut to this many characters
    concurrency: int = 1     # worker threads for adapters that call once per text
    normalize: bool = True   # Titan V2 only


def truncate_at_word(text: str, max_chars: int) -> str:
    """Cut `text` to at most `max_chars`, at a word boundary when it must cut."""
    if len(text) <= max_chars:
        return text
    return text[:max_chars].rsplit(" ", 1)[0]


# ── Client ────────────────────────────────────────────────────────────────────

_clients: Dict[Any, Any] = {}
_clients_lock = threading.Lock()


def get_bedrock_client(region: Optional[str] = None, fail_fast: bool = False):
    """
    Cached bedrock-runtime client (one per region and retry profile).
    Default: adaptive retries, 10 attempts (ingestion and batch paths).
    `fail_fast=True`: boto3 default retries, for the chat-path query embedding.
    """
    key = (region, fail_fast)
    with _clients_lock:
        client = _clients.get(key)
        if client is None:
            config = QUERY_CLIENT_CONFIG if fail_fast else CLIENT_CONFIG
            client = boto3.client("bedrock-runtime", region_name=region, config=config)
            _clients[key] = client
        return client


def _invoke(client, spec: ModelSpec, body: Dict[str, Any]) -> Dict[str, Any]:
    response = client.invoke_model(
        modelId=spec.invoke_target,
        body=json.dumps(body),
        contentType="application/json",
        accept="application/json",
    )
    return json.loads(response["body"].read())


def _field(result: Any, key: str, spec: ModelSpec) -> Any:
    """Read a response field; a malformed response raises EmbeddingError."""
    if not isinstance(result, dict) or key not in result:
        raise EmbeddingError(f"{spec.provider}: response is missing '{key}'")
    return result[key]


def _check_vectors(vectors: Any, expected_count: int, spec: ModelSpec) -> List[List[float]]:
    if not isinstance(vectors, list) or len(vectors) != expected_count:
        got = len(vectors) if isinstance(vectors, list) else type(vectors).__name__
        raise EmbeddingError(
            f"{spec.provider}: expected {expected_count} embeddings, got {got}"
        )
    for vector in vectors:
        if len(vector) != spec.dimensions:
            raise EmbeddingDimensionError(
                f"{spec.provider}: expected {spec.dimensions}-dim vectors, got {len(vector)}"
            )
    return vectors


# ── Adapters ──────────────────────────────────────────────────────────────────

class EmbeddingAdapter:
    """Provider-specific request/response handling. Texts arrive pre-truncated."""

    provider = ""
    allowed_dimensions: Optional[FrozenSet[int]] = None  # None = not restricted
    max_batch_size: Optional[int] = None                 # None = not restricted
    default_batch_size = 1
    default_max_chars = 2048
    default_concurrency = 1
    supports_input_type = True

    def embed(self, client, texts: List[str], spec: ModelSpec, input_type: str) -> List[List[float]]:
        raise NotImplementedError


class CohereV3Adapter(EmbeddingAdapter):
    """Cohere embed-english-v3. Batches of up to 96; input_type + truncate END."""

    provider = "cohere_v3"
    allowed_dimensions = frozenset({1024})
    max_batch_size = 96  # Cohere v3 API limit per call
    default_batch_size = 96
    default_max_chars = 2048
    default_concurrency = 1
    supports_input_type = True

    def embed(self, client, texts, spec, input_type):
        embeddings: List[List[float]] = []
        for i in range(0, len(texts), spec.batch_size):
            batch = texts[i : i + spec.batch_size]
            result = _invoke(
                client,
                spec,
                {"texts": batch, "input_type": input_type, "truncate": "END"},
            )
            embeddings.extend(_check_vectors(_field(result, "embeddings", spec), len(batch), spec))
        return embeddings


class TitanV2Adapter(EmbeddingAdapter):
    """
    Amazon Titan Text Embeddings V2 (amazon.titan-embed-text-v2:0).

    One `inputText` per invoke_model call, run on a bounded thread pool with
    input order preserved. No input_type: queries and documents share a space.
    UNVERIFIED: the request fields `inputText`, `dimensions` (256/512/1024) and
    `normalize` and the response field `embedding` were not listed on the AWS doc
    page fetched while writing this (titan-embedding-models.html). They match the
    public Titan V2 shape from memory; verify with a live call before registering
    a space on this model. The doc page states the model accepts up to 8,192
    tokens or 50,000 characters; the 8000-char default is a conservative, tunable
    choice (set `max_chars` on the space).
    """

    provider = "titan_v2"
    allowed_dimensions = frozenset({256, 512, 1024})
    default_batch_size = 1
    default_max_chars = 8000
    default_concurrency = 8
    supports_input_type = False

    def _embed_one(self, client, text: str, spec: ModelSpec) -> List[float]:
        result = _invoke(
            client,
            spec,
            {"inputText": text, "dimensions": spec.dimensions, "normalize": spec.normalize},
        )
        vector = _field(result, "embedding", spec)
        if not isinstance(vector, list):
            raise EmbeddingError(f"{spec.provider}: 'embedding' is not a list")
        return vector

    def embed(self, client, texts, spec, input_type):
        if not texts:
            return []
        workers = max(1, min(spec.concurrency, len(texts)))
        if workers == 1:
            vectors = [self._embed_one(client, text, spec) for text in texts]
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                vectors = list(pool.map(lambda text: self._embed_one(client, text, spec), texts))
        return _check_vectors(vectors, len(texts), spec)


class CohereV4Adapter(EmbeddingAdapter):
    """
    Cohere Embed v4 on Bedrock (text-only use).

    Request/response shape per the AWS doc model-parameters-embed-v4.html
    (fetched 2026-10-07; see report-foundations.md):
      * Verified in the doc: text request {"input_type", "texts"}; model id
        "cohere.embed-v4"; output dimensions 256-1536; truncate "RIGHT";
        response {"response_type": "embeddings_floats", "embeddings": [[...]]}
        when no embedding type is requested, and
        {"response_type": "embeddings_by_type", "embeddings": {"float": [[...]]}}
        when embedding_types is sent (doc example uses `inputs` + int8).
      * NOT verified: `embedding_types` / `output_dimension` combined with the
        `texts` form, the ":0" suffix of the model id or inference-profile id,
        the maximum batch size (default 96 is a guess, tune via the space's
        `batch_size`) and the character limit. Both response shapes are parsed.
    The model id is configuration on the space row, not a claim of availability.
    """

    provider = "cohere_v4"
    allowed_dimensions = frozenset({256, 512, 1024, 1536})
    default_batch_size = 96
    default_max_chars = 8000
    default_concurrency = 1
    supports_input_type = True

    def embed(self, client, texts, spec, input_type):
        embeddings: List[List[float]] = []
        for i in range(0, len(texts), spec.batch_size):
            batch = texts[i : i + spec.batch_size]
            result = _invoke(
                client,
                spec,
                {
                    "input_type": input_type,
                    "texts": batch,
                    "embedding_types": ["float"],
                    "output_dimension": spec.dimensions,
                    "truncate": "RIGHT",
                },
            )
            embeddings.extend(_check_vectors(self._parse(result), len(batch), spec))
        return embeddings

    @staticmethod
    def _parse(result: Dict[str, Any]) -> Any:
        vectors = result.get("embeddings")
        if isinstance(vectors, dict):  # embeddings_by_type
            vectors = vectors.get("float")
        return vectors


ADAPTERS: Dict[str, EmbeddingAdapter] = {
    adapter.provider: adapter for adapter in (CohereV3Adapter(), TitanV2Adapter(), CohereV4Adapter())
}

# Today's production behavior: Cohere embed-english-v3, 1024 dims, 96 per call,
# inputs cut to 2048 chars at a word boundary.
DEFAULT_SPEC = ModelSpec("cohere_v3", "cohere.embed-english-v3", 1024, 96, 2048, 1)


def get_adapter(provider: str) -> EmbeddingAdapter:
    try:
        return ADAPTERS[provider]
    except KeyError:
        raise ValueError(f"Unknown embedding provider: {provider!r}") from None


def validate_spec(spec: ModelSpec) -> ModelSpec:
    """Raise ValueError for an unknown provider or out-of-range settings."""
    adapter = get_adapter(spec.provider)
    if not spec.invoke_target:
        raise ValueError("invoke_target is required")
    if adapter.allowed_dimensions is not None and spec.dimensions not in adapter.allowed_dimensions:
        raise ValueError(
            f"{spec.provider} does not support {spec.dimensions} dimensions "
            f"(allowed: {sorted(adapter.allowed_dimensions)})"
        )
    for name in ("batch_size", "max_chars", "concurrency"):
        if int(getattr(spec, name)) < 1:
            raise ValueError(f"{name} must be >= 1")
    if adapter.max_batch_size is not None and spec.batch_size > adapter.max_batch_size:
        raise ValueError(f"{spec.provider} batch_size must be <= {adapter.max_batch_size}")
    return spec


def spec_from_row(row: Dict[str, Any]) -> ModelSpec:
    """
    Build a validated ModelSpec from a registry row: `provider`, `invoke_target`,
    `dimensions` plus an optional `settings` mapping (or JSON string) that may
    override `batch_size`, `max_chars`, `concurrency` and `normalize`. Unset
    values fall back to the provider adapter's defaults.
    """
    adapter = get_adapter(row["provider"])
    settings = row.get("settings") or {}
    if isinstance(settings, str):
        settings = json.loads(settings)
    spec = ModelSpec(
        provider=row["provider"],
        invoke_target=row["invoke_target"],
        dimensions=int(row["dimensions"]),
        batch_size=int(settings.get("batch_size", adapter.default_batch_size)),
        max_chars=int(settings.get("max_chars", adapter.default_max_chars)),
        concurrency=int(settings.get("concurrency", adapter.default_concurrency)),
        normalize=bool(settings.get("normalize", True)),
    )
    return validate_spec(spec)


# ── Public interface ──────────────────────────────────────────────────────────

def embedding_input(text: str, spec: ModelSpec = DEFAULT_SPEC) -> str:
    """The exact text sent for a document; callers use it as the reuse key."""
    return truncate_at_word(text, spec.max_chars)


def embed_texts(
    texts: List[str],
    spec: ModelSpec = DEFAULT_SPEC,
    input_type: str = SEARCH_DOCUMENT,
    region: Optional[str] = None,
    client=None,
) -> List[List[float]]:
    """
    Embed many texts (word-boundary truncation, batched per the adapter).
    `input_type` is `search_document` for indexing or `search_query`; adapters
    without input types (Titan) ignore it. Returns vectors in input order.
    """
    validate_spec(spec)
    if not texts:
        return []
    prepared = [embedding_input(text, spec) for text in texts]
    client = client or get_bedrock_client(region)
    return get_adapter(spec.provider).embed(client, prepared, spec, input_type)


def embed_documents(
    texts: List[str],
    spec: ModelSpec = DEFAULT_SPEC,
    region: Optional[str] = None,
    client=None,
) -> List[List[float]]:
    """Embed document chunks for indexing."""
    return embed_texts(texts, spec, SEARCH_DOCUMENT, region, client)


def embed_query(
    text: str,
    spec: ModelSpec = DEFAULT_SPEC,
    region: Optional[str] = None,
    client=None,
) -> List[float]:
    """
    Embed one search query. The query is cut with a plain slice to
    `spec.max_chars` (no word-boundary trim), exactly as retrieval did before.
    """
    validate_spec(spec)
    client = client or get_bedrock_client(region, fail_fast=True)
    prepared = [text[: spec.max_chars]]
    return get_adapter(spec.provider).embed(client, prepared, spec, SEARCH_QUERY)[0]


def with_invoke_target(spec: ModelSpec, invoke_target: str) -> ModelSpec:
    """Copy of `spec` pointing at a different model id or profile ARN."""
    return replace(spec, invoke_target=invoke_target)
