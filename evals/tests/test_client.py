import unittest

from evals.config import Settings
from evals.harness import signing
from evals.harness.client import ApiClient, ApiError, Throttled
from evals.tests.fakes import KEY, FakeBackend


def make_client(backend, clock=None, **overrides):
    settings = Settings(api_url="https://api.example.test/prod", ws_url="wss://ws.example.test/prod",
                        response_timeout=5, **overrides)
    sleeps = []
    client = ApiClient(settings, http=backend.http, ws_connect=backend.ws_connect, sleep=sleeps.append,
                       clock=clock or (lambda: 1000.0))
    return client, sleeps


class AuthChainTest(unittest.TestCase):
    def test_create_user_and_bound_token(self):
        backend = FakeBackend()
        client, _ = make_client(backend)
        user = client.create_user("run_1")
        self.assertIn(user.user_id, backend.users)
        self.assertEqual(backend.users[user.user_id]["metadata"], {"eval_run_id": "run_1"})
        token = client.access_token(user)
        self.assertEqual(backend.tokens[token], user.user_id)
        # Reused within 10 minutes.
        self.assertEqual(client.access_token(user), token)
        self.assertEqual(sum(1 for r in backend.requests if r["path"] == "/user/publicToken"), 2)
        self.assertNotIn(user.credential, repr(user))

    def test_token_refresh_and_credential_rotation(self):
        backend = FakeBackend()
        now = [1000.0]
        client, _ = make_client(backend, clock=lambda: now[0])
        user = client.create_user("run_1")
        first = client.access_token(user)
        backend.rotate_credentials = True
        now[0] += 11 * 60
        second = client.access_token(user)
        self.assertNotEqual(first, second)
        self.assertEqual(user.credential, backend.users[user.user_id]["credential"])

    def test_requires_https(self):
        with self.assertRaises(ValueError):
            ApiClient(Settings(api_url="http://example.test"))


class RetryTest(unittest.TestCase):
    def test_throttles_back_off_then_succeed(self):
        backend = FakeBackend()
        backend.fail_next = [429, 403]
        client, sleeps = make_client(backend)
        client.create_user("run_1")
        self.assertEqual(sleeps, [15.0, 30.0])

    def test_persistent_throttle_raises(self):
        backend = FakeBackend()
        backend.fail_next = [429] * 4
        client, _ = make_client(backend)
        with self.assertRaises(Throttled):
            client.create_user("run_1")

    def test_json_403_is_not_retried(self):
        backend = FakeBackend()
        client, sleeps = make_client(backend)
        user = client.create_user("r")
        other = client.create_user("r")
        with self.assertRaises(ApiError) as ctx:
            client._call("GET", f"/chat_sessions/user/{other.user_id}", token=client.access_token(user))
        self.assertEqual(ctx.exception.status, 403)
        self.assertEqual(sleeps, [])


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.client, _ = make_client(self.backend)
        self.user = self.client.create_user("run_1")

    def test_signed_tag_marks_session(self):
        tag = signing.make_tag(KEY, self.user.user_id, "run_1", "guideline")
        sid = self.client.create_session(self.user, tag)
        session = self.backend.sessions[sid]
        self.assertEqual(session["eval_run_id"], "run_1")
        self.assertEqual(session["prompt_mode_override"], "guideline")
        body = next(r["body"] for r in self.backend.requests if r["path"] == "/chat_sessions")
        self.assertEqual(body["eval"], tag)
        self.assertNotIn("eval", body.get("metadata") or {})

    def test_chat_turn_and_routing_readback(self):
        sid = self.client.create_session(self.user, None)
        with self.client.chat(self.user) as chat:
            first = chat.send(sid, "hello")
            second = chat.send(sid, "more")
        self.assertTrue(first.ok)
        self.assertEqual(first.phase, "DETECTIVE")
        self.assertTrue(first.started)
        self.assertEqual(first.chunks, 1)
        self.assertEqual(second.response.split(" ")[1], "1")
        frame = self.backend.ws_frames[0]
        self.assertEqual(frame["action"], "generate_text")
        self.assertIs(frame["is_intro_message"], False)
        self.assertEqual(self.backend.tokens[frame["token"]], self.user.user_id)
        routing = self.client.routing_snapshot(self.user, sid)
        self.assertEqual((routing["journey"], routing["situation"], routing["confidence"]), ("J1", "A", "HIGH"))
        self.assertEqual(routing["clusters_seen"], ["A"])
        self.assertEqual(self.user.messages_sent, 2)
        self.assertEqual(self.user.chars_sent, len("hello") + len("more"))

    def test_error_and_limit_events(self):
        def reply(session, message, exchange):
            if message == "char limit":
                return {"error": "DAILY_CHARACTER_LIMIT_EXCEEDED"}
            return {"response": "Daily message limit exceeded. Please try again tomorrow.", "phase": None}
        backend = FakeBackend(reply=reply)
        client, _ = make_client(backend)
        user = client.create_user("r")
        sid = client.create_session(user, None)
        with client.chat(user) as chat:
            limited = chat.send(sid, "anything")
            char = chat.send(sid, "char limit")
        self.assertTrue(limited.limited)
        self.assertFalse(limited.ok)
        self.assertEqual(char.error, "DAILY_CHARACTER_LIMIT_EXCEEDED")
        self.assertTrue(char.limited)

    def test_timeout(self):
        backend = FakeBackend()
        times = iter([0, 0, 10, 10, 10])
        client, _ = make_client(backend, clock=lambda: next(times, 10))
        user = client.create_user("r")
        sid = client.create_session(user, None)
        with client.chat(user) as chat:
            backend.reply = lambda *a: {"response": "x", "phase": "DETECTIVE"}
            chat._ws.send = lambda raw: None  # nothing ever arrives
            result = chat.send(sid, "hello")
        self.assertEqual(result.error, "timeout")

    def test_delete_session(self):
        sid = self.client.create_session(self.user, None)
        self.client.delete_session(self.user, sid)
        self.assertNotIn(sid, self.backend.sessions)
        req = [r for r in self.backend.requests if r["method"] == "DELETE"][0]
        self.assertEqual(req["query"], {"user_id": self.user.user_id})

    def test_admin_calls_use_raw_id_token(self):
        backend = FakeBackend()
        client, _ = make_client(backend, admin_id_token="admin-token")
        self.assertEqual(client.global_prompt_mode(), "standard")
        self.assertEqual(backend.requests[-1]["auth"], "admin-token")
        client_no_admin, _ = make_client(backend)
        with self.assertRaises(ApiError):
            client_no_admin.global_prompt_mode()


if __name__ == "__main__":
    unittest.main()
