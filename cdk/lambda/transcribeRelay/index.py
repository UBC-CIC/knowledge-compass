"""
Forwards the TranscribeComplete and IngestionTaskStopped EventBridge rules
(cdk/lib/ingestion-stack.ts) to lambdaKnowledgeBase.

lambdaKnowledgeBase runs an aws.transcribe / aws.ecs event only when it carries
the worker invoke token (knowledgeBase/helpers/worker_envelope.py, finding
f-9d5748bc), so a direct invoke of that function cannot forge one. This relay
adds the token, and forwards only the source/detail-type pairs those rules
match and only the id field each handler reads. The token is never logged.

Before the token is read (finding f-0ddd7657), the event must also name this
function's own account and region, and its id must have the shape the app
creates: a task ARN on this deployment's ingestion cluster, or a Transcribe
job name from video_transcription.start_transcription_job. Anything else is
dropped, so a caller that can invoke the relay directly cannot get the token
attached to an arbitrary id.
"""

import json
import logging
import os
import re
import time

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TARGET = os.environ["TARGET_FUNCTION_NAME"]
WORKER_INVOKE_SECRET_NAME = os.environ["WORKER_INVOKE_SECRET_NAME"]
ECS_CLUSTER_NAME = os.environ["ECS_CLUSTER_NAME"]
INVOKE_TOKEN_FIELD = "invoke_token"
CACHE_TTL_SECONDS = 300

# (source, detail-type) -> the only detail field the knowledge-base handler reads.
FORWARDED_EVENTS = {
    ("aws.transcribe", "Transcribe Job State Change"): "TranscriptionJobName",
    ("aws.ecs", "ECS Task State Change"): "taskArn",
}

# Must match knowledgeBase/helpers/video_transcription.start_transcription_job.
TRANSCRIBE_JOB_NAME_RE = re.compile(r"kc-video-[0-9a-f]{32}")
# arn:<partition>:lambda:<region>:<account>:function:<name>[:<qualifier>]
_FUNCTION_ARN_RE = re.compile(r"arn:(aws[a-z-]*):lambda:([a-z0-9-]+):(\d{12}):function:[^:]+(?::[^:]+)?")

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


def _own_location(context):
    """(partition, region, account) of this function, from its invoked ARN, or None."""
    arn = getattr(context, "invoked_function_arn", None)
    match = _FUNCTION_ARN_RE.fullmatch(arn) if isinstance(arn, str) else None
    return match.groups() if match else None


def _valid_id(id_field, value, partition, region, account):
    """The id has the shape this deployment creates."""
    if id_field == "TranscriptionJobName":
        return TRANSCRIBE_JOB_NAME_RE.fullmatch(value) is not None
    task_arn = (
        rf"arn:{re.escape(partition)}:ecs:{re.escape(region)}:{account}:"
        rf"task/{re.escape(ECS_CLUSTER_NAME)}/[0-9a-f]{{32}}"
    )
    return re.fullmatch(task_arn, value) is not None


def _ignore(source, detail_type):
    logger.warning("Ignoring unsupported event: source=%s detail-type=%s",
                   str(source)[:64], str(detail_type)[:64])
    return {"ok": False, "reason": "unsupported_event"}


def handler(event, context):
    event = event if isinstance(event, dict) else {}
    source, detail_type = event.get("source"), event.get("detail-type")
    id_field = FORWARDED_EVENTS.get((source, detail_type))
    detail = event.get("detail") if isinstance(event.get("detail"), dict) else {}
    value = detail.get(id_field) if id_field else None
    if "requestContext" in event or not isinstance(value, str) or not value:
        return _ignore(source, detail_type)

    location = _own_location(context)
    if location is None:
        return _ignore(source, detail_type)
    partition, region, account = location
    if event.get("account") != account or event.get("region") != region:
        return _ignore(source, detail_type)
    if not _valid_id(id_field, value, partition, region, account):
        return _ignore(source, detail_type)

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
