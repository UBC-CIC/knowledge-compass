"""
helpers/admin_user.py: the acting admin's users row is keyed on the Cognito
sub (finding f-23c5bf7c); an email match never returns a guest row.

    cd cdk/lambda/knowledgeBase && python -m unittest tests.test_admin_user
"""

import _setup  # noqa: F401  (must precede helpers imports)

import json
import unittest

from helpers import admin_user

SUB = "11111111-2222-3333-4444-555555555555"
ROW = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"
GUEST = "8b9e4c2d-7a1f-4e3b-a5c6-2d1e0f9a8b7c"
EMAIL = "admin@staff.example"


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self.rowcount = 0
        self._one = None
        self._all = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        text = " ".join(sql.split())
        self.conn.executed.append((text, params))
        self._one, self._all, self.rowcount = None, [], 0
        if text.startswith("SELECT id, email FROM users WHERE cognito_sub"):
            self._one = self.conn.by_sub
        elif text.startswith("SELECT id, identity_source, cognito_sub"):
            self._all = list(self.conn.holders)
        elif text.startswith("UPDATE users SET email = NULL"):
            keep = params[1] if len(params) > 1 else None
            self.rowcount = len([h for h in self.conn.holders if str(h[0]) != keep])
        elif text.startswith("UPDATE users SET cognito_sub"):
            self._one = (params[1],)
        elif text.startswith("UPDATE users SET last_seen_at"):
            self._one = (params[1],)
        elif text.startswith("INSERT INTO users"):
            self._one = ("new-row",)

    def fetchone(self):
        return self._one

    def fetchall(self):
        return self._all


class FakeConnection:
    def __init__(self, by_sub=None, holders=()):
        self.by_sub = by_sub
        self.holders = holders
        self.executed = []

    def cursor(self):
        return FakeCursor(self)

    def sql_with(self, prefix):
        return [(t, p) for t, p in self.executed if t.startswith(prefix)]


class RequestIdentityTests(unittest.TestCase):
    def test_email_comes_from_the_authorizer_only(self):
        event = {"requestContext": {"authorizer": {"email": " Admin@Staff.Example "}}}
        self.assertEqual(admin_user.admin_email_from_request(event, {"created_by": "x@y.z"}), EMAIL)
        self.assertIsNone(admin_user.admin_email_from_request({}, {"created_by": "spoof@example.org"}))
        self.assertIsNone(admin_user.admin_email_from_request(
            {"requestContext": {"authorizer": {"email": "  "}}}, {"created_by": "spoof@example.org"}
        ))

    def test_sub_comes_from_the_authorizer_user_id(self):
        self.assertEqual(admin_user.admin_sub_from_request({"requestContext": {"authorizer": {"userId": f" {SUB} "}}}), SUB)
        for event in ({}, {"requestContext": {}}, {"requestContext": {"authorizer": {"userId": ""}}},
                      {"requestContext": {"authorizer": {"userId": 5}}},
                      {"requestContext": {"authorizer": {"email": EMAIL}}}):
            self.assertIsNone(admin_user.admin_sub_from_request(event))


class GetOrCreateAdminUserIdTests(unittest.TestCase):
    def test_missing_sub_returns_none_without_queries(self):
        conn = FakeConnection()
        self.assertIsNone(admin_user.get_or_create_admin_user_id(conn, None, EMAIL))
        self.assertIsNone(admin_user.get_or_create_admin_user_id(conn, "  ", EMAIL))
        self.assertEqual(conn.executed, [])

    def test_sub_hit_returns_that_row_without_an_email_lookup(self):
        conn = FakeConnection(by_sub=(ROW, EMAIL))
        self.assertEqual(admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL), ROW)
        self.assertFalse(conn.sql_with("INSERT INTO users"))
        self.assertFalse([t for t, _ in conn.executed if "lower(email)" in t])
        (text, _), = conn.sql_with("UPDATE users SET last_seen_at")
        self.assertNotIn("role", text)

    def test_legacy_cognito_row_is_linked_and_credentials_revoked(self):
        conn = FakeConnection(holders=[(ROW, "cognito", None, False, "admin")])
        self.assertEqual(admin_user.get_or_create_admin_user_id(conn, SUB, "Admin@Staff.Example"), ROW)
        (text, params), = conn.sql_with("UPDATE users SET cognito_sub")
        self.assertIn("credential_version = credential_version + 1", text)
        self.assertNotIn("role", text)
        self.assertEqual(params, (SUB, ROW))
        self.assertFalse(conn.sql_with("INSERT INTO users"))
        (_, holder_params), = conn.sql_with("SELECT id, identity_source")
        self.assertEqual(holder_params, (EMAIL,))

    def test_guest_row_holding_the_email_is_detached_and_a_cognito_row_created(self):
        conn = FakeConnection(holders=[(GUEST, "guest", None, False, "student")])
        with self.assertLogs(level="INFO") as logs:
            result = admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL)
        self.assertEqual(result, "new-row")
        self.assertNotEqual(result, GUEST)
        self.assertFalse(conn.sql_with("UPDATE users SET cognito_sub"))
        (_, detach_params), = conn.sql_with("UPDATE users SET email = NULL")
        self.assertEqual(detach_params, (EMAIL,))
        (insert_text, insert_params), = conn.sql_with("INSERT INTO users")
        self.assertIn("'cognito'", insert_text)
        self.assertIn("'student'::user_role", insert_text)
        self.assertNotIn("'admin'", insert_text)
        self.assertEqual(insert_params, (EMAIL, EMAIL, SUB))
        for line in logs.output:
            self.assertNotIn(EMAIL, line)
            self.assertNotIn(GUEST, line)

    def test_cognito_row_with_chats_or_another_sub_is_not_linked(self):
        for holder in [(GUEST, "cognito", None, True, "admin"), (GUEST, "cognito", "other-sub", False, "admin")]:
            with self.subTest(holder=holder):
                conn = FakeConnection(holders=[holder])
                self.assertEqual(admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL), "new-row")
                self.assertTrue(conn.sql_with("UPDATE users SET email = NULL"))

    def _provision_lines(self, conn):
        """(result, provision audit lines, all log output) for one call."""
        with self.assertLogs(level="INFO") as logs:
            admin_user.logger.info("marker")  # assertLogs needs at least one record
            result = admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL)
        lines = [json.loads(r.getMessage()) for r in logs.records
                 if r.getMessage().startswith('{"audit": "admin_user.provision"')]
        return result, lines, "\n".join(logs.output)

    def test_privilege_changing_writes_log_the_actor_and_outcome_only(self):
        cases = [
            (FakeConnection(), "created"),
            (FakeConnection(holders=[(ROW, "cognito", None, False, "admin")]), "linked"),
        ]
        for conn, outcome in cases:
            with self.subTest(outcome=outcome):
                _, lines, output = self._provision_lines(conn)
                self.assertEqual(lines, [{"audit": "admin_user.provision", "actor_sub": SUB, "outcome": outcome}])
                self.assertNotIn(EMAIL, output)
                self.assertNotIn(ROW, output)

    def test_existing_row_keeps_its_role_and_logs_nothing(self):
        for role in ("admin", "student"):
            with self.subTest(role=role):
                conn = FakeConnection(by_sub=(ROW, EMAIL))
                _, lines, _ = self._provision_lines(conn)
                self.assertEqual(lines, [])
                (text, _), = conn.sql_with("UPDATE users SET last_seen_at")
                self.assertNotIn("role", text)
                self.assertNotIn(role, text)

    def test_only_the_link_lookup_matches_on_email(self):
        conn = FakeConnection(holders=[(GUEST, "guest", None, False, "student")])
        admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL)
        email_selects = [t for t, _ in conn.executed if t.startswith("SELECT") and "lower(email) = %s" in t]
        self.assertEqual(len(email_selects), 1)
        self.assertTrue(email_selects[0].startswith("SELECT id, identity_source, cognito_sub"))
        self.assertIn("ORDER BY (role = 'admin'::user_role) DESC, id", email_selects[0])

    def test_non_admin_holder_is_detached_and_never_returned(self):
        student = (GUEST, "cognito", None, False, "student")
        conn = FakeConnection(holders=[student])
        self.assertEqual(admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL), "new-row")
        self.assertFalse(conn.sql_with("UPDATE users SET cognito_sub"))
        self.assertTrue(conn.sql_with("UPDATE users SET email = NULL"))

    def test_admin_holder_is_chosen_when_a_student_row_is_listed_first(self):
        student = (GUEST, "cognito", None, False, "student")
        admin = (ROW, "cognito", None, False, "admin")
        conn = FakeConnection(holders=[student, admin])
        self.assertEqual(admin_user.get_or_create_admin_user_id(conn, SUB, EMAIL), ROW)
        self.assertFalse(conn.sql_with("INSERT INTO users"))


if __name__ == "__main__":
    unittest.main()
