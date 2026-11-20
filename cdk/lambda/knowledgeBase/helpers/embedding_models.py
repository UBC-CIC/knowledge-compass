"""
Resolve the Bedrock model id and invoke target for the embedding adapters this
app can call.

The catalog is the three providers in kc_shared/embeddings.py. Whether a model
can be called, and the id or inference-profile ARN to send, comes from the
Bedrock control plane in this region (`list_foundation_models` and
`list_inference_profiles`). A model is callable when it is on demand here or
an active inference profile wraps it. Unknown embedding models are left out:
each provider needs that adapter's request shape.

`model_id` is the foundation-model id (the weekly lifecycle check looks it up).
`invoke_target` is that id when the model supports on-demand inference here,
otherwise the ARN of an active inference profile that wraps it. A profile is
enough on its own: some models are callable from this region only that way,
and are absent from the regional foundation-model list.
"""

import logging
import os
from typing import Any, Dict, Iterable, List, Optional, Sequence

from kc_shared import embeddings

logger = logging.getLogger()

# Provider -> foundation model ids the adapter understands, in preference order
# when Bedrock lists more than one (cohere.embed-v4:0 before cohere.embed-v4).
CATALOG: Dict[str, Dict[str, Any]] = {
    "cohere_v3": {
        "label": "Cohere Embed English v3",
        "model_ids": ("cohere.embed-english-v3",),
    },
    "titan_v2": {
        "label": "Amazon Titan Text Embeddings V2",
        "model_ids": ("amazon.titan-embed-text-v2:0",),
    },
    "cohere_v4": {
        "label": "Cohere Embed v4",
        "model_ids": ("cohere.embed-v4:0", "cohere.embed-v4"),
    },
}

# Cross-region inference profile ids start with a geography; the model id follows.
_GEO_PREFIXES = {"us", "eu", "apac", "us-gov", "global", "ca", "jp", "au"}
_PROFILE_PAGE_LIMIT = 50

NOT_LISTED = "This model is not available in Amazon Bedrock for this account."
NOT_CALLABLE = (
    "Amazon Bedrock has this model, but it cannot be called on demand and has no inference profile."
)


def deployment_region() -> str:
    return (
        os.environ.get("AWS_REGION")
        or os.environ.get("AWS_DEFAULT_REGION")
        or os.environ.get("REGION")
        or "ca-central-1"
    )


def strip_geo_prefix(model_id: str) -> str:
    head, _, rest = (model_id or "").partition(".")
    if head in _GEO_PREFIXES and "." in rest:
        return rest
    return model_id


def _model_id_from_arn(arn: str) -> str:
    _, _, name = (arn or "").rpartition("/")
    return strip_geo_prefix(name)


def _known(model_id: str, known_ids: Sequence[str]) -> bool:
    bare = strip_geo_prefix(model_id)
    return model_id in known_ids or bare in known_ids


def _summary_for(summaries: Iterable[Dict[str, Any]], known_id: str) -> Optional[Dict[str, Any]]:
    for summary in summaries:
        listed = summary.get("modelId") or ""
        if listed == known_id or strip_geo_prefix(listed) == known_id:
            return summary
    return None


def _is_on_demand(summary: Dict[str, Any]) -> bool:
    return "ON_DEMAND" in (summary.get("inferenceTypesSupported") or [])


def _profile_model_ids(profile: Dict[str, Any]) -> List[str]:
    found: List[str] = []
    for model in profile.get("models") or []:
        if isinstance(model, dict):
            found.append(_model_id_from_arn(model.get("modelArn") or ""))
        elif isinstance(model, str):
            found.append(strip_geo_prefix(model))
    profile_id = profile.get("inferenceProfileId") or ""
    if profile_id:
        found.append(strip_geo_prefix(profile_id))
    return [model_id for model_id in found if model_id]


def _profile_active(profile: Dict[str, Any]) -> bool:
    return profile.get("status") == "ACTIVE"


def _profile_cross_region(profile: Dict[str, Any], region: str) -> bool:
    profile_id = profile.get("inferenceProfileId") or ""
    head, _, rest = profile_id.partition(".")
    if head in _GEO_PREFIXES and "." in rest:
        return True
    arn = profile.get("inferenceProfileArn") or ""
    parts = arn.split(":", 5)
    if len(parts) >= 6 and parts[5].split("/", 1)[0] == "cross-region-inference-profile":
        return True
    for model in profile.get("models") or []:
        if not isinstance(model, dict):
            continue
        model_parts = (model.get("modelArn") or "").split(":")
        if len(model_parts) > 3 and model_parts[3] and model_parts[3] != region:
            return True
    return False


def _profile_target(profile: Dict[str, Any]) -> str:
    return (profile.get("inferenceProfileArn") or profile.get("inferenceProfileId") or "").strip()


def _matched_known_id(profile: Dict[str, Any], known_ids: Sequence[str]) -> Optional[str]:
    for model_id in _profile_model_ids(profile):
        bare = strip_geo_prefix(model_id)
        for known_id in known_ids:
            if model_id == known_id or bare == known_id:
                return known_id
    return None


def _matching_profiles(
    profiles: Iterable[Dict[str, Any]], known_ids: Sequence[str], region: str
) -> List[Dict[str, Any]]:
    """Active profiles that wrap one of `known_ids`, in-region targets first."""
    matched = []
    for profile in profiles:
        if not isinstance(profile, dict) or not _profile_active(profile):
            continue
        if not any(_known(model_id, known_ids) for model_id in _profile_model_ids(profile)):
            continue
        if not _profile_target(profile):
            continue
        matched.append(profile)
    matched.sort(key=lambda profile: _profile_cross_region(profile, region))
    return matched


def _entry(provider: str, spec: Dict[str, Any]) -> Dict[str, Any]:
    adapter = embeddings.ADAPTERS[provider]
    return {
        "provider": provider,
        "label": spec["label"],
        "dimensions": sorted(adapter.allowed_dimensions or ()),
        "available": False,
        "model_id": None,
        "invoke_target": None,
        "cross_region": False,
        "unavailable_reason": NOT_LISTED,
    }


def match_models(
    foundation_models: Iterable[Dict[str, Any]],
    inference_profiles: Iterable[Dict[str, Any]],
    region: str,
) -> List[Dict[str, Any]]:
    """
    One entry per catalog provider, in catalog order. A provider is available
    when Bedrock lists a matching foundation model that is on-demand here, or
    an active inference profile that wraps it. The profile alone is enough:
    the foundation model is often missing from this region's model list.
    """
    summaries = [m for m in foundation_models if isinstance(m, dict) and m.get("modelId")]
    profiles = list(inference_profiles)
    results: List[Dict[str, Any]] = []
    for provider, spec in CATALOG.items():
        entry = _entry(provider, spec)
        known_ids = spec["model_ids"]
        saw_model = False
        for known_id in known_ids:
            summary = _summary_for(summaries, known_id)
            if summary is None:
                continue
            saw_model = True
            listed = summary["modelId"]
            entry["model_id"] = listed if listed in known_ids else known_id
            if _is_on_demand(summary):
                entry["available"] = True
                entry["invoke_target"] = entry["model_id"]
                entry["cross_region"] = False
                entry["unavailable_reason"] = None
                break
            wrapped = _matching_profiles(profiles, (known_id,), region)
            if wrapped:
                profile = wrapped[0]
                entry["available"] = True
                entry["invoke_target"] = _profile_target(profile)
                entry["cross_region"] = _profile_cross_region(profile, region)
                entry["unavailable_reason"] = None
                break
        if not entry["available"]:
            wrapped = _matching_profiles(profiles, known_ids, region)
            if wrapped:
                profile = wrapped[0]
                entry["available"] = True
                entry["model_id"] = _matched_known_id(profile, known_ids) or known_ids[0]
                entry["invoke_target"] = _profile_target(profile)
                entry["cross_region"] = _profile_cross_region(profile, region)
                entry["unavailable_reason"] = None
        if saw_model and not entry["available"]:
            entry["unavailable_reason"] = NOT_CALLABLE
        results.append(entry)
    return results


def reference_for(provider: str, models: Iterable[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The catalog entry for `provider`, or None when it is not in the catalog result."""
    for entry in models:
        if entry.get("provider") == provider:
            return entry
    return None


def _bedrock_client(region: str):
    import boto3

    return boto3.client("bedrock", region_name=region)


def _foundation_models(client) -> List[Dict[str, Any]]:
    response = client.list_foundation_models(byOutputModality="EMBEDDING")
    return list(response.get("modelSummaries") or [])


def _inference_profiles(client) -> List[Dict[str, Any]]:
    profiles: List[Dict[str, Any]] = []
    token = None
    for _ in range(_PROFILE_PAGE_LIMIT):
        kwargs: Dict[str, Any] = {}
        if token:
            kwargs["nextToken"] = token
        response = client.list_inference_profiles(**kwargs)
        profiles.extend(response.get("inferenceProfileSummaries") or [])
        token = response.get("nextToken")
        if not token:
            break
    else:
        logger.error("Stopped reading inference profiles after %s pages", _PROFILE_PAGE_LIMIT)
    return profiles


def list_embedding_models(client=None, region: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Catalog entries filled from the Bedrock control plane. Raises if the
    foundation-model list cannot be read. A failed inference-profile list
    does not hide models that are on demand in this region.
    """
    region = region or deployment_region()
    client = client or _bedrock_client(region)
    foundation = _foundation_models(client)
    try:
        profiles = _inference_profiles(client)
    except Exception as error:  # noqa: BLE001 - the message must not include the Bedrock error text
        logger.error("Inference profile lookup failed: %s", type(error).__name__)
        profiles = []
    return match_models(foundation, profiles, region)
