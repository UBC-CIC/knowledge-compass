"""
Public chat API client used by the harness, mirroring the frontend:

  GET  /user/publicToken                    anonymous token (no auth)
  POST /user                                 -> {userId, credential}
  GET  /user/publicToken  (Bearer credential) -> user-bound 15-minute token
  POST /chat_sessions                        (+ signed eval tag)
  WebSocket ?token=...  {"action": "generate_text", ...}
       events: start, chunk, complete, error
  GET  /chat_sessions/user/{user_id}         routing readback (metadata)
  DELETE /chat_sessions/{id}?user_id=        cleanup

Never sends session feedback and never sets is_intro_message (which would
skip the guardrail). Message text is never logged.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from evals.config import Settings

DAILY_MESSAGE_LIMIT_TEXT = "Daily message limit exceeded"
TOKEN_REUSE_SECONDS = 10 * 60
# Characters/messages one anonymous user may send per day (textGeneration
# defaults; admins can change them). The runner starts a new user before either.
USER_CHAR_BUDGET = 9000
USER_MESSAGE_BUDGET = 40


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


class Throttled(ApiError):
    """WAF or stage throttling; the caller should slow down."""


@dataclass
class EvalUser:
    user_id: str
    credential: str = field(repr=False)
    token: str = field(default="", repr=False)
    token_at: float = 0.0
    chars_sent: int = 0
    messages_sent: int = 0

    def has_budget(self, chars: int) -> bool:
        return self.chars_sent + chars <= USER_CHAR_BUDGET and self.messages_sent < USER_MESSAGE_BUDGET


@dataclass
class TurnResult:
    response: str = ""
    sources: List[Dict[str, Any]] = field(default_factory=list)
    warning: Optional[str] = None
    phase: Optional[str] = None
    error: Optional[str] = None
    error_message: Optional[str] = None
    started: bool = False
    chunks: int = 0
    elapsed: float = 0.0
    limited: bool = False  # daily message/character limit

    @property
    def ok(self) -> bool:
        return self.error is None and not self.limited and bool(self.response)


# ------------------------------------------------------------------
# HTTP
# ------------------------------------------------------------------

def _urllib_request(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - https API URL from settings
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class ApiClient:
    def __init__(
        self,
        settings: Settings,
        http: Callable[..., Any] = _urllib_request,
        ws_connect: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.time,
    ):
        if not settings.api_url.startswith("https://") and not settings.api_url.startswith("http://127.0.0.1"):
            raise ValueError("KC_API_URL must be an https:// URL")
        self.settings = settings
        self._http = http
        self._ws_connect = ws_connect
        self._sleep = sleep
        self._clock = clock

    # -- low level -------------------------------------------------

    def _call(self, method: str, path: str, token: Optional[str] = None, body: Any = None,
              query: Optional[Dict[str, str]] = None, raw_auth: bool = False, attempts: int = 4) -> Any:
        url = f"{self.settings.api_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = token if raw_auth else f"Bearer {token}"
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        delay = 15.0
        for attempt in range(attempts):
            status, raw = self._http(method, url, headers, data, 30.0)
            text = raw.decode("utf-8", "replace") if raw else ""
            try:
                parsed = json.loads(text) if text else None
            except json.JSONDecodeError:
                parsed = None
            # 429 = stage throttle; a non-JSON 403 is a WAF rate-based block.
            throttled = status == 429 or status in (502, 503, 504) or (status == 403 and parsed is None)
            if throttled and attempt < attempts - 1:
                self._sleep(delay)
                delay = min(delay * 2, 120.0)
                continue
            if throttled:
                raise Throttled(status, f"{method} {path} throttled")
            if status >= 400:
                detail = parsed.get("error") if isinstance(parsed, dict) else ""
                raise ApiError(status, f"{method} {path} failed {detail or ''}".strip())
            return parsed
        raise RuntimeError("unreachable")

    # -- identity --------------------------------------------------

    def create_user(self, run_id: str) -> EvalUser:
        anon = self._call("GET", "/user/publicToken")
        token = (anon or {}).get("token")
        if not token:
            raise ApiError(500, "anonymous token missing")
        created = self._call("POST", "/user", token=token, body={"metadata": {"eval_run_id": run_id}})
        if not created or not created.get("userId") or not created.get("credential"):
            raise ApiError(500, "POST /user returned no user")
        return EvalUser(user_id=created["userId"], credential=created["credential"])

    def access_token(self, user: EvalUser) -> str:
        if user.token and self._clock() - user.token_at < TOKEN_REUSE_SECONDS:
            return user.token
        out = self._call("GET", "/user/publicToken", token=user.credential)
        if not out or not out.get("token"):
            raise ApiError(500, "user token missing")
        if out.get("credential"):
            user.credential = out["credential"]  # rotated; the old one stops working
        user.token, user.token_at = out["token"], self._clock()
        return user.token

    # -- sessions --------------------------------------------------

    def create_session(self, user: EvalUser, eval_tag: Optional[Dict[str, Any]], title: str = "Eval") -> str:
        body: Dict[str, Any] = {"title": title}
        if eval_tag:
            body["eval"] = eval_tag
        out = self._call("POST", "/chat_sessions", token=self.access_token(user), body=body)
        if not out or not out.get("id"):
            raise ApiError(500, "POST /chat_sessions returned no id")
        return out["id"]

    def session_metadata(self, user: EvalUser, session_id: str) -> Dict[str, Any]:
        sessions = self._call(
            "GET", f"/chat_sessions/user/{urllib.parse.quote(user.user_id)}", token=self.access_token(user)
        ) or []
        for s in sessions:
            if s.get("id") == session_id:
                return s.get("metadata") or {}
        return {}

    def routing_snapshot(self, user: EvalUser, session_id: str) -> Dict[str, Any]:
        metadata = self.session_metadata(user, session_id)
        routing = metadata.get("routing") if isinstance(metadata.get("routing"), dict) else {}
        route = routing.get("route") if isinstance(routing.get("route"), dict) else {}
        return {
            "journey": route.get("journey"),
            "situation": route.get("situation"),
            "secondary_situation": route.get("secondary_situation"),
            "confidence": route.get("confidence"),
            "mode": route.get("mode"),
            "urgent": route.get("urgent"),
            "journeys_seen": list(routing.get("journeys_seen") or []),
            "clusters_seen": list(routing.get("clusters_seen") or []),
            "last_phase": routing.get("last_phase"),
            "journey_state": metadata.get("journey_state"),
        }

    def delete_session(self, user: EvalUser, session_id: str) -> None:
        self._call(
            "DELETE", f"/chat_sessions/{urllib.parse.quote(session_id)}",
            token=self.access_token(user), query={"user_id": user.user_id},
        )

    # -- admin (optional) -----------------------------------------

    def admin_get(self, path: str, query: Optional[Dict[str, str]] = None) -> Any:
        if not self.settings.admin_id_token:
            raise ApiError(401, "KC_ADMIN_ID_TOKEN is not set")
        return self._call("GET", path, token=self.settings.admin_id_token, raw_auth=True, query=query)

    def global_prompt_mode(self) -> Optional[str]:
        out = self.admin_get("/admin/guideline")
        return (out or {}).get("mode")

    def analytics_totals(self) -> Dict[str, Any]:
        return (self.admin_get("/admin/analytics") or {}).get("totals") or {}

    # -- chat ------------------------------------------------------

    def chat(self, user: EvalUser) -> "ChatSocket":
        return ChatSocket(self, user)


class ChatSocket:
    """One WebSocket connection for one user; send() returns the turn result."""

    def __init__(self, client: ApiClient, user: EvalUser):
        self.client = client
        self.user = user
        self._ws = None

    def __enter__(self) -> "ChatSocket":
        token = self.client.access_token(self.user)
        url = f"{self.client.settings.ws_url}?{urllib.parse.urlencode({'token': token})}"
        connect = self.client._ws_connect
        if connect is None:
            from websockets.sync.client import connect as ws_connect

            connect = ws_connect
        self._ws = connect(url, open_timeout=30, close_timeout=5)
        return self

    def __exit__(self, *exc) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            finally:
                self._ws = None

    def _drain(self) -> None:
        """Discard late events (e.g. an async retry) left from the previous turn."""
        while True:
            try:
                self._ws.recv(timeout=0.2)
            except TimeoutError:
                return
            except Exception:  # noqa: BLE001 - closed/other: nothing to drain
                return

    def send(self, session_id: str, message: str) -> TurnResult:
        self._drain()
        token = self.client.access_token(self.user)
        self._ws.send(json.dumps({
            "action": "generate_text",
            "query": message,
            "chat_session_id": session_id,
            "user_id": self.user.user_id,
            "token": token,
            "is_intro_message": False,
        }))
        self.user.chars_sent += len(message)
        self.user.messages_sent += 1

        result = TurnResult()
        start = self.client._clock()
        deadline = start + self.client.settings.response_timeout
        while True:
            remaining = deadline - self.client._clock()
            if remaining <= 0:
                result.error = "timeout"
                break
            try:
                raw = self._ws.recv(timeout=remaining)
            except TimeoutError:
                result.error = "timeout"
                break
            try:
                event = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("type")
            if kind == "start":
                result.started = True
            elif kind == "chunk":
                result.chunks += 1
            elif kind == "complete":
                result.response = event.get("response") or ""
                result.sources = event.get("sources") or []
                result.warning = event.get("warning")
                result.phase = event.get("phase")
                if result.response.startswith(DAILY_MESSAGE_LIMIT_TEXT):
                    result.limited = True
                break
            elif kind == "error":
                result.error = str(event.get("error") or "error")
                result.error_message = event.get("message")
                if result.error in ("DAILY_CHARACTER_LIMIT_EXCEEDED", "TOKEN_LIMIT_EXCEEDED"):
                    result.limited = True
                break
            # Anything else (route responses, unknown types) is ignored.
        result.elapsed = round(self.client._clock() - start, 2)
        return result
