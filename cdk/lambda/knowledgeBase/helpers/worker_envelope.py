"""
Authenticated envelope for lambdaKnowledgeBase self-invocations (finding
f-7f03f151).

Every async worker payload ({"task": ...}) is serialized through
worker_payload, which adds "invoke_token": a generated secret kept in Secrets
Manager (WORKER_INVOKE_SECRET_ARN) that only the knowledgeBase execution role
can read. main.handler calls verify_worker_event before dispatching any task,
so holding lambda:InvokeFunction alone is not enough to rewrite the corpus or
move the embedding pointer.

The token is read on first use and cached for the container lifetime. It is
never logged; failures log the error class only.
"""

import hmac
import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

INVOKE_TOKEN_FIELD = "invoke_token"

_cached_token: str | None = None
_secrets_client = None


def _secrets_manager():
    global _secrets_client
    if _secrets_client is None:
        _secrets_client = boto3.client("secretsmanager", region_name=os.environ.get("REGION"))
    return _secrets_client


def _invoke_token() -> str:
    """The shared invoke token; read once from Secrets Manager, then cached."""
    global _cached_token
    if _cached_token:
        return _cached_token
    secret_arn = os.environ.get("WORKER_INVOKE_SECRET_ARN")
    if not secret_arn:
        raise RuntimeError("worker invoke secret is not configured")
    secret_string = _secrets_manager().get_secret_value(SecretId=secret_arn)["SecretString"]
    token = json.loads(secret_string).get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("worker invoke secret has no token")
    _cached_token = token
    return token


def worker_payload(payload: dict) -> bytes:
    """Lambda Invoke `Payload` bytes for `payload` plus the invoke token. Does not mutate `payload`."""
    return json.dumps({**payload, INVOKE_TOKEN_FIELD: _invoke_token()}).encode("utf-8")


def verify_worker_event(event) -> bool:
    """True only when the event carries the invoke token (constant-time compare)."""
    provided = (event or {}).get(INVOKE_TOKEN_FIELD)
    if not isinstance(provided, str) or not provided:
        return False
    try:
        expected = _invoke_token()
    except Exception as e:  # noqa: BLE001 - fail closed on any secret error
        logger.error("Worker invoke secret unavailable: %s", type(e).__name__)
        return False
    return hmac.compare_digest(provided.encode("utf-8"), expected.encode("utf-8"))
