#!/usr/bin/env python3
"""
Shared, secret-free database + AWS configuration for the Inclusion Canada
RAG ingestion prototypes (crawler + transcriber).

Design goals
------------
- NO credentials or endpoints in source code. Everything comes from the
  environment (or is generated at runtime via RDS IAM auth).
- One consistent connection path for the crawler, the transcriber, and any
  local/SageMaker tooling.

Credential resolution (in priority order)
-----------------------------------------
1. RDS IAM auth  (DB_AUTH=iam, default)   -> boto3 generates a short-lived
   token via `rds.generate_db_auth_token`. No stored secret. Preferred.
2. Secrets Manager (DB_AUTH=secret)       -> reads the password from the
   secret named in DB_SECRET_NAME (JSON with a "password" key, or a raw string).
3. Plain env var (DB_AUTH=password)       -> uses DB_PASSWORD directly. Intended
   for throwaway local dev only.

Environment variables
----------------------
Required:
  DB_HOST         RDS / RDS Proxy endpoint hostname
  DB_NAME         Database name
  DB_USER         Database user (must map to an IAM-auth DB role for iam mode)

Optional:
  AWS_REGION / REGION   AWS region (default: us-east-1)
  DB_PORT               Database port (default: 5432)
  DB_AUTH               iam | secret | password (default: iam)
  DB_SSLMODE            libpq sslmode (default: verify-full)
  DB_SSL_ROOT_CERT      CA bundle for verify-ca/verify-full (default: unset, which
                        makes libpq look for ~/.postgresql/root.crt -- NOT the OS
                        trust store). Connecting through RDS Proxy: point this at
                        the OS bundle (e.g. /etc/ssl/certs/ca-certificates.crt),
                        since RDS Proxy serves an ACM certificate, not an rds-ca-*
                        one -- the RDS CA bundle will fail verify-full against it.
  DB_SECRET_NAME        Secrets Manager secret id (required when DB_AUTH=secret)
  DB_PASSWORD           Password (required when DB_AUTH=password)

  EMBED_MODEL_ID        DEPRECATED fallback. The embedding model comes from the database
                        (embedding_active_space / embedding_spaces, see
                        get_active_embedding_space). ECS task definitions do NOT set
                        this; it is read only when the database lookup is not
                        available, for example standalone crawl-only runs on SageMaker
                        without database access (default: cohere.embed-english-v3).
  EMBED_BATCH_SIZE      DEPRECATED fallback, same rules as EMBED_MODEL_ID (default: 96)
"""

import json
import os
from dataclasses import dataclass
from typing import Optional

import boto3
import psycopg2


DEFAULT_REGION = "us-east-1"
DEFAULT_PORT = 5432
DEFAULT_SSLMODE = "verify-full"
DEFAULT_EMBED_MODEL_ID = "cohere.embed-english-v3"
DEFAULT_EMBED_BATCH_SIZE = 96


class ConfigError(RuntimeError):
    """Raised when required configuration is missing."""


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ConfigError(
            f"Missing required environment variable: {name}. "
            f"See cdk/containers/common/db_config.py for the full list."
        )
    return value


def get_region() -> str:
    return os.environ.get("AWS_REGION") or os.environ.get("REGION") or DEFAULT_REGION


def get_embed_model_id() -> str:
    """DEPRECATED fallback: the model id comes from the active embedding space in the database."""
    return os.environ.get("EMBED_MODEL_ID", DEFAULT_EMBED_MODEL_ID)


def get_embed_batch_size() -> int:
    """DEPRECATED fallback: the batch size comes from the active embedding space in the database."""
    try:
        return int(os.environ.get("EMBED_BATCH_SIZE", DEFAULT_EMBED_BATCH_SIZE))
    except ValueError:
        return DEFAULT_EMBED_BATCH_SIZE


@dataclass
class DbSettings:
    host: str
    name: str
    user: str
    port: int
    region: str
    auth_mode: str
    sslmode: str
    ssl_root_cert: Optional[str]
    secret_name: Optional[str]


_ACTIVE_SPACE_SQL = """
    SELECT s.id::text, s.name, s.provider, s.model_id, s.invoke_target, s.dimensions,
           s.version, s.status, s.min_score, s.split_threshold, s.settings
    FROM embedding_active_space a
    JOIN embedding_spaces s ON s.id = a.space_id
    WHERE a.id = 1
"""


def get_active_embedding_space(conn) -> dict:
    """
    The embedding space ingestion must write to (migration 032), as a dict:
    id, name, provider, model_id, invoke_target, dimensions, version, status,
    min_score, split_threshold, settings. Containers get their embedding
    configuration from here, never from the ECS task definition.

    Raises ConfigError when no active space is registered. SQL errors
    propagate: an ingestion run must not guess which model to embed with.
    """
    with conn.cursor() as cur:
        cur.execute(_ACTIVE_SPACE_SQL)
        row = cur.fetchone()
    if not row:
        raise ConfigError(
            "No active embedding space: embedding_active_space has no row. "
            "Run the database migrations (032_embedding_spaces) first."
        )
    settings = row[10]
    if isinstance(settings, str):
        settings = json.loads(settings)
    return {
        "id": str(row[0]),
        "name": row[1],
        "provider": row[2],
        "model_id": row[3],
        "invoke_target": row[4],
        "dimensions": int(row[5]),
        "version": row[6],
        "status": row[7],
        "min_score": float(row[8]) if row[8] is not None else None,
        "split_threshold": float(row[9]) if row[9] is not None else None,
        "settings": settings if isinstance(settings, dict) else {},
    }


def spec_from_space(row: dict):
    """The ModelSpec for a registry row (delegates to common/embeddings.py spec_from_row)."""
    try:
        from common import embeddings  # type: ignore
    except ImportError:
        import importlib.util

        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "embeddings.py")
        spec = importlib.util.spec_from_file_location("kc_common_embeddings", path)
        embeddings = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(embeddings)  # type: ignore
    return embeddings.spec_from_row(row)


def load_db_settings() -> DbSettings:
    """Build DB settings purely from the environment. No hard-coded values."""
    auth_mode = os.environ.get("DB_AUTH", "iam").strip().lower()
    if auth_mode not in ("iam", "secret", "password"):
        raise ConfigError(
            f"Invalid DB_AUTH='{auth_mode}'. Expected one of: iam, secret, password."
        )

    try:
        port = int(os.environ.get("DB_PORT", DEFAULT_PORT))
    except ValueError:
        port = DEFAULT_PORT

    return DbSettings(
        host=_require("DB_HOST"),
        name=_require("DB_NAME"),
        user=_require("DB_USER"),
        port=port,
        region=get_region(),
        auth_mode=auth_mode,
        sslmode=os.environ.get("DB_SSLMODE", DEFAULT_SSLMODE),
        ssl_root_cert=os.environ.get("DB_SSL_ROOT_CERT") or None,
        secret_name=os.environ.get("DB_SECRET_NAME") or None,
    )


def _credentials_from_secrets_manager(settings: DbSettings) -> tuple[str, str]:
    if not settings.secret_name:
        raise ConfigError("DB_AUTH=secret requires DB_SECRET_NAME to be set.")
    client = boto3.client("secretsmanager", region_name=settings.region)
    resp = client.get_secret_value(SecretId=settings.secret_name)
    raw = resp.get("SecretString")
    if not raw:
        raise ConfigError(f"Secret {settings.secret_name} has no SecretString value.")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return settings.user, raw
    password = parsed.get("password")
    if not password:
        raise ConfigError(
            f"Secret {settings.secret_name} JSON does not contain a 'password' key."
        )
    user = parsed.get("username") or settings.user
    return user, password


def _password_from_secrets_manager(settings: DbSettings) -> str:
    _user, password = _credentials_from_secrets_manager(settings)
    return password


def _resolve_password(settings: DbSettings) -> str:
    if settings.auth_mode == "iam":
        # Short-lived (15 min) token generated at connect time. No stored secret.
        rds = boto3.client("rds", region_name=settings.region)
        return rds.generate_db_auth_token(
            DBHostname=settings.host,
            Port=settings.port,
            DBUsername=settings.user,
            Region=settings.region,
        )
    if settings.auth_mode == "secret":
        return _password_from_secrets_manager(settings)
    # password mode
    pwd = os.environ.get("DB_PASSWORD")
    if not pwd:
        raise ConfigError("DB_AUTH=password requires DB_PASSWORD to be set.")
    return pwd


def get_db_connection():
    """
    Open a psycopg2 connection using environment-driven config and one of the
    supported credential modes. Never reads credentials from source code.
    """
    settings = load_db_settings()
    if settings.auth_mode == "secret":
        user, password = _credentials_from_secrets_manager(settings)
    else:
        user, password = settings.user, _resolve_password(settings)

    connect_kwargs = dict(
        host=settings.host,
        port=settings.port,
        dbname=settings.name,
        user=user,
        password=password,
        sslmode=settings.sslmode,
    )
    if settings.ssl_root_cert:
        connect_kwargs["sslrootcert"] = settings.ssl_root_cert

    return psycopg2.connect(**connect_kwargs)
