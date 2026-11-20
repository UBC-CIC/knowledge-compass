import os
import boto3

# Shared by textGeneration and knowledgeBase through the kc_shared layer.

ALLOW_HEADERS = "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token"

cached_allowed_origins = None


def _get_allowed_origins():
    """Every failure path yields an empty list, which blocks cross-origin reads.
    A wildcard is never honoured, even if someone puts "*" in the parameter."""
    global cached_allowed_origins
    if cached_allowed_origins is not None:
        return cached_allowed_origins
    param_name = os.environ.get('ALLOWED_ORIGIN_PARAM')
    if not param_name:
        print("CRITICAL: ALLOWED_ORIGIN_PARAM is not set — blocking all cross-origin requests")
        return []
    try:
        ssm = boto3.client('ssm')
        response = ssm.get_parameter(Name=param_name)
    except Exception as e:
        print(f"CRITICAL: Failed to fetch CORS origins from SSM — blocking all cross-origin requests: {e}")
        # Do not cache — allow retry on next request once SSM recovers
        return []
    origins = (s.strip().rstrip('/') for s in response['Parameter']['Value'].split(','))
    cached_allowed_origins = [s for s in origins if s and '*' not in s]
    return cached_allowed_origins


def get_cors_headers(event):
    # CORS_ALLOWED_METHODS lists the HTTP methods this function serves (set in
    # api-stack.ts); OPTIONS is always added. Unset advertises OPTIONS only.
    methods = os.environ.get('CORS_ALLOWED_METHODS', '').strip(', ')
    cors_headers = {
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Allow-Methods": f"{methods},OPTIONS" if methods else "OPTIONS",
    }

    headers = (event.get('headers') or {}) if event else {}
    origin = headers.get('origin') or headers.get('Origin')
    if origin and origin in _get_allowed_origins():
        cors_headers["Access-Control-Allow-Origin"] = origin
        cors_headers["Vary"] = "Origin"

    return cors_headers
