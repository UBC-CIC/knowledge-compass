"""
Unit tests for helpers/embedding_admin.py (spaces, jobs, validate, cutover routes).
The database and the self-invoke are faked.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_embedding_admin.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import re
import unittest
from datetime import datetime, timezone
from unittest import mock

import _embedding_fakes as fakes
from helpers import embedding_admin as ea
from helpers.embedding_space import index_name

SPACE_ID = "22222222-2222-4222-8222-222222222222"
ACTIVE_ID = "11111111-1111-4111-8111-111111111111"
JOB_ID = "33333333-3333-4333-8333-333333333333"
NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)

UNLOCKED = (False, None, None, False)
LOCKED = (True, NOW, JOB_ID, False)
TITAN_TARGET = "arn:aws:bedrock:ca-central-1:111122223333:inference-profile/us.amazon.titan-embed-text-v2:0"


def available_models():
    """What GET /admin/embedding-models returns when every catalog model is callable."""
    return [
        {
            "provider": "cohere_v3", "label": "Cohere Embed English v3", "dimensions": [1024],
            "available": True, "model_id": "cohere.embed-english-v3",
            "invoke_target": "cohere.embed-english-v3", "cross_region": False, "unavailable_reason": None,
        },
        {
            "provider": "titan_v2", "label": "Amazon Titan Text Embeddings V2", "dimensions": [256, 512, 1024],
            "available": True, "model_id": "amazon.titan-embed-text-v2:0",
            "invoke_target": TITAN_TARGET, "cross_region": True, "unavailable_reason": None,
        },
        {
            "provider": "cohere_v4", "label": "Cohere Embed v4", "dimensions": [256, 512, 1024, 1536],
            "available": True, "model_id": "cohere.embed-v4:0",
            "invoke_target": "cohere.embed-v4:0", "cross_region": False, "unavailable_reason": None,
        },
    ]


def event(method, path, resource=None, path_id=None, email="admin@example.org"):
    return {
        "httpMethod": method,
        "path": path,
        "resource": resource or path,
        "pathParameters": {"id": path_id} if path_id else None,
        "requestContext": {"authorizer": {"email": email}} if email else {},
        "headers": {},
    }


def body_of(response):
    return json.loads(response["body"])


def valid_registration(**overrides):
    base = {
        "name": "titan-v2-1024",
        "provider": "titan_v2",
        "model_id": "amazon.titan-embed-text-v2:0",
        "invoke_target": "amazon.titan-embed-text-v2:0",
        "dimensions": 1024,
        "version": "1",
        "price_per_1m_tokens": None,
        "eol_date": None,
        "min_score": 0.4,
        "split_threshold": 0.6,
        "settings": {"concurrency": 8},
    }
    base.update(overrides)
    return base


class AdminBase(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(ea, "invoke_self")
        self.invoke = patch.start()
        self.addCleanup(patch.stop)
        models = mock.patch.object(ea.embedding_models, "list_embedding_models", return_value=available_models())
        self.list_models = models.start()
        self.addCleanup(models.stop)

    def call(self, ev, body=None, conn=None):
        conn = conn or fakes.ScriptedConnection()
        return ea.handle_embedding_request(ev, body or {}, conn), conn


class RoutingTest(unittest.TestCase):
    def test_every_route_and_method_is_recognised(self):
        cases = [
            ("GET", "/admin/embedding-models", None),
            ("GET", "/admin/embedding-spaces", None),
            ("POST", "/admin/embedding-spaces", None),
            ("POST", f"/prod/admin/embedding-spaces/{SPACE_ID}/jobs", "/admin/embedding-spaces/{id}/jobs"),
            ("POST", f"/admin/embedding-spaces/{SPACE_ID}/validate", "/admin/embedding-spaces/{id}/validate"),
            ("POST", f"/admin/embedding-spaces/{SPACE_ID}/activate", "/admin/embedding-spaces/{id}/activate"),
            ("POST", f"/admin/embedding-spaces/{SPACE_ID}/rollback", "/admin/embedding-spaces/{id}/rollback"),
            ("POST", f"/admin/embedding-spaces/{SPACE_ID}/purge", "/admin/embedding-spaces/{id}/purge"),
            ("GET", f"/admin/embedding-jobs/{JOB_ID}", "/admin/embedding-jobs/{id}"),
        ]
        for method, path, resource in cases:
            with self.subTest(route=f"{method} {resource or path}"):
                self.assertTrue(ea.is_embedding_route(event(method, path, resource)))

    def test_other_methods_and_paths_are_not_ours(self):
        for method, path in [
            ("DELETE", "/admin/embedding-spaces"),
            ("GET", f"/admin/embedding-spaces/{SPACE_ID}/jobs"),
            ("GET", f"/admin/embedding-spaces/{SPACE_ID}/activate"),
            ("POST", f"/admin/embedding-jobs/{JOB_ID}"),
            ("POST", "/admin/data_sources"),
            ("POST", f"/admin/data_sources/{SPACE_ID}/retry"),
            ("GET", "/admin/guideline"),
            ("GET", "/admin/embedding-spaces-extra"),
        ]:
            with self.subTest(route=f"{method} {path}"):
                self.assertFalse(ea.is_embedding_route(event(method, path)))

    def test_routes_table_matches_the_documented_shape(self):
        self.assertEqual(len(ea._ROUTES), 9)
        for method, resource, pattern in ea._ROUTES:
            self.assertIn(method, ("GET", "POST"))
            self.assertTrue(resource.startswith("/admin/embedding-"))
            self.assertIsInstance(pattern, re.Pattern)


class AuthTest(AdminBase):
    MUTATING = [
        ("POST", "/admin/embedding-spaces", None, None),
        ("POST", f"/admin/embedding-spaces/{SPACE_ID}/jobs", "/admin/embedding-spaces/{id}/jobs", SPACE_ID),
        ("POST", f"/admin/embedding-spaces/{SPACE_ID}/validate", "/admin/embedding-spaces/{id}/validate", SPACE_ID),
        ("POST", f"/admin/embedding-spaces/{SPACE_ID}/activate", "/admin/embedding-spaces/{id}/activate", SPACE_ID),
        ("POST", f"/admin/embedding-spaces/{SPACE_ID}/rollback", "/admin/embedding-spaces/{id}/rollback", SPACE_ID),
        ("POST", f"/admin/embedding-spaces/{SPACE_ID}/purge", "/admin/embedding-spaces/{id}/purge", SPACE_ID),
    ]

    def test_mutating_routes_refuse_without_the_authorizer_email(self):
        for method, path, resource, path_id in self.MUTATING:
            with self.subTest(route=path):
                response, conn = self.call(event(method, path, resource, path_id, email=None),
                                           {"created_by": "attacker@example.org", "mode": "rebuild"})
                self.assertEqual(response["statusCode"], 401)
                self.assertEqual(conn.executed, [])
        self.invoke.assert_not_called()

    def test_a_body_supplied_email_is_ignored(self):
        conn = fakes.ScriptedConnection({
            "SELECT 1 FROM embedding_spaces WHERE name": [],
            "INSERT INTO embedding_spaces": [(SPACE_ID,)],
            "SELECT create_space_index": [("idx",)],
        })
        response, _ = self.call(event("POST", "/admin/embedding-spaces", email="real@example.org"),
                                valid_registration(created_by="attacker@example.org"), conn)
        self.assertEqual(response["statusCode"], 201)
        insert = conn.sql_with("INSERT INTO embedding_spaces")[0]
        self.assertIn("real@example.org", insert[1])
        self.assertNotIn("attacker@example.org", insert[1])

    def test_get_routes_do_not_need_the_email(self):
        conn = fakes.ScriptedConnection({"SELECT count(*) FROM chunks": [(0,)]})
        response, _ = self.call(event("GET", "/admin/embedding-spaces", email=None), conn=conn)
        self.assertEqual(response["statusCode"], 200)

    def test_invalid_ids_are_rejected_before_any_query(self):
        response, conn = self.call(
            event("POST", "/admin/embedding-spaces/not-a-uuid/jobs", "/admin/embedding-spaces/{id}/jobs", "not-a-uuid"),
            {"mode": "rebuild"})
        self.assertEqual(response["statusCode"], 400)
        self.assertEqual(conn.executed, [])


class RegisterTest(AdminBase):
    def register(self, body, conn=None):
        conn = conn or fakes.ScriptedConnection({
            "SELECT 1 FROM embedding_spaces WHERE name": [],
            "INSERT INTO embedding_spaces": [(SPACE_ID,)],
            "SELECT create_space_index": [("idx",)],
        })
        response, conn = self.call(event("POST", "/admin/embedding-spaces"), body, conn)
        return response, conn

    def test_valid_registration_creates_the_space_and_its_index_once(self):
        response, conn = self.register(valid_registration())
        self.assertEqual(response["statusCode"], 201)
        self.assertEqual(body_of(response), {
            "id": SPACE_ID, "name": "titan-v2-1024", "status": "building", "index_name": index_name(SPACE_ID),
        })
        index_calls = conn.sql_with("SELECT create_space_index")
        self.assertEqual(len(index_calls), 1)
        self.assertEqual(index_calls[0][1], (SPACE_ID,))
        insert = conn.sql_with("INSERT INTO embedding_spaces")[0]
        self.assertIn("'building'", insert[0])
        self.assertEqual(insert[1][0], "titan-v2-1024")
        self.assertEqual(insert[1][2], "amazon.titan-embed-text-v2:0")
        self.assertEqual(insert[1][3], TITAN_TARGET)
        self.assertEqual(json.loads(insert[1][10]), {"concurrency": 8})
        self.assertEqual(insert[1][11], "admin@example.org")
        self.assertEqual(conn.commits, 1)   # space row and index in the same transaction

    def test_registration_does_not_require_a_model_id_or_arn(self):
        body = valid_registration()
        del body["model_id"], body["invoke_target"]
        response, conn = self.register(body)
        self.assertEqual(response["statusCode"], 201)
        params = conn.sql_with("INSERT INTO embedding_spaces")[0][1]
        self.assertEqual(params[2], "amazon.titan-embed-text-v2:0")
        self.assertEqual(params[3], TITAN_TARGET)

    def test_a_client_sent_model_id_or_arn_is_ignored(self):
        response, conn = self.register(valid_registration(
            model_id="not-from-bedrock",
            invoke_target="arn:aws:bedrock:us-east-1:1:inference-profile/custom",
        ))
        self.assertEqual(response["statusCode"], 201)
        params = conn.sql_with("INSERT INTO embedding_spaces")[0][1]
        self.assertEqual(params[2], "amazon.titan-embed-text-v2:0")
        self.assertEqual(params[3], TITAN_TARGET)
        self.assertNotIn("custom", params[3])

    def test_an_unavailable_model_is_refused_before_the_database(self):
        models = available_models()
        models[1] = {
            **models[1], "available": False, "model_id": None, "invoke_target": None,
            "unavailable_reason": "This model is not available in Amazon Bedrock for this account.",
        }
        self.list_models.return_value = models
        response, conn = self.register(valid_registration())
        self.assertEqual(response["statusCode"], 400)
        self.assertIn("not available", body_of(response)["error"])
        self.assertEqual(conn.executed, [])

    def test_a_lookup_failure_does_not_register(self):
        self.list_models.side_effect = RuntimeError("denied")
        response, conn = self.register(valid_registration())
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(body_of(response)["error"], ea.LOOKUP_ERROR)
        self.assertEqual(conn.executed, [])

    def test_get_models_returns_the_bedrock_list_without_a_database_query(self):
        response, conn = self.call(event("GET", "/admin/embedding-models", email=None))
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(conn.executed, [])
        models = body_of(response)["models"]
        self.assertEqual([m["provider"] for m in models], ["cohere_v3", "titan_v2", "cohere_v4"])
        self.assertEqual(models[1]["invoke_target"], TITAN_TARGET)

    def test_a_model_lookup_failure_is_503(self):
        self.list_models.side_effect = RuntimeError("denied")
        response, conn = self.call(event("GET", "/admin/embedding-models"))
        self.assertEqual(response["statusCode"], 503)
        self.assertEqual(body_of(response)["error"], ea.LOOKUP_ERROR)
        self.assertEqual(conn.executed, [])

    def test_price_and_eol_are_optional(self):
        body = valid_registration()
        del body["price_per_1m_tokens"], body["eol_date"], body["min_score"], body["split_threshold"], body["settings"], body["version"]
        response, conn = self.register(body)
        self.assertEqual(response["statusCode"], 201)
        params = conn.sql_with("INSERT INTO embedding_spaces")[0][1]
        self.assertIsNone(params[8])   # price
        self.assertIsNone(params[9])   # eol

    def test_validation_matrix(self):
        bad = {
            "name too short": {"name": "ab"},
            "name uppercase": {"name": "Titan-V2"},
            "name leading dash": {"name": "-titan"},
            "name too long": {"name": "a" * 64},
            "name not text": {"name": 5},
            "unknown provider": {"provider": "openai"},
            "provider not text": {"provider": None},
            "dimensions not allowed for provider": {"dimensions": 768},
            "dimensions text": {"dimensions": "1024"},
            "dimensions bool": {"dimensions": True},
            "version too long": {"version": "v" * 33},
            "price negative": {"price_per_1m_tokens": -0.01},
            "price text": {"price_per_1m_tokens": "0.02"},
            "price nan": {"price_per_1m_tokens": float("nan")},
            "price infinite": {"price_per_1m_tokens": float("inf")},
            "eol wrong format": {"eol_date": "01/02/2026"},
            "eol impossible": {"eol_date": "2026-13-45"},
            "eol compact iso": {"eol_date": "20260101"},
            "min_score above 1": {"min_score": 1.5},
            "min_score negative": {"min_score": -0.1},
            "split_threshold text": {"split_threshold": "0.5"},
            "settings not object": {"settings": [1]},
            "settings unknown key": {"settings": {"api_key": "x"}},
            "settings batch_size zero": {"settings": {"batch_size": 0}},
            "settings batch_size too big": {"settings": {"batch_size": 257}},
            "settings max_chars tiny": {"settings": {"max_chars": 10}},
            "settings concurrency float": {"settings": {"concurrency": 2.5}},
            "settings normalize text": {"settings": {"normalize": "yes"}},
        }
        for label, override in bad.items():
            with self.subTest(label):
                response, conn = self.register(valid_registration(**override))
                self.assertEqual(response["statusCode"], 400, body_of(response))
                self.assertIn("error", body_of(response))
                self.assertEqual(conn.executed, [])   # rejected before touching the database

    def test_provider_specific_limits_are_enforced(self):
        # Cohere v3 allows only 1024 dimensions and a batch of at most 96.
        response, _ = self.register(valid_registration(provider="cohere_v3", dimensions=512, settings={}))
        self.assertEqual(response["statusCode"], 400)
        response, _ = self.register(valid_registration(provider="cohere_v3", dimensions=1024, settings={"batch_size": 200}))
        self.assertEqual(response["statusCode"], 400)

    def test_accepted_edge_values(self):
        response, _ = self.register(valid_registration(
            name="abc", dimensions=256, price_per_1m_tokens=0, min_score=0, split_threshold=1,
            eol_date="2027-02-28", settings={"normalize": False, "max_chars": 100, "batch_size": 1}))
        self.assertEqual(response["statusCode"], 201)

    def test_duplicate_name_is_a_409(self):
        conn = fakes.ScriptedConnection({"SELECT 1 FROM embedding_spaces WHERE name": [(1,)]})
        response, conn = self.register(valid_registration(), conn)
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(conn.sql_with("create_space_index"), [])

    def test_unique_violation_race_is_also_a_409(self):
        class Dup(Exception):
            pgcode = "23505"

        conn = fakes.ScriptedConnection({"SELECT 1 FROM embedding_spaces WHERE name": []})
        conn.fail_next("INSERT INTO embedding_spaces", Dup())
        response, conn = self.register(valid_registration(), conn)
        self.assertEqual(response["statusCode"], 409)
        self.assertGreaterEqual(conn.rollbacks, 1)

    def test_index_failure_rolls_the_space_back(self):
        conn = fakes.ScriptedConnection({
            "SELECT 1 FROM embedding_spaces WHERE name": [],
            "INSERT INTO embedding_spaces": [(SPACE_ID,)],
        })
        conn.fail_next("SELECT create_space_index", RuntimeError("no privilege"))
        response, conn = self.register(valid_registration(), conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(conn.commits, 0)
        self.assertGreaterEqual(conn.rollbacks, 1)


def lock_rows(row=UNLOCKED):
    return {"SELECT cutover_locked": [row]}


class JobCreationTest(AdminBase):
    PATH = f"/admin/embedding-spaces/{SPACE_ID}/jobs"
    RESOURCE = "/admin/embedding-spaces/{id}/jobs"

    def conn(self, status="building", running=None, lock=UNLOCKED, space=True):
        responses = {
            "SELECT id::text, name, status FROM embedding_spaces": [(SPACE_ID, "new-space", status)] if space else [],
            **lock_rows(lock),
            "SELECT id::text FROM embedding_jobs WHERE status IN": [(running,)] if running else [],
            "INSERT INTO embedding_jobs": [(JOB_ID,)],
        }
        return fakes.ScriptedConnection(responses)

    def post(self, body, conn):
        return self.call(event("POST", self.PATH, self.RESOURCE, SPACE_ID), body, conn)

    def test_each_mode_creates_a_queued_job_and_starts_the_worker(self):
        for mode in ("dry_run", "rebuild", "delta"):
            with self.subTest(mode=mode):
                self.invoke.reset_mock()
                response, conn = self.post({"mode": mode}, self.conn())
                self.assertEqual(response["statusCode"], 202)
                self.assertEqual(body_of(response)["job_id"], JOB_ID)
                self.assertEqual(body_of(response)["status"], "queued")
                insert = conn.sql_with("INSERT INTO embedding_jobs")[0]
                self.assertEqual(insert[1][:3], (SPACE_ID, mode, "admin@example.org"))
                self.invoke.assert_called_once_with({"task": "reembed_space", "job_id": JOB_ID, "continuation": 0})

    def test_bad_mode_is_rejected(self):
        for mode in (None, "validate", "activate", "purge", 1):
            with self.subTest(mode=mode):
                response, _ = self.post({"mode": mode}, self.conn())
                self.assertEqual(response["statusCode"], 400)
        self.invoke.assert_not_called()

    def test_unknown_space_is_404(self):
        response, _ = self.post({"mode": "rebuild"}, self.conn(space=False))
        self.assertEqual(response["statusCode"], 404)

    def test_purged_space_is_409(self):
        response, _ = self.post({"mode": "rebuild"}, self.conn(status="purged"))
        self.assertEqual(response["statusCode"], 409)

    def test_running_rebuild_is_409_and_names_the_job(self):
        response, conn = self.post({"mode": "rebuild"}, self.conn(running=JOB_ID))
        self.assertEqual(response["statusCode"], 409)
        self.assertEqual(body_of(response)["job_id"], JOB_ID)
        self.assertEqual(conn.sql_with("INSERT INTO embedding_jobs"), [])
        self.invoke.assert_not_called()

    def test_running_rebuild_check_is_scoped_to_the_space_and_modes(self):
        _, conn = self.post({"mode": "delta"}, self.conn())
        sql, params = conn.sql_with("SELECT id::text FROM embedding_jobs WHERE status IN")[0]
        self.assertIn("mode = ANY(%s)", sql)
        self.assertEqual(params, (["rebuild", "delta"], SPACE_ID))

    def test_unique_index_race_is_a_clean_409(self):
        class Dup(Exception):
            pgcode = "23505"

        conn = self.conn()
        conn.fail_next("INSERT INTO embedding_jobs", Dup())
        response, _ = self.post({"mode": "rebuild"}, conn)
        self.assertEqual(response["statusCode"], 409)

    def test_cutover_lock_is_a_409_with_the_lock_code(self):
        for mode in ("dry_run", "rebuild", "delta"):
            with self.subTest(mode=mode):
                response, _ = self.post({"mode": mode}, self.conn(lock=LOCKED))
                self.assertEqual(response["statusCode"], 409)
                self.assertEqual(body_of(response)["code"], "CUTOVER_LOCKED")
        self.invoke.assert_not_called()

    def test_stalled_jobs_are_reaped_before_the_conflict_check(self):
        _, conn = self.post({"mode": "rebuild"}, self.conn())
        sql = [s for s, _ in conn.executed]
        reap = next(i for i, s in enumerate(sql) if "UPDATE embedding_jobs SET status = 'failed'" in s)
        check = next(i for i, s in enumerate(sql) if "SELECT id::text FROM embedding_jobs" in s)
        self.assertLess(reap, check)
        self.assertEqual(conn.sql_with("UPDATE embedding_jobs SET status = 'failed'")[0][1][1], ea.STALE_REBUILD_SECONDS)

    def test_failure_to_start_the_worker_fails_the_job_and_returns_502(self):
        self.invoke.side_effect = RuntimeError("lambda down")
        response, conn = self.post({"mode": "rebuild"}, self.conn())
        self.assertEqual(response["statusCode"], 502)
        failed = conn.sql_with("UPDATE embedding_jobs SET status = 'failed', finished_at = now()")
        self.assertTrue(failed)
        self.assertEqual(failed[-1][1], ("The job could not be started", JOB_ID))


class ValidateRouteTest(AdminBase):
    PATH = f"/admin/embedding-spaces/{SPACE_ID}/validate"
    RESOURCE = "/admin/embedding-spaces/{id}/validate"

    def conn(self, status="building", space=True):
        return fakes.ScriptedConnection({
            "SELECT id::text, name, status FROM embedding_spaces": [(SPACE_ID, "n", status)] if space else [],
            "INSERT INTO embedding_jobs": [(JOB_ID,)],
        })

    def post(self, body, conn):
        return self.call(event("POST", self.PATH, self.RESOURCE, SPACE_ID), body, conn)

    def test_creates_a_validate_job(self):
        for status in ("building", "validated"):
            with self.subTest(status=status):
                self.invoke.reset_mock()
                response, conn = self.post({"tolerance": 0.1, "skip_quality": True}, self.conn(status))
                self.assertEqual(response["statusCode"], 202)
                insert = conn.sql_with("INSERT INTO embedding_jobs")[0][1]
                self.assertEqual(insert[:2], (SPACE_ID, "validate"))
                self.assertEqual(json.loads(insert[3]), {"request": {"tolerance": 0.1, "skip_quality": True}})
                self.invoke.assert_called_once_with({"task": "validate_space", "job_id": JOB_ID, "continuation": 0})

    def test_active_retired_and_purged_spaces_are_409(self):
        for status in ("active", "retired", "purged"):
            with self.subTest(status=status):
                response, _ = self.post({}, self.conn(status))
                self.assertEqual(response["statusCode"], 409)

    def test_unknown_space_404_and_bad_options_400(self):
        self.assertEqual(self.post({}, self.conn(space=False))[0]["statusCode"], 404)
        for body in ({"tolerance": 0.9}, {"tolerance": -0.1}, {"tolerance": "x"}, {"skip_quality": "yes"}):
            with self.subTest(body=body):
                self.assertEqual(self.post(body, self.conn())[0]["statusCode"], 400)


class GetJobTest(AdminBase):
    PATH = f"/admin/embedding-jobs/{JOB_ID}"
    RESOURCE = "/admin/embedding-jobs/{id}"

    def row(self, **over):
        job = {
            "id": JOB_ID, "space_id": SPACE_ID, "mode": "rebuild", "status": "running", "total_chunks": 200,
            "processed": 50, "failed": 0, "est_tokens": None, "est_cost_usd": None, "est_seconds": None,
            "price_configured": False, "cursor": "00000000-0000-4000-8000-000000000050", "continuation": 1,
            "current_step": None, "steps": [], "report": None, "last_error": None, "requested_by": "a@b.org",
        }
        job.update(over)
        return (job["id"], job["space_id"], job["mode"], job["status"], job["total_chunks"], job["processed"],
                job["failed"], job["est_tokens"], job["est_cost_usd"], job["est_seconds"], job["price_configured"],
                job["cursor"], job["continuation"], job["current_step"], job["steps"], job["report"],
                job["last_error"], job["requested_by"], NOW, NOW, None, NOW)

    def get(self, row=None):
        conn = fakes.ScriptedConnection({"FROM embedding_jobs WHERE id": [row] if row else []})
        return self.call(event("GET", self.PATH, self.RESOURCE, JOB_ID), conn=conn)

    def test_returns_progress_and_hides_the_internal_cursor(self):
        response, _ = self.get(self.row())
        job = body_of(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual((job["processed"], job["total_chunks"], job["progress_percent"]), (50, 200, 25.0))
        self.assertNotIn("cursor", job)
        self.assertEqual(job["created_at"], NOW.isoformat())

    def test_dry_run_estimate_says_price_not_configured(self):
        row = self.row(mode="dry_run", status="succeeded", est_tokens=1000, est_seconds=12,
                       report={"chunks_to_embed": 10, "characters": 4000})
        job = body_of(self.get(row)[0])
        self.assertEqual(job["est_tokens"], 1000)
        self.assertIsNone(job["est_cost_usd"])
        self.assertEqual(job["cost_note"], "price not configured")
        self.assertEqual(job["report"]["characters"], 4000)

    def test_steps_and_report_pass_through(self):
        steps = [{"name": "lock", "status": "done", "started_at": None, "finished_at": None, "detail": None}]
        job = body_of(self.get(self.row(mode="activate", steps=steps, current_step="wait_idle"))[0])
        self.assertEqual(job["steps"], steps)
        self.assertEqual(job["current_step"], "wait_idle")

    def test_unknown_job_is_404(self):
        self.assertEqual(self.get(None)[0]["statusCode"], 404)


class ListTest(AdminBase):
    def test_lists_spaces_with_coverage_lock_and_latest_job(self):
        space_row = (SPACE_ID, "new-space", "titan_v2", "m", "t", 1024, "1", "building", None, None, None, None,
                     {"concurrency": 8}, "a@b.org", NOW, None, None, 60, None)
        active_row = (ACTIVE_ID, "cohere-v3-1024", "cohere_v3", "m", "t", 1024, "1", "active", 0.4, 0.6, None, None,
                      {}, None, NOW, NOW, None, 100, None)
        job_row = GetJobTest().row(status="running")
        conn = fakes.ScriptedConnection({
            "SELECT count(*) FROM chunks": [(100,)],
            "SELECT space_id::text FROM embedding_active_space": [(ACTIVE_ID,)],
            "FROM embedding_spaces s": [space_row, active_row],
            "SELECT DISTINCT ON": [job_row],
            "SELECT cutover_locked": [LOCKED],
        })
        response, _ = self.call(event("GET", "/admin/embedding-spaces"), conn=conn)
        data = body_of(response)
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(data["active_space_id"], ACTIVE_ID)
        self.assertTrue(data["cutover_locked"])
        new, active = data["spaces"]
        self.assertEqual(new["coverage"], {"current_vectors": 60, "total_chunks": 100, "percent": 60.0})
        self.assertFalse(new["is_active"])
        self.assertTrue(active["is_active"])
        self.assertEqual(new["latest_job"]["status"], "running")
        self.assertIsNone(active["latest_job"])
        self.assertIsNone(new["price_per_1m_tokens"])
        self.assertNotIn("report", new["latest_job"])

    def test_empty_corpus_has_no_percent(self):
        conn = fakes.ScriptedConnection({"SELECT count(*) FROM chunks": [(0,)]})
        data = body_of(self.call(event("GET", "/admin/embedding-spaces"), conn=conn)[0])
        self.assertEqual(data["spaces"], [])


class ErrorHandlingTest(AdminBase):
    def test_unexpected_errors_are_a_generic_500_with_a_rollback(self):
        conn = fakes.ScriptedConnection()
        conn.fail_next("SELECT count(*) FROM chunks", RuntimeError("password=hunter2"))
        response, conn = self.call(event("GET", "/admin/embedding-spaces"), conn=conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("hunter2", response["body"])
        self.assertEqual(conn.rollbacks, 1)


if __name__ == "__main__":
    unittest.main()
