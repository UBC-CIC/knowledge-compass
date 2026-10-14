"""
In-process fake of the public chat API (REST + WebSocket) for harness tests.
Implements the same contract as cdk/lambda (token chain, eval tag columns,
routing metadata readback, events) without any network.
"""

import json
import urllib.parse
import uuid
from typing import Any, Callable, Dict, List, Optional

from evals.harness import signing

KEY = "s" * 48


class FakeBackend:
    def __init__(self, reply: Optional[Callable[[Dict[str, Any], str, int], Dict[str, Any]]] = None):
        self.users: Dict[str, Dict[str, Any]] = {}
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.tokens: Dict[str, Optional[str]] = {}
        self.requests: List[Dict[str, Any]] = []
        self.ws_frames: List[Dict[str, Any]] = []
        self.reply = reply or self.default_reply
        self.fail_next: List[int] = []  # HTTP statuses to return before succeeding
        self.rotate_credentials = False
        self.delete_fails = False
        self.global_mode = "standard"

    # -- default bot ---------------------------------------------------

    @staticmethod
    def default_reply(session: Dict[str, Any], message: str, exchange: int) -> Dict[str, Any]:
        phase = "SUGGESTION" if exchange >= 2 else "DETECTIVE"
        return {
            "response": f"reply {exchange} ({phase}) {'Here is guidance.' if phase == 'SUGGESTION' else 'What happened?'}",
            "phase": phase,
            "sources": [{"title": "Guide", "url": "https://example.org", "source_type": "http", "content": "text"}]
            if phase == "SUGGESTION" else [],
            "routing": {"route": {"journey": "J1", "situation": "A", "secondary_situation": "NONE",
                                  "confidence": "HIGH", "mode": "ANSWER"},
                        "journeys_seen": ["J1"], "clusters_seen": ["A"], "last_phase": phase},
        }

    # -- HTTP ----------------------------------------------------------

    def _token(self, user_id: Optional[str]) -> str:
        token = f"tok-{uuid.uuid4().hex}"
        self.tokens[token] = user_id
        return token

    def http(self, method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float):
        parsed = urllib.parse.urlparse(url)
        path = parsed.path.replace("/prod", "", 1)
        query = dict(urllib.parse.parse_qsl(parsed.query))
        data = json.loads(body) if body else None
        self.requests.append({"method": method, "path": path, "query": query, "body": data,
                              "auth": headers.get("Authorization")})
        if self.fail_next:
            status = self.fail_next.pop(0)
            return status, b"<html>blocked</html>" if status == 403 else b'{"error":"slow down"}'
        auth = headers.get("Authorization", "")
        bearer = auth[len("Bearer "):] if auth.startswith("Bearer ") else None

        def ok(obj, status=200):
            return status, json.dumps(obj).encode()

        if method == "GET" and path == "/user/publicToken":
            if bearer is None:
                return ok({"token": self._token(None)})
            user = next((u for u in self.users.values() if u["credential"] == bearer), None)
            if user is None:
                return 401, b'{"error":"invalid_credential"}'
            out = {"token": self._token(user["id"])}
            if self.rotate_credentials:
                user["credential"] = f"cred-{uuid.uuid4().hex}"
                out["credential"] = user["credential"]
            return ok(out)
        caller = self.tokens.get(bearer) if bearer else None
        if method == "POST" and path == "/user":
            if bearer not in self.tokens:
                return 401, b'{"error":"unauthorized"}'
            uid = str(uuid.uuid4())
            self.users[uid] = {"id": uid, "credential": f"cred-{uuid.uuid4().hex}", "metadata": (data or {}).get("metadata")}
            return ok({"userId": uid, "credential": self.users[uid]["credential"]})
        if path.startswith("/admin/"):
            if auth != "admin-token":
                return 401, b'{"error":"unauthorized"}'
            if path == "/admin/guideline":
                return ok({"mode": self.global_mode})
            if path == "/admin/analytics":
                real = [s for s in self.sessions.values() if not s["eval_run_id"]]
                return ok({"totals": {"chat_sessions": len(real)}})
            return 404, b'{"error":"not found"}'
        if not caller:
            return 401, b'{"error":"unauthorized"}'
        if method == "POST" and path == "/chat_sessions":
            sid = str(uuid.uuid4())
            tag = (data or {}).get("eval") or {}
            valid = bool(tag) and signing.sign(KEY, caller, tag.get("run_id"), tag.get("mode"), tag.get("exp")) == tag.get("sig")
            self.sessions[sid] = {
                "id": sid, "user_id": caller, "metadata": {}, "messages": [],
                "eval_run_id": tag.get("run_id") if valid else None,
                "prompt_mode_override": tag.get("mode") if valid else None,
            }
            return ok({"id": sid, "user_id": caller, "metadata": {}}, 201)
        if method == "GET" and path.startswith("/chat_sessions/user/"):
            uid = path.rsplit("/", 1)[-1]
            if uid != caller:
                return 403, b'{"error":"forbidden"}'
            return ok([{"id": s["id"], "metadata": s["metadata"]} for s in self.sessions.values() if s["user_id"] == caller])
        if method == "DELETE" and path.startswith("/chat_sessions/"):
            sid = path.rsplit("/", 1)[-1]
            if self.delete_fails:
                return 500, b'{"error":"Internal server error"}'
            s = self.sessions.get(sid)
            if not s or s["user_id"] != caller or query.get("user_id") != caller:
                return 403, b'{"error":"forbidden"}'
            del self.sessions[sid]
            return 204, b""
        return 404, b'{"error":"not found"}'

    # -- WebSocket -----------------------------------------------------

    def ws_connect(self, url: str, **kwargs):
        token = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query)).get("token")
        if token not in self.tokens or self.tokens[token] is None:
            raise ConnectionError("401 at $connect")
        return FakeSocket(self)


class FakeSocket:
    def __init__(self, backend: FakeBackend):
        self.backend = backend
        self.queue: List[str] = []
        self.closed = False

    def send(self, raw: str) -> None:
        frame = json.loads(raw)
        self.backend.ws_frames.append(frame)
        caller = self.backend.tokens.get(frame.get("token"))
        if frame.get("action") != "generate_text" or not caller:
            self.queue.append(json.dumps({"type": "error", "error": "A valid user session token is required"}))
            return
        session = self.backend.sessions.get(frame["chat_session_id"])
        if not session or session["user_id"] != caller:
            self.queue.append(json.dumps({"type": "error", "error": "Unauthorized access to chat session"}))
            return
        exchange = len(session["messages"])
        out = self.backend.reply(session, frame["query"], exchange)
        session["messages"].append(frame["query"])
        if out.get("error"):
            self.queue.append(json.dumps({"type": "error", "error": out["error"], "message": "limit"}))
            return
        if out.get("routing"):
            session["metadata"]["routing"] = out["routing"]
        self.queue.append(json.dumps({"type": "start"}))
        self.queue.append(json.dumps({"type": "chunk", "content": out["response"][:5]}))
        self.queue.append("not json")
        self.queue.append(json.dumps({"type": "complete", "response": out["response"], "sources": out.get("sources", []),
                                      "warning": out.get("warning"), "phase": out["phase"],
                                      "chat_session_id": session["id"]}))

    def recv(self, timeout=None):
        if not self.queue:
            raise TimeoutError()
        return self.queue.pop(0)

    def close(self):
        self.closed = True
