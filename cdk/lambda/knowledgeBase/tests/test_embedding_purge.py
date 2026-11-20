"""
Unit tests for the purge route in helpers/embedding_admin.py (retention guard,
typed confirmation, batched delete, index drop). The database is faked.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_embedding_purge.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import _embedding_fakes as fakes
from helpers import embedding_admin as ea

SPACE_ID = "22222222-2222-4222-8222-222222222222"
JOB_ID = "33333333-3333-4333-8333-333333333333"
NAME = "titan-v2-1024"
NOW = datetime(2026, 3, 1, tzinfo=timezone.utc)

UNLOCKED = (False, None, None, False)
LOCKED = (True, NOW, JOB_ID, False)

PATH = f"/admin/embedding-spaces/{SPACE_ID}/purge"
RESOURCE = "/admin/embedding-spaces/{id}/purge"


def purge_event(email="admin@example.org"):
    return {
        "httpMethod": "POST",
        "path": PATH,
        "resource": RESOURCE,
        "pathParameters": {"id": SPACE_ID},
        "requestContext": {"authorizer": {"email": email, "userId": "admin-sub"}} if email else {},
        "headers": {},
    }


def body_of(response):
    return json.loads(response["body"])


class PurgeConnection(fakes.ScriptedConnection):
    """ScriptedConnection whose DELETE reports a different row count per batch."""

    def __init__(self, space_row, delete_counts=(0,), lock=UNLOCKED, running=None, purge_updates=1, lock_taken=1):
        super().__init__({
            "FROM embedding_spaces s WHERE s.id": [space_row] if space_row else [],
            "SELECT cutover_locked": [lock],
            "SELECT id::text FROM embedding_jobs WHERE status IN": [(running,)] if running else [],
        }, rowcounts={
            "UPDATE embedding_spaces SET status = 'purged'": purge_updates,
            "SET cutover_locked = true": lock_taken,
        })
        self.delete_counts = list(delete_counts)

    def respond(self, text, params):
        rows, count = super().respond(text, params)
        if "DELETE FROM chunk_embeddings" in text:
            count = self.delete_counts.pop(0) if self.delete_counts else 0
        return rows, count


def space_row(status="retired", retired_days_ago=40.0, retention_over=None, is_active=False, name=NAME):
    retired_at = NOW - timedelta(days=retired_days_ago) if retired_days_ago is not None else None
    over = retention_over if retention_over is not None else (
        retired_days_ago is not None and retired_days_ago >= ea.RETENTION_DAYS
    )
    eligible = retired_at + timedelta(days=ea.RETENTION_DAYS) if retired_at else None
    return (SPACE_ID, name, status, retired_at, over, eligible, is_active)


class PurgeTest(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(ea, "invoke_self")
        self.invoke = patch.start()
        self.addCleanup(patch.stop)

    def purge(self, conn, body=None, email="admin@example.org"):
        body = {"confirm_name": NAME} if body is None else body
        return ea.handle_embedding_request(purge_event(email), body, conn), conn

    def assert_nothing_deleted(self, conn):
        self.assertEqual(conn.sql_with("DELETE FROM chunk_embeddings"), [])
        self.assertEqual(conn.sql_with("drop_space_index"), [])
        self.assertEqual(conn.sql_with("SET status = 'purged'"), [])

    # ── guards ────────────────────────────────────────────────────────────────

    def test_unknown_space_is_404(self):
        response, conn = self.purge(PurgeConnection(None))
        self.assertEqual(response["statusCode"], 404)
        self.assert_nothing_deleted(conn)

    def test_requires_the_authorizer_identity(self):
        response, conn = self.purge(PurgeConnection(space_row()), email=None)
        self.assertEqual(response["statusCode"], 401)
        self.assertEqual(conn.executed, [])

    def test_refused_for_every_status_except_retired(self):
        cases = {
            "building": space_row("building", retired_days_ago=None),
            "validated": space_row("validated", retired_days_ago=None),
            "active": space_row("active", retired_days_ago=None, is_active=True),
            "purged": space_row("purged", retired_days_ago=90),
        }
        for label, row in cases.items():
            with self.subTest(label):
                response, conn = self.purge(PurgeConnection(row))
                self.assertEqual(response["statusCode"], 409, body_of(response))
                self.assert_nothing_deleted(conn)

    def test_the_active_space_is_refused_even_if_its_status_looks_retired(self):
        response, conn = self.purge(PurgeConnection(space_row("retired", 90, is_active=True)))
        self.assertEqual(response["statusCode"], 409)
        self.assertIn("active", body_of(response)["error"].lower())
        self.assert_nothing_deleted(conn)

    def test_a_second_purge_is_rejected_as_already_purged(self):
        response, _ = self.purge(PurgeConnection(space_row("purged", 90)))
        self.assertEqual(response["statusCode"], 409)
        self.assertIn("already", body_of(response)["error"].lower())

    def test_retired_too_recently_29_days_23_hours(self):
        response, conn = self.purge(PurgeConnection(space_row(retired_days_ago=29 + 23 / 24)))
        self.assertEqual(response["statusCode"], 409)
        data = body_of(response)
        self.assertIn("too recently", data["error"])
        self.assertIn("purge_eligible_at", data)
        self.assert_nothing_deleted(conn)

    def test_allowed_at_exactly_30_days(self):
        response, conn = self.purge(PurgeConnection(space_row(retired_days_ago=30.0), delete_counts=(0,)))
        self.assertEqual(response["statusCode"], 200, body_of(response))
        self.assertEqual(len(conn.sql_with("drop_space_index")), 1)

    def test_the_retention_decision_uses_the_database_clock_and_the_constant(self):
        _, conn = self.purge(PurgeConnection(space_row()))
        sql = conn.sql_with("FROM embedding_spaces s WHERE s.id")[0][0]
        self.assertIn("now() - s.retired_at >= interval '30 days'", sql)
        self.assertEqual(ea.RETENTION_DAYS, 30)

    def test_a_retired_space_without_a_retired_at_is_not_purgeable(self):
        row = (SPACE_ID, NAME, "retired", None, False, None, False)
        response, conn = self.purge(PurgeConnection(row))
        self.assertEqual(response["statusCode"], 409)
        self.assert_nothing_deleted(conn)

    def test_refused_while_a_cutover_holds_the_lock(self):
        response, conn = self.purge(PurgeConnection(space_row(), lock=LOCKED))
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(body_of(response)["code"], "CUTOVER_LOCKED")
        self.assert_nothing_deleted(conn)

    def test_refused_when_a_cutover_takes_the_lock_first(self):
        # lock_state looked free, but the atomic take lost the race (finding f-71ff7846).
        response, conn = self.purge(PurgeConnection(space_row(), lock_taken=0))
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(body_of(response)["code"], "CUTOVER_LOCKED")
        self.assert_nothing_deleted(conn)

    def test_the_cutover_lock_is_held_for_the_purge_and_released_after(self):
        for crash in (False, True):
            with self.subTest(crash=crash):
                conn = PurgeConnection(space_row(), delete_counts=(5000, 0))
                if crash:
                    conn.fail_next("DELETE FROM chunk_embeddings", RuntimeError("connection lost"))
                self.purge(conn)
                statements = [sql for sql, _ in conn.executed]
                take = next(i for i, sql in enumerate(statements) if "SET cutover_locked = true" in sql)
                first_delete = next(i for i, sql in enumerate(statements) if "DELETE FROM chunk_embeddings" in sql)
                release = max(i for i, sql in enumerate(statements) if "SET cutover_locked = false" in sql)
                self.assertLess(take, first_delete)
                self.assertGreater(release, first_delete)
                lock_id = conn.executed[take][1][0]
                self.assertEqual(conn.executed[release][1], (lock_id,))

    def test_refused_while_a_job_is_running_for_the_space(self):
        conn = PurgeConnection(space_row(), running=JOB_ID)
        response, conn = self.purge(conn)
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(body_of(response)["job_id"], JOB_ID)
        self.assert_nothing_deleted(conn)
        sql, params = conn.sql_with("SELECT id::text FROM embedding_jobs WHERE status IN")[0]
        self.assertEqual(params[1], SPACE_ID)
        self.assertEqual(set(params[0]), {"dry_run", "rebuild", "delta", "validate", "activate", "rollback"})

    # ── typed confirmation, enforced server-side ──────────────────────────────

    def test_wrong_or_missing_typed_name_is_a_400(self):
        for label, body in {
            "missing": {},
            "empty": {"confirm_name": ""},
            "other name": {"confirm_name": "cohere-v3-1024"},
            "wrong case": {"confirm_name": NAME.upper()},
            "trailing space": {"confirm_name": NAME + " "},
            "not text": {"confirm_name": 5},
            "extra confirm flag only": {"confirm": True},
        }.items():
            with self.subTest(label):
                response, conn = self.purge(PurgeConnection(space_row()), body={**body, "x": 1} if body else {"x": 1})
                self.assertEqual(response["statusCode"], 400, body_of(response))
                self.assert_nothing_deleted(conn)

    # ── the purge itself ──────────────────────────────────────────────────────

    def test_deletes_in_batches_until_empty_then_drops_the_index_once_and_marks_purged(self):
        conn = PurgeConnection(space_row(), delete_counts=(5000, 5000, 1234, 0))
        response, conn = self.purge(conn)
        self.assertEqual(response["statusCode"], 200, body_of(response))
        data = body_of(response)
        self.assertEqual((data["status"], data["deleted_vectors"], data["name"]), ("purged", 11234, NAME))

        deletes = conn.sql_with("DELETE FROM chunk_embeddings")
        self.assertEqual(len(deletes), 4)
        for _, params in deletes:
            self.assertEqual(params, (SPACE_ID, ea.PURGE_BATCH_SIZE))
        self.assertEqual(ea.PURGE_BATCH_SIZE, 5000)

        self.assertEqual(len(conn.sql_with("SELECT drop_space_index")), 1)
        updates = conn.sql_with("SET status = 'purged'")
        self.assertEqual(len(updates), 1)
        self.assertIn("status = 'retired'", updates[0][0])

        # The order matters for resumability: vectors, then the index, then the status.
        statements = [sql for sql, _ in conn.executed]
        last_delete = max(i for i, s in enumerate(statements) if "DELETE FROM chunk_embeddings" in s)
        drop = next(i for i, s in enumerate(statements) if "drop_space_index" in s)
        status = next(i for i, s in enumerate(statements) if "SET status = 'purged'" in s)
        self.assertLess(last_delete, drop)
        self.assertLess(drop, status)

    def test_the_purge_is_audited_before_the_first_vector_is_deleted(self):
        # The deletes commit batch by batch and cannot be undone (finding f-c47d6990).
        conn = PurgeConnection(space_row(), delete_counts=(5000, 0))
        response, conn = self.purge(conn)
        self.assertEqual(response["statusCode"], 200)
        statements = [sql for sql, _ in conn.executed]
        audit_at = next(i for i, sql in enumerate(statements) if "INSERT INTO admin_audit" in sql)
        delete_at = next(i for i, sql in enumerate(statements) if "DELETE FROM chunk_embeddings" in sql)
        self.assertLess(audit_at, delete_at)
        self.assertEqual(conn.sql_with("INSERT INTO admin_audit")[0][1][2], "embedding_space.purge")

    def test_commits_after_every_batch(self):
        conn = PurgeConnection(space_row(), delete_counts=(5000, 5000, 0))
        response, conn = self.purge(conn)
        self.assertEqual(response["statusCode"], 200)
        # one commit after the guard read, one per delete batch (3), one for the final update
        self.assertGreaterEqual(conn.commits, 5)

    def test_a_crash_mid_purge_leaves_the_space_retired_and_a_retry_resumes(self):
        conn = PurgeConnection(space_row(), delete_counts=(5000,))
        conn.fail_next("DELETE FROM chunk_embeddings", RuntimeError("connection lost"))
        response, conn = self.purge(conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(conn.sql_with("SET status = 'purged'"), [])
        self.assertGreaterEqual(conn.rollbacks, 1)
        # Retry: the space is still retired, so the same call is accepted again.
        retry = PurgeConnection(space_row(), delete_counts=(10, 0))
        response, _ = self.purge(retry)
        self.assertEqual(response["statusCode"], 200)

    def test_status_change_during_the_purge_is_reported_not_hidden(self):
        conn = PurgeConnection(space_row(), delete_counts=(0,), purge_updates=0)
        response, conn = self.purge(conn)
        self.assertEqual(response["statusCode"], 409)
        self.assertGreaterEqual(conn.rollbacks, 1)

    def test_response_and_logs_carry_no_vectors_or_text(self):
        response, _ = self.purge(PurgeConnection(space_row(), delete_counts=(3, 0)))
        self.assertEqual(set(body_of(response)), {"id", "name", "status", "deleted_vectors"})

    def test_purge_is_never_called_without_a_request(self):
        # Manual only: nothing in the module schedules or auto-invokes a purge.
        import inspect
        source = inspect.getsource(ea)
        self.assertEqual(source.count("purge_space("), 2)   # the definition and the route dispatch


class PurgedSpaceCannotComeBackTest(unittest.TestCase):
    """activate / rollback / rebuild all refuse a purged space (its vectors are gone)."""

    def setUp(self):
        patch = mock.patch.object(ea, "invoke_self")
        self.invoke = patch.start()
        self.addCleanup(patch.stop)

    def test_activate_rollback_and_jobs_are_409_for_a_purged_space(self):
        for action, body in (("activate", {}), ("rollback", {}), ("jobs", {"mode": "rebuild"}), ("validate", {})):
            with self.subTest(action=action):
                conn = fakes.ScriptedConnection({
                    "SELECT id::text, name, status FROM embedding_spaces": [(SPACE_ID, NAME, "purged")],
                    "SELECT space_id::text FROM embedding_active_space": [("11111111-1111-4111-8111-111111111111",)],
                    "SELECT cutover_locked": [UNLOCKED],
                })
                event = {
                    "httpMethod": "POST",
                    "path": f"/admin/embedding-spaces/{SPACE_ID}/{action}",
                    "resource": f"/admin/embedding-spaces/{{id}}/{action}",
                    "pathParameters": {"id": SPACE_ID},
                    "requestContext": {"authorizer": {"email": "admin@example.org", "userId": "admin-sub"}},
                    "headers": {},
                }
                response = ea.handle_embedding_request(event, body, conn)
                self.assertEqual(response["statusCode"], 409, response["body"])
                self.assertEqual(conn.sql_with("INSERT INTO embedding_jobs"), [])
        self.invoke.assert_not_called()


class ListIncludesRetentionTest(unittest.TestCase):
    def test_list_returns_purge_eligible_at_and_retention_days(self):
        eligible = NOW + timedelta(days=5)
        retired = ("22222222-2222-4222-8222-222222222222", "old", "cohere_v3", "m", "t", 1024, "1", "retired",
                   0.4, 0.6, None, None, {}, None, NOW, NOW, NOW, 10, eligible)
        conn = fakes.ScriptedConnection({
            "SELECT count(*) FROM chunks": [(10,)],
            "SELECT space_id::text FROM embedding_active_space": [("11111111-1111-4111-8111-111111111111",)],
            "FROM embedding_spaces s": [retired],
            "SELECT DISTINCT ON": [],
            "SELECT cutover_locked": [UNLOCKED],
        })
        event = {"httpMethod": "GET", "path": "/admin/embedding-spaces", "resource": "/admin/embedding-spaces",
                 "requestContext": {"authorizer": {"email": "a@b.org"}}, "headers": {}}
        data = body_of(ea.handle_embedding_request(event, {}, conn))
        self.assertEqual(data["retention_days"], 30)
        self.assertEqual(data["spaces"][0]["purge_eligible_at"], eligible.isoformat())


if __name__ == "__main__":
    unittest.main()
