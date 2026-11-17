"""
Weekly model-lifecycle check.

Looks at every Amazon Bedrock model the system depends on and publishes ONE message to
an SNS topic when something needs attention:

  * embedding models: every non-purged row of `embedding_spaces` (a retired space still
    counts, because a rollback would use it)
  * generation models: the SSM parameters in GENERATION_MODEL_PARAMS (default
    /KC/LLM/HaikuArn, the parameter the app reads)

A model is flagged when
  * Bedrock reports a lifecycle status other than ACTIVE (for example LEGACY),
  * it is missing from `list_foundation_models` in its region,
  * the end-of-life date is less than WARN_DAYS (90) days away or already past. The date
    comes from the registry (`embedding_spaces.eol_date`, may be NULL: not an alert by
    itself) and from the Bedrock response when it carries one. No field name is assumed:
    the response is searched for a key that looks like an end-of-life timestamp, and when
    there is none the registry date alone is used.
  * the region could not be checked ("check failed"), so a Bedrock outage in one region
    does not hide findings from another.

The model id and region come from configuration (the registry row, the SSM value): an
inference-profile ARN carries its region, a bare model id uses this Lambda's region.
Nothing here asserts that a model is available in a region.

Logs and the SNS message carry model ids, regions, reasons and day counts only. No
credentials, no chunk text, no queries.
"""

import datetime
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# An end-of-life this close (or already past) is an alert. Strictly less than: a model
# exactly 90 days away is not yet flagged.
WARN_DAYS = 90

DEFAULT_GENERATION_PARAMS = "/KC/LLM/HaikuArn"
# Cross-region inference profile ids start with a geography; the model id follows.
_GEO_PREFIXES = {"us", "eu", "apac", "us-gov", "global", "ca", "jp", "au"}
_SNS_SUBJECT_MAX = 100


# ── Model references ──────────────────────────────────────────────────────────

@dataclass
class ModelInUse:
    model_id: str
    region: str
    used_by: List[str] = field(default_factory=list)
    registry_eol: Optional[datetime.date] = None


def _strip_geo_prefix(model_id: str) -> str:
    head, _, rest = model_id.partition(".")
    if head in _GEO_PREFIXES and "." in rest:
        return rest
    return model_id


def parse_model_reference(value: str, default_region: str) -> Optional[Tuple[str, str]]:
    """
    (region, foundation model id) for a model id or ARN, or None when it cannot be
    resolved to one (for example an application inference profile).

      "amazon.titan-embed-text-v2:0"                              -> (default_region, same)
      "arn:aws:bedrock:ca-central-1::foundation-model/cohere.x"   -> ("ca-central-1", "cohere.x")
      "arn:aws:bedrock:us-east-1:111:inference-profile/us.anthropic.claude-3-haiku-v1:0"
                                                                  -> ("us-east-1", "anthropic.claude-3-haiku-v1:0")
    """
    value = (value or "").strip()
    if not value:
        return None
    if not value.startswith("arn:"):
        return default_region, _strip_geo_prefix(value)
    parts = value.split(":", 5)
    if len(parts) < 6 or parts[2] != "bedrock":
        return None
    region = parts[3] or default_region
    kind, _, name = parts[5].partition("/")
    if kind == "foundation-model" and name:
        return region, name
    if kind in ("inference-profile", "cross-region-inference-profile") and name:
        return region, _strip_geo_prefix(name)
    return None  # application-inference-profile, provisioned-model, custom-model, ...


def collect_models(
    spaces: Iterable[Dict[str, Any]],
    generation_values: Dict[str, str],
    default_region: str,
) -> Tuple[Dict[Tuple[str, str], ModelInUse], List[str]]:
    """
    The distinct (region, model id) pairs in use, and notes about references that could not
    be resolved. `spaces` rows: name, model_id, invoke_target, eol_date (date or None).
    """
    models: Dict[Tuple[str, str], ModelInUse] = {}
    unresolved: List[str] = []

    def add(region: str, model_id: str, used_by: str, eol: Optional[datetime.date] = None) -> None:
        entry = models.setdefault((region, model_id), ModelInUse(model_id=model_id, region=region))
        if used_by not in entry.used_by:
            entry.used_by.append(used_by)
        if eol is not None and (entry.registry_eol is None or eol < entry.registry_eol):
            entry.registry_eol = eol

    for space in spaces:
        # The region comes from the call target; the id to look up is the registry model id.
        target = parse_model_reference(space.get("invoke_target") or "", default_region)
        region = target[0] if target else default_region
        model_id = (space.get("model_id") or "").strip() or (target[1] if target else "")
        if not model_id:
            unresolved.append(f"embedding space {space.get('name')}")
            continue
        add(region, _strip_geo_prefix(model_id), f"embedding space {space.get('name')}", _as_date(space.get("eol_date")))

    for parameter, value in generation_values.items():
        parsed = parse_model_reference(value, default_region)
        if parsed is None:
            unresolved.append(f"generation model {parameter}")
            continue
        add(parsed[0], parsed[1], f"generation model {parameter}")

    return models, unresolved


# ── Dates ─────────────────────────────────────────────────────────────────────

def _as_date(value: Any) -> Optional[datetime.date]:
    if value is None:
        return None
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    if isinstance(value, str):
        try:
            return datetime.date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def find_end_of_life(summary: Any) -> Optional[datetime.date]:
    """
    An end-of-life date in a `list_foundation_models` entry, if the response has one.
    No field name is assumed: any key (at any depth) whose name contains "endoflife" or
    "end_of_life" and whose value is a date. When several match, the earliest is used.
    """
    found: List[datetime.date] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                name = str(key).lower().replace("_", "")
                if "endoflife" in name:
                    parsed = _as_date(value)
                    if parsed is not None:
                        found.append(parsed)
                        continue
                walk(value)
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)

    walk(summary)
    return min(found) if found else None


# ── Evaluation ────────────────────────────────────────────────────────────────

def _listing_entry(listing: Dict[str, Dict[str, Any]], model_id: str) -> Optional[Dict[str, Any]]:
    if model_id in listing:
        return listing[model_id]
    for listed_id, summary in listing.items():   # e.g. "x:0:8k" for the id "x:0"
        if listed_id.startswith(model_id + ":"):
            return summary
    return None


def evaluate(
    models: Dict[Tuple[str, str], ModelInUse],
    listings: Dict[str, Optional[Dict[str, Dict[str, Any]]]],
    today: datetime.date,
    warn_days: int = WARN_DAYS,
) -> List[Dict[str, Any]]:
    """
    Findings: {"model_id", "region", "reason", "days_left", "used_by"}.
    `listings[region]` is {model id: summary} or None when that region could not be checked.
    """
    findings: List[Dict[str, Any]] = []
    for (region, model_id), model in sorted(models.items()):
        base = {"model_id": model_id, "region": region, "used_by": list(model.used_by)}
        listing = listings.get(region)
        if listing is None:
            findings.append({**base, "reason": "check failed (could not read the Bedrock model list for this region)", "days_left": None})
            continue

        summary = _listing_entry(listing, model_id)
        eol = model.registry_eol
        reasons: List[str] = []
        if summary is None:
            reasons.append("missing from the Bedrock model list for this region")
        else:
            status = str(((summary.get("modelLifecycle") or {}).get("status")) or "").upper()
            if status != "ACTIVE":
                reasons.append(f"lifecycle status is {status or 'unknown'} (not ACTIVE)")
            api_eol = find_end_of_life(summary)
            if api_eol is not None and (eol is None or api_eol < eol):
                eol = api_eol

        days_left: Optional[int] = None
        if eol is not None:
            days_left = (eol - today).days
            if days_left < 0:
                reasons.append(f"end of life was {eol.isoformat()} ({-days_left} days ago)")
            elif days_left < warn_days:
                reasons.append(f"end of life on {eol.isoformat()} ({days_left} days left)")

        for reason in reasons:
            findings.append({**base, "reason": reason, "days_left": days_left})
    return findings


def build_message(findings: List[Dict[str, Any]], unresolved: List[str], notes: List[str], today: datetime.date) -> Tuple[str, str]:
    """(subject, body) for the single SNS message of a run."""
    models = {(f["region"], f["model_id"]) for f in findings}
    subject = f"Model lifecycle: {len(models)} model(s) need attention"
    lines = [
        f"Model lifecycle check, {today.isoformat()}.",
        f"Alert window: end of life less than {WARN_DAYS} days away.",
        "",
    ]
    for f in findings:
        days = "n/a" if f["days_left"] is None else str(f["days_left"])
        lines.append(f"- {f['model_id']} | {f['region']} | {f['reason']} | days left: {days}")
        if f["used_by"]:
            lines.append(f"    used by: {', '.join(f['used_by'])}")
    for note in notes:
        lines.append(f"- {note}")
    if unresolved:
        lines.append("")
        lines.append("Could not be resolved to a model id (not checked): " + ", ".join(unresolved))
    lines.append("")
    lines.append("Next steps: switch models from Search index in the admin dashboard (Docs/KNOWLEDGE_BASE_DOCUMENTATION.md, Embedding Spaces).")
    return subject[:_SNS_SUBJECT_MAX], "\n".join(lines)


# ── AWS and database access (module-level so tests can replace them) ──────────

def _bedrock_client(region: str):
    return boto3.client("bedrock", region_name=region)


def _ssm_client():
    return boto3.client("ssm")


def _sns_client():
    return boto3.client("sns")


def _secrets_client():
    return boto3.client("secretsmanager")


def _connect_to_db():
    import psycopg2  # imported here: the layer provides it in Lambda
    from botocore.httpsession import get_cert_path

    secret = json.loads(_secrets_client().get_secret_value(SecretId=os.environ["SM_DB_CREDENTIALS"])["SecretString"])
    return psycopg2.connect(
        dbname=secret["dbname"],
        user=secret["username"],
        password=secret["password"],
        host=os.environ["RDS_PROXY_ENDPOINT"],
        port=secret["port"],
        # verify-full against botocore's public CA bundle: RDS Proxy serves an
        # ACM (Amazon Trust Services) certificate.
        sslmode="verify-full",
        sslrootcert=get_cert_path(True),
    )


def _today() -> datetime.date:
    return datetime.datetime.now(datetime.timezone.utc).date()


def load_spaces(connection) -> List[Dict[str, Any]]:
    """Non-purged embedding spaces: name, model_id, invoke_target, eol_date."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT name, model_id, invoke_target, eol_date FROM embedding_spaces "
            "WHERE status <> 'purged' ORDER BY name"
        )
        rows = cursor.fetchall()
    return [{"name": r[0], "model_id": r[1], "invoke_target": r[2], "eol_date": r[3]} for r in rows]


def load_generation_models(parameter_names: List[str]) -> Dict[str, str]:
    """{parameter name: value} for the SSM parameters that exist."""
    if not parameter_names:
        return {}
    response = _ssm_client().get_parameters(Names=parameter_names)
    return {p["Name"]: p["Value"] for p in response.get("Parameters", [])}


def list_models(region: str) -> Dict[str, Dict[str, Any]]:
    """{model id: summary} from the Bedrock control plane in `region`."""
    response = _bedrock_client(region).list_foundation_models()
    return {m["modelId"]: m for m in response.get("modelSummaries", []) if m.get("modelId")}


# ── Handler ───────────────────────────────────────────────────────────────────

def handler(event=None, context=None):
    default_region = os.environ.get("REGION", "ca-central-1")
    topic_arn = os.environ.get("SNS_TOPIC_ARN", "")
    today = _today()
    notes: List[str] = []

    # 1. Embedding models from the registry.
    spaces: List[Dict[str, Any]] = []
    connection = None
    try:
        connection = _connect_to_db()
        spaces = load_spaces(connection)
    except Exception as e:  # noqa: BLE001 - a database outage must not hide the other findings
        logger.error("Could not read the embedding registry: %s", type(e).__name__)
        notes.append("check failed: the embedding space registry could not be read")
    finally:
        try:
            if connection is not None:
                connection.close()
        except Exception:  # noqa: BLE001
            pass

    # 2. Generation models from SSM.
    names = [n.strip() for n in os.environ.get("GENERATION_MODEL_PARAMS", DEFAULT_GENERATION_PARAMS).split(",") if n.strip()]
    generation: Dict[str, str] = {}
    try:
        generation = load_generation_models(names)
    except Exception as e:  # noqa: BLE001
        logger.error("Could not read the generation model parameters: %s", type(e).__name__)
        notes.append("check failed: the generation model parameters could not be read")

    models, unresolved = collect_models(spaces, generation, default_region)

    # 3. One list_foundation_models call per region; a failing region is reported, not fatal.
    listings: Dict[str, Optional[Dict[str, Dict[str, Any]]]] = {}
    for region in sorted({region for region, _ in models}):
        try:
            listings[region] = list_models(region)
        except Exception as e:  # noqa: BLE001
            logger.error("list_foundation_models failed in %s: %s", region, type(e).__name__)
            listings[region] = None

    findings = evaluate(models, listings, today)
    logger.info(
        "Lifecycle check: %s models in %s regions, %s findings, %s notes",
        len(models), len(listings), len(findings), len(notes),
    )

    if not findings and not notes:
        return {"models": len(models), "findings": 0, "published": False}

    subject, message = build_message(findings, unresolved, notes, today)
    if not topic_arn:
        logger.error("SNS_TOPIC_ARN is not configured; %s finding(s) not published", len(findings))
        raise RuntimeError("SNS_TOPIC_ARN is not configured")
    _sns_client().publish(TopicArn=topic_arn, Subject=subject, Message=message)
    logger.info("Published one lifecycle alert (%s findings)", len(findings))
    return {"models": len(models), "findings": len(findings) + len(notes), "published": True}
