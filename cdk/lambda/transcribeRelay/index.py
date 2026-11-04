"""
Forwards the TranscribeComplete and IngestionTaskStopped EventBridge rules
(cdk/lib/ingestion-stack.ts) to lambdaKnowledgeBase.

lambdaKnowledgeBase runs an aws.transcribe / aws.ecs event only when it carries
the worker invoke token (knowledgeBase/helpers/worker_envelope.py, finding
f-9d5748bc), so a direct invoke of that function cannot forge one. This relay
adds the token, and forwards only the source/detail-type pairs those rules
match and only the id field each handler reads. The token is never logged.
"""

import json
import logging
import os
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TARGET = os.environ["TARGET_FUNCTION_NAME"]
WORKER_INVOKE_SECRET_NAME = os.environ["WORKER_INVOKE_SECRET_NAME"]
INVOKE_TOKEN_FIELD = "invoke_token"
CACHE_TTL_SECONDS = 300

# (source, detail-type) -> the only detail field the knowledge-base handler reads.
FORWARDED_EVENTS = {
    ("aws.transcribe", "Transcribe Job State Change"): "TranscriptionJobName",
    ("aws.ecs", "ECS Task State Change"): "taskArn",
}

lambda_client = boto3.client("lambda")
secrets_client = boto3.client("secretsmanager")

_cached_token = None
_cached_at = 0.0


def _invoke_token():
    """The current worker invoke token, cached. lambdaKnowledgeBase also accepts
    the previous token, so a rotation inside the cache window still verifies."""
    global _cached_token, _cached_at
    if _cached_token and time.monotonic() - _cached_at < CACHE_TTL_SECONDS:
        return _cached_token
    secret = json.loads(secrets_client.get_secret_value(SecretId=WORKER_INVOKE_SECRET_NAME)["SecretString"])
    token = secret.get("token")
    if not isinstance(token, str) or not token:
        raise RuntimeError("worker invoke secret has no token")
    _cached_token, _cached_at = token, time.monotonic()
    return token


def handler(event, context):
    event = event if isinstance(event, dict) else {}
    source, detail_type = event.get("source"), event.get("detail-type")
    id_field = FORWARDED_EVENTS.get((source, detail_type))
    detail = event.get("detail") if isinstance(event.get("detail"), dict) else {}
    value = detail.get(id_field) if id_field else None
    if "requestContext" in event or not isinstance(value, str) or not value:
        logger.warning("Ignoring unsupported event: source=%s detail-type=%s",
                       str(source)[:64], str(detail_type)[:64])
        return {"ok": False, "reason": "unsupported_event"}

    try:
        token = _invoke_token()
    except Exception as e:  # noqa: BLE001 - log the class only, never the secret
        logger.error("Worker invoke secret unavailable: %s", type(e).__name__)
        raise RuntimeError("worker invoke secret unavailable") from None

    lambda_client.invoke(
        FunctionName=TARGET,
        InvocationType="Event",
        Payload=json.dumps({
            "source": source,
            "detail-type": detail_type,
            "detail": {id_field: value},
            INVOKE_TOKEN_FIELD: token,
        }).encode("utf-8"),
    )
    return {"ok": True}
