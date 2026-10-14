"""
Harness settings, from environment variables (optionally loaded from an env
file such as evals/.env, which .gitignore already excludes). Nothing here is
account-specific; endpoints and ARNs always come from the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

DEFAULT_SIMULATOR_MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
DEFAULT_JUDGE_MODEL = "us.anthropic.claude-opus-4-6-v1"
DEFAULT_EXTRACT_MODEL = "us.anthropic.claude-sonnet-4-6"


def load_env_file(path: Optional[str]) -> Dict[str, str]:
    """Read KEY=VALUE lines into os.environ (existing variables win)."""
    loaded: Dict[str, str] = {}
    if not path:
        return loaded
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"env file not found: {path}")
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
            loaded[key] = value
    return loaded


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    api_url: str = ""
    ws_url: str = ""
    aws_region: str = "ca-central-1"
    secret_name: str = "KC/eval/signing-secret"
    bedrock_region: str = "us-west-2"
    simulator_model: str = DEFAULT_SIMULATOR_MODEL
    judge_model: str = DEFAULT_JUDGE_MODEL
    extract_model: str = DEFAULT_EXTRACT_MODEL
    eval_bucket: str = ""
    eval_role_arn: str = ""
    eval_job_region: str = ""
    admin_id_token: str = field(default="", repr=False)
    turn_delay: float = 2.0
    user_delay: float = 5.0
    response_timeout: float = 120.0
    max_turns: int = 8

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ.get
        return cls(
            api_url=(env("KC_API_URL") or "").rstrip("/"),
            ws_url=(env("KC_WS_URL") or "").rstrip("/"),
            aws_region=env("KC_AWS_REGION") or env("AWS_REGION") or "ca-central-1",
            secret_name=env("KC_EVAL_SECRET_NAME") or "KC/eval/signing-secret",
            bedrock_region=env("KC_BEDROCK_REGION") or "us-west-2",
            simulator_model=env("KC_SIMULATOR_MODEL") or DEFAULT_SIMULATOR_MODEL,
            judge_model=env("KC_JUDGE_MODEL") or DEFAULT_JUDGE_MODEL,
            extract_model=env("KC_EXTRACT_MODEL") or DEFAULT_EXTRACT_MODEL,
            eval_bucket=env("KC_EVAL_BUCKET") or "",
            eval_role_arn=env("KC_EVAL_ROLE_ARN") or "",
            eval_job_region=env("KC_EVAL_JOB_REGION") or "",
            admin_id_token=env("KC_ADMIN_ID_TOKEN") or "",
            turn_delay=_float("KC_TURN_DELAY_SECONDS", 2.0),
            user_delay=_float("KC_USER_DELAY_SECONDS", 5.0),
            response_timeout=_float("KC_RESPONSE_TIMEOUT_SECONDS", 120.0),
            max_turns=_int("KC_MAX_TURNS", 8),
        )

    def require(self, *names: str) -> None:
        missing = [n for n in names if not getattr(self, n)]
        if missing:
            env_names = {
                "api_url": "KC_API_URL", "ws_url": "KC_WS_URL", "eval_bucket": "KC_EVAL_BUCKET",
                "eval_role_arn": "KC_EVAL_ROLE_ARN", "admin_id_token": "KC_ADMIN_ID_TOKEN",
            }
            raise SystemExit("missing settings: " + ", ".join(env_names.get(n, n) for n in missing))
