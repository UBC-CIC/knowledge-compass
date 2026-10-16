"""
Tests for helpers/session_security.py: the acting user comes only from
requestContext.authorizer.userId (set by the REST user authorizer or by
websocket/default.js from a verified token), and ownership checks use it.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
import uuid

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers.session_security import resolve_caller_user_id, validate_session_ownership  # noqa: E402

USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
OTHER_USER = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c"
SESSION = "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"


def event_for(user_id):
    return {"requestContext": {"authorizer": {"userId": user_id}}}


class ResolveCallerUserIdTests(unittest.TestCase):
    def test_bound_token_user(self):
        self.assertEqual(resolve_caller_user_id(event_for(USER)), (USER, None))
        self.assertEqual(resolve_caller_user_id(event_for(USER), USER), (USER, None))
        self.assertEqual(resolve_caller_user_id(event_for(USER), ""), (USER, None))

    def test_anonymous_or_missing_identity_is_401(self):
        for event in ({}, {"requestContext": {}}, event_for(""), event_for("user"), event_for(None), event_for(123)):
            with self.subTest(event=event):
                user_id, error = resolve_caller_user_id(event, USER)
                self.assertIsNone(user_id)
                self.assertEqual(error[0], 401)

    def test_body_user_id_must_match_token(self):
        user_id, error = resolve_caller_user_id(event_for(USER), OTHER_USER)
        self.assertIsNone(user_id)
        self.assertEqual(error[0], 403)


class FakeCursor:
    def __init__(self, row, error=None):
        self.row = row
        self.error = error

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params):
        if self.error:
            raise self.error
        self.params = params

    def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, row, error=None):
        self.row = row
        self.error = error

    def cursor(self):
        return FakeCursor(self.row, self.error)


class ValidateSessionOwnershipTests(unittest.TestCase):
    def test_owner_and_uuid_typed_owner(self):
        self.assertTrue(validate_session_ownership(FakeConnection((USER,)), SESSION, USER))
        self.assertTrue(validate_session_ownership(FakeConnection((uuid.UUID(USER),)), SESSION, USER))

    def test_other_owner_refused(self):
        self.assertFalse(validate_session_ownership(FakeConnection((OTHER_USER,)), SESSION, USER))

    def test_missing_session_refused(self):
        # Sessions are created only by POST /chat_sessions; a session id the
        # caller made up gets the same refusal as someone else's session.
        self.assertFalse(validate_session_ownership(FakeConnection(None), SESSION, USER))

    def test_db_error_refused(self):
        conn = FakeConnection(None, error=RuntimeError(f"boom {USER} {SESSION}"))
        self.assertFalse(validate_session_ownership(conn, SESSION, USER))

    def test_logs_carry_no_ids(self):
        cases = (
            FakeConnection(None),
            FakeConnection((OTHER_USER,)),
            FakeConnection(None, error=RuntimeError(f"boom {USER} {SESSION}")),
        )
        for conn in cases:
            with self.subTest(row=conn.row, error=conn.error):
                with self.assertLogs(level="WARNING") as logs:
                    validate_session_ownership(conn, SESSION, USER)
                text = "\n".join(logs.output)
                for value in (USER, OTHER_USER, SESSION):
                    self.assertNotIn(value, text)


if __name__ == "__main__":
    unittest.main()
