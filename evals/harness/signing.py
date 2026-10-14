"""
Eval session tags. Must match cdk/lambda/handlers/utils/evalTag.js:

    sig = hex(HMAC-SHA256(signingKey, f"{user_id}.{run_id}.{mode}.{exp}"))

The key is read from Secrets Manager with the caller's own AWS credentials
and kept in memory only; it is never written to disk or logged.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from typing import Any, Dict, Optional

RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MODES = ("standard", "guideline")
MAX_TAG_LIFETIME_SECONDS = 24 * 60 * 60


def signing_payload(user_id: str, run_id: str, mode: str, exp: int) -> str:
    return f"{user_id}.{run_id}.{mode}.{exp}"


def sign(key: str, user_id: str, run_id: str, mode: str, exp: int) -> str:
    return hmac.new(key.encode("utf-8"), signing_payload(user_id, run_id, mode, exp).encode("utf-8"), hashlib.sha256).hexdigest()


def make_tag(key: str, user_id: str, run_id: str, mode: str, lifetime_seconds: int = 6 * 60 * 60,
             now: Optional[float] = None) -> Dict[str, Any]:
    if not RUN_ID_PATTERN.match(run_id):
        raise ValueError("run_id must match [A-Za-z0-9_-]{1,64}")
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    lifetime = max(60, min(int(lifetime_seconds), MAX_TAG_LIFETIME_SECONDS - 60))
    exp = int(now if now is not None else time.time()) + lifetime
    return {"run_id": run_id, "mode": mode, "exp": exp, "sig": sign(key, user_id, run_id, mode, exp)}


class SigningKeyProvider:
    """Fetches the signing key once per process."""

    def __init__(self, secret_name: str, region: str, secrets_client=None):
        self.secret_name = secret_name
        self.region = region
        self._client = secrets_client
        self._key: Optional[str] = None

    def __repr__(self) -> str:  # never show the key
        return f"SigningKeyProvider(secret_name={self.secret_name!r}, region={self.region!r})"

    def key(self) -> str:
        if self._key is None:
            client = self._client
            if client is None:
                import boto3

                client = boto3.client("secretsmanager", region_name=self.region)
            value = client.get_secret_value(SecretId=self.secret_name)["SecretString"]
            key = json.loads(value).get("signingKey")
            if not isinstance(key, str) or len(key) < 32:
                raise RuntimeError(f"secret {self.secret_name} has no usable signingKey")
            self._key = key
        return self._key
