"""
Authenticated envelope for lambdaKnowledgeBase self-invocations (finding
f-7f03f151).

Every async worker payload ({"task": ...}) is serialized through
worker_payload, which adds "invoke_token": a generated secret kept in Secrets
Manager (WORKER_INVOKE_SECRET_ARN) that only the knowledgeBase execution role
and transcribeRelay can read. main.handler calls verify_worker_event before
dispatching any task or aws.transcribe / aws.ecs event (the relay adds the
token to those, finding f-9d5748bc), so holding lambda:InvokeFunction alone is
not enough to rewrite the corpus, move the embedding pointer, or forge an
EventBridge event.

The secret is rotated by appSecretRotation, which keeps the outgoing token as
"previousToken": payloads are signed with the current token and either is
accepted, so a rotation does not fail workers already in flight. The secret is
cached for CACHE_TTL_SECONDS, and a token matching neither cached value
refetches it (at most every REFRESH_MIN_INTERVAL_SECONDS) in case it just
rotated. The token is never logged; failures log the error class only.
"""

import hmac
import json
import logging
import os
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

INVOKE_TOKEN_FIELD = "invoke_token"
CACHE_TTL_SECONDS = 300
REFRESH_MIN_INTERVAL_SECONDS = 30

_cached_tokens: list[str] | None = None
_cached_at = 0.0
_secrets_client = None


def _secrets_manager():
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager", region_name=os.environ.get("REGION"))
    return _secrets_client


def _invoke_tokens(refresh: bool = False) -> list[str]:
    """[current, previous] invoke tokens from Secrets Manager, cached."""
    global _cached_tokens, _cached_at
    age = time.monotonic() - _cached_at
    if _cached_tokens and age < CACHE_TTL_SECONDS and not (refresh and age > REFRESH_MIN_INTERVAL_SECONDS):
        return _cached_tokens
    secret_arn = os.environ.get("WORKER_INVOKE_SECRET_ARN")
    if not secret_arn:
        raise RuntimeError("worker invoke secret is not configured")
    secret = json.loads(_secrets_manager().get_secret_value(SecretId=secret_arn)["SecretString"])
    token = secret.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("worker invoke secret has no token")
    previous = secret.get("previousToken")
    _cached_tokens = [token] + ([previous] if isinstance(previous, str) and previous else [])
    _cached_at = time.monotonic()
    return _cached_tokens


def _invoke_token() -> str:
    """The current invoke token, which every outgoing payload carries."""
    return _invoke_tokens()[0]


def _matches(provided: str, tokens: list[str]) -> bool:
    # Compare against every token, so timing does not tell which one matched.
    results = [hmac.compare_digest(provided.encode("utf-8"), t.encode("utf-8")) for t in tokens]
    return any(results)


def worker_payload(payload: dict) -> bytes:
    """Lambda Invoke `Payload` bytes for `payload` plus the invoke token. Does not mutate `payload`."""
    return json.dumps({**payload, INVOKE_TOKEN_FIELD: _invoke_token()}).encode("utf-8")


def verify_worker_event(event) -> bool:
    """True only when the event carries the current or previous invoke token (constant-time compare)."""
    provided = (event or {}).get(INVOKE_TOKEN_FIELD)
    if not isinstance(provided, str) or not provided:
        return False
    try:
        return _matches(provided, _invoke_tokens()) or _matches(provided, _invoke_tokens(refresh=True))
    except Exception as e:  # noqa: BLE001 - fail closed on any secret error
        logger.error("Worker invoke secret unavailable: %s", type(e).__name__)
        return False
