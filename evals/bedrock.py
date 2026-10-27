"""Small Bedrock Converse helpers shared by the extractor, simulator and judge."""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional

RETRYABLE = {"ThrottlingException", "ServiceUnavailableException", "ModelNotReadyException", "InternalServerException"}


def runtime_client(region: str):
    import boto3  # imported lazily so offline commands work without AWS setup

    return boto3.client("bedrock-runtime", region_name=region)


def _error_code(exc: Exception) -> str:
    response = getattr(exc, "response", None) or {}
    return (response.get("Error") or {}).get("Code") or type(exc).__name__


def _with_retries(call: Callable[[], Dict[str, Any]], attempts: int = 5, sleep=time.sleep) -> Dict[str, Any]:
    delay = 2.0
    for attempt in range(attempts):
        try:
            return call()
        except Exception as exc:  # noqa: BLE001 - botocore raises ClientError subclasses
            if _error_code(exc) not in RETRYABLE or attempt == attempts - 1:
                raise
            sleep(delay)
            delay = min(delay * 2, 30.0)
    raise RuntimeError("unreachable")


def _request_options(max_tokens: int, temperature: Optional[float], disable_thinking: bool) -> Dict[str, Any]:
    """inferenceConfig plus model fields. Haiku 5.5 rejects any non-default
    temperature (pass None) and thinks unless told not to."""
    inference: Dict[str, Any] = {"maxTokens": max_tokens}
    if temperature is not None:
        inference["temperature"] = temperature
    options: Dict[str, Any] = {"inferenceConfig": inference}
    if disable_thinking:
        options["additionalModelRequestFields"] = {"thinking": {"type": "disabled"}}
    return options


def converse_text(
    client,
    model_id: str,
    system: str,
    messages: List[Dict[str, Any]],
    max_tokens: int = 800,
    temperature: Optional[float] = None,
    disable_thinking: bool = False,
    sleep=time.sleep,
) -> str:
    response = _with_retries(
        lambda: client.converse(
            modelId=model_id,
            system=[{"text": system}],
            messages=messages,
            **_request_options(max_tokens, temperature, disable_thinking),
        ),
        sleep=sleep,
    )
    blocks = response.get("output", {}).get("message", {}).get("content", []) or []
    return "".join(b.get("text", "") for b in blocks if isinstance(b, dict)).strip()


def converse_tool(
    client,
    model_id: str,
    system: str,
    user_text: str,
    tool_name: str,
    description: str,
    schema: Dict[str, Any],
    max_tokens: int = 2000,
    temperature: Optional[float] = None,
    disable_thinking: bool = False,
    sleep=time.sleep,
) -> Optional[Dict[str, Any]]:
    """Force a single tool call and return its input (None if the model did not call it)."""
    response = _with_retries(
        lambda: client.converse(
            modelId=model_id,
            system=[{"text": system}],
            messages=[{"role": "user", "content": [{"text": user_text}]}],
            toolConfig={
                "tools": [{"toolSpec": {"name": tool_name, "description": description, "inputSchema": {"json": schema}}}],
                "toolChoice": {"tool": {"name": tool_name}},
            },
            **_request_options(max_tokens, temperature, disable_thinking),
        ),
        sleep=sleep,
    )
    for block in response.get("output", {}).get("message", {}).get("content", []) or []:
        tool_use = block.get("toolUse") if isinstance(block, dict) else None
        if tool_use and tool_use.get("name") == tool_name:
            data = tool_use.get("input")
            return data if isinstance(data, dict) else None
    return None
