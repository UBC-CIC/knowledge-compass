"""
Unit tests for helpers/admin_audit.py (admin_audit rows, worker actor
propagation and audit log lines, finding f-0d57a9d0). No database.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_admin_audit.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import unittest

from _embedding_fakes import ScriptedConnection
from helpers import admin_audit as audit

SUB = "11111111-2222-3333-4444-555555555555"


def http_event(**authorizer):
    return {
        "body": json.dumps({"email": "attacker@example.org", "actor": {"sub": "body-sub"}}),
        "requestContext": {"requestId": "req-1", "authorizer": authorizer},
    }


class ActorFromEventTests(unittest.TestCase):
    def test_http_actor_comes_from_the_authorizer_only(self):
        actor = audit.actor_from_event(http_event(userId=f" {SUB} ", email=" Admin@Example.ORG "))
        self.assertEqual(actor, {"sub": SUB, "email": "admin@example.org", "request_id": "req-1"})

    def test_http_event_without_a_sub_has_no_actor_even_with_a_body_actor(self):
        self.assertIsNone(audit.actor_from_event(http_event(email="admin@example.org")))
        self.assertIsNone(audit.actor_from_event({}))
        self.assertIsNone(audit.actor_from_event(None))

    def test_payload_actor_is_used_for_self_invocations(self):
        actor = audit.actor_from_event(
            {"task": "validate_space", "actor": {"sub": SUB, "email": "admin@example.org", "request_id": 7}}
        )
        self.assertEqual(actor, {"sub": SUB, "email": "admin@example.org", "request_id": "7"})

    def test_malformed_payload_actor_is_none(self):
        for bad in ("admin", {"email": "a@example.org"}, {"sub": ""}, {"sub": 5}, ["x"]):
            self.assertIsNone(audit.actor_from_event({"task": "t", "actor": bad}), bad)

    def test_with_actor_adds_the_actor_or_leaves_the_payload_untouched(self):
        payload = {"task": "reembed_space", "job_id": "j1"}
        self.assertIs(audit.with_actor(payload, {"headers": {}}), payload)
        self.assertNotIn("actor", payload)
        added = audit.with_actor(payload, http_event(userId=SUB))
        self.assertEqual(added["actor"], {"sub": SUB, "email": None, "request_id": "req-1"})
        self.assertEqual(added["job_id"], "j1")


class InsertAdminAuditTests(unittest.TestCase):
    def test_insert_binds_actor_action_json_target_and_request_id(self):
        conn = ScriptedConnection()
        actor = {"sub": SUB, "email": "admin@example.org", "request_id": "req-1"}
        with conn.cursor() as cursor:
            audit.insert_admin_audit(cursor, actor, "data_source.delete", {"ids": ["a"]})
        (sql, params), = conn.executed
        self.assertTrue(sql.startswith("INSERT INTO admin_audit (actor_sub, actor_email, action, target, request_id)"))
        self.assertIn("%s::jsonb", sql)
        self.assertEqual(params, (SUB, "admin@example.org", "data_source.delete", '{"ids": ["a"]}', "req-1"))

    def test_insert_without_an_actor_raises_and_runs_nothing(self):
        conn = ScriptedConnection()
        for actor in (None, {}, {"sub": ""}):
            with conn.cursor() as cursor, self.assertRaises(ValueError):
                audit.insert_admin_audit(cursor, actor, "x", {})
        self.assertEqual(conn.executed, [])


class LogTests(unittest.TestCase):
    def test_log_admin_audit_is_one_json_line(self):
        with self.assertLogs(level="INFO") as logs:
            audit.log_admin_audit({"sub": SUB, "email": "admin@example.org", "request_id": "r"}, "a", {"id": "1"})
        (line,) = [json.loads(r.getMessage()) for r in logs.records]
        self.assertEqual(line, {"audit": "admin_action", "action": "a", "actor_sub": SUB,
                                "actor_email": "admin@example.org", "target": {"id": "1"}, "request_id": "r"})

    def test_log_worker_task_with_an_actor(self):
        event = {"task": "validate_space", "job_id": "j1", "continuation": 2, "body": "never logged",
                 "actor": {"sub": SUB, "email": "admin@example.org", "request_id": "req-1"}}
        with self.assertLogs(level="INFO") as logs:
            audit.log_worker_task(event)
        (line,) = [json.loads(r.getMessage()) for r in logs.records]
        self.assertEqual(line, {"audit": "worker_task", "task": "validate_space", "actor_sub": SUB,
                                "actor_email": "admin@example.org", "request_id": "req-1",
                                "job_id": "j1", "continuation": 2})

    def test_log_worker_task_without_an_actor_logs_nulls(self):
        with self.assertLogs(level="INFO") as logs:
            audit.log_worker_task({"task": "process_document_batch"})
        (line,) = [json.loads(r.getMessage()) for r in logs.records]
        self.assertEqual(line, {"audit": "worker_task", "task": "process_document_batch",
                                "actor_sub": None, "actor_email": None, "request_id": None})


if __name__ == "__main__":
    unittest.main()
