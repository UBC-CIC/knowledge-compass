"""
One bedrock-runtime client per region, reused across calls and warm Lambda
invocations. Building a client loads the service model, resolves credentials
and opens a new HTTPS connection, and one answer makes up to 10 guardrail
calls plus the router, generation, grounding and title calls.

botocore clients are thread-safe, so sharing one is fine. Embeddings keep
their own client in kc_shared/embeddings.py (adaptive retries).

Timeouts and retries are explicit because the text generation Lambda has a
60 s budget for the whole turn (router, generation, guardrail, grounding and
title calls). boto3's defaults (60 s read timeout, legacy mode with 5
attempts) let one slow or throttled call use that budget up, so the Lambda
timed out before the handler could send an `error` event or release the
user's in-flight generation slot. read_timeout is the longest wait for the
next bytes, so it also bounds a stalled ConverseStream.
"""

import threading

import boto3
from botocore.config import Config

CLIENT_CONFIG = Config(
    connect_timeout=5,
    read_timeout=20,
    retries={"mode": "standard", "max_attempts": 2},
)

_clients = {}
_lock = threading.Lock()


def bedrock_runtime(region):
    client = _clients.get(region)
    if client is None:
        with _lock:
            client = _clients.get(region)
            if client is None:
                client = boto3.client("bedrock-runtime", region_name=region, config=CLIENT_CONFIG)
                _clients[region] = client
    return client
