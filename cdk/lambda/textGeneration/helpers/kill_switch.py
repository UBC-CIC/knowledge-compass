"""
Public chat kill switch.

Ops pause public chat by setting the SSM parameter named in
PUBLIC_CHAT_ENABLED_PARAM (/<stack id>/PublicChatEnabled) to "false". Any other
value, a missing env var, or a missing parameter leaves chat enabled.

The value is cached for CACHE_TTL_SECONDS per container, so a flip reaches every
warm Lambda within a minute.

Fails OPEN: an SSM error (outage, throttling, missing permission) is treated as
"enabled" so the switch can never take chat down by itself. Only the error class
name is logged. A failure is not cached, so the next call tries again.
"""

import logging
import os
import time
from typing import Any, Dict

import boto3

logger = logging.getLogger()

CACHE_TTL_SECONDS = 60
_cache: Dict[str, Any] = {"value": None, "at": 0.0}
_clock = time.monotonic  # module-level so tests can replace it
_ssm_client = None


def _get_ssm_client():
    global _ssm_client
    if _ssm_client is None:
        _ssm_client = boto3.client("ssm")
    return _ssm_client


def is_public_chat_enabled() -> bool:
    """True unless the kill switch parameter is explicitly "false"."""
    param_name = os.environ.get("PUBLIC_CHAT_ENABLED_PARAM")
    if not param_name:
        return True

    now = _clock()
    cached = _cache["value"]
    if cached is not None and now - _cache["at"] < CACHE_TTL_SECONDS:
        return cached

    try:
        value = _get_ssm_client().get_parameter(Name=param_name)["Parameter"]["Value"]
    except Exception as e:
        logger.warning("Kill switch read failed, treating public chat as enabled: %s", type(e).__name__)
        return True

    enabled = not (isinstance(value, str) and value.strip().lower() == "false")
    _cache["value"] = enabled
    _cache["at"] = now
    return enabled
