"""
One bedrock-runtime client per region, reused across calls and warm Lambda
invocations. Building a client loads the service model, resolves credentials
and opens a new HTTPS connection, and one answer makes up to 10 guardrail
calls plus the router, generation, grounding and title calls.

botocore clients are thread-safe, so sharing one is fine. The settings are
boto3's defaults, the same as the per-call clients this replaces. Embeddings
keep their own client in kc_shared/embeddings.py (adaptive retries).
"""

import threading

import boto3

_clients = {}
_lock = threading.Lock()


def bedrock_runtime(region):
    client = _clients.get(region)
    if client is None:
        with _lock:
            client = _clients.get(region)
            if client is None:
                client = boto3.client("bedrock-runtime", region_name=region)
                _clients[region] = client
    return client
