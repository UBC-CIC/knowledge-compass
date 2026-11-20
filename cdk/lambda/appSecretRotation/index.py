"""
Secrets Manager rotation for the application's generated keys (finding
f-440374a2):

  secret                      key field     previous-key field
  KC-JWTSecret                jwtSecret     previousJwtSecret
  KC-WorkerInvokeSecret       token         previousToken
  eval SigningSecret          signingKey    previousSigningKey

Rotation keeps the outgoing key as the previous key, and every verifier
accepts current or previous (authorizer, WebSocket, credential exchange,
worker envelope, eval tags), so a scheduled rotation invalidates nothing that
is still live. Tokens are only ever signed with the current key. To revoke a
compromised key, rotate twice: the second rotation drops it.

Nothing outside Secrets Manager holds these keys, so setSecret has no work;
testSecret checks the pending value's shape.
"""

import json
import logging

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# key field -> (previous-key field, generated length)
KEY_FIELDS = {
    "jwtSecret": ("previousJwtSecret", 128),
    "token": ("previousToken", 64),
    "signingKey": ("previousSigningKey", 64),
}

_client = None


def _secrets():
    global _client
    if _client is None:
        _client = boto3.client("secretsmanager")
    return _client


def rotate_fields(current: dict, generate) -> dict:
    """The pending secret: each key field gets a new value and its old one moves to previous."""
    fields = [f for f in KEY_FIELDS if isinstance(current.get(f), str) and current[f]]
    if not fields:
        raise ValueError("secret has no rotatable key field")
    pending = dict(current)
    for field in fields:
        previous_field, length = KEY_FIELDS[field]
        pending[previous_field] = current[field]
        pending[field] = generate(length)
    return pending


def check_pending(pending: dict) -> None:
    for field, (previous_field, _) in KEY_FIELDS.items():
        if field not in pending:
            continue
        if not isinstance(pending[field], str) or len(pending[field]) < 32:
            raise ValueError(f"pending {field} is missing or too short")
        if pending[field] == pending.get(previous_field):
            raise ValueError(f"pending {field} equals the previous key")


def _generate(length: int) -> str:
    return _secrets().get_random_password(PasswordLength=length, ExcludePunctuation=True)["RandomPassword"]


def _create(arn: str, token: str) -> None:
    client = _secrets()
    try:
        client.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")
        return  # a retried createSecret: the pending version already exists
    except client.exceptions.ResourceNotFoundException:
        pass
    current = json.loads(client.get_secret_value(SecretId=arn, VersionStage="AWSCURRENT")["SecretString"])
    pending = rotate_fields(current, _generate)
    client.put_secret_value(
        SecretId=arn, ClientRequestToken=token, SecretString=json.dumps(pending), VersionStages=["AWSPENDING"]
    )


def _test(arn: str, token: str) -> None:
    secret = _secrets().get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")
    check_pending(json.loads(secret["SecretString"]))


def _finish(arn: str, token: str, versions: dict) -> None:
    current_version = next((v for v, stages in versions.items() if "AWSCURRENT" in stages), None)
    if current_version == token:
        return
    _secrets().update_secret_version_stage(
        SecretId=arn, VersionStage="AWSCURRENT", MoveToVersionId=token, RemoveFromVersionId=current_version
    )


def handler(event, context=None):
    arn = event["SecretId"]
    token = event["ClientRequestToken"]
    step = event["Step"]
    # Never log secret values; the ARN and step are enough to follow a rotation.
    logger.info("Rotation step %s for %s", step, arn)

    metadata = _secrets().describe_secret(SecretId=arn)
    if not metadata.get("RotationEnabled"):
        raise ValueError("rotation is not enabled for this secret")
    versions = metadata.get("VersionIdsToStages") or {}
    if token not in versions:
        raise ValueError("rotation token is not a version of this secret")
    if "AWSCURRENT" in versions[token]:
        return
    if "AWSPENDING" not in versions[token]:
        raise ValueError("rotation token is not pending")

    if step == "createSecret":
        _create(arn, token)
    elif step == "setSecret":
        pass
    elif step == "testSecret":
        _test(arn, token)
    elif step == "finishSecret":
        _finish(arn, token, versions)
    else:
        raise ValueError(f"unknown rotation step {step}")
