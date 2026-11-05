"""
main.handler authorization (finding f-7f03f151):
- self-invoked {task} events run only with the worker invoke token;
- EventBridge events (aws.ecs / aws.transcribe) still run without one;
- API Gateway events need requestContext.authorizer.role == "admin".
No AWS, no database.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_main_authorization.py"
"""

import _setup  # noqa: F401  (must be first)
from _setup import TEST_INVOKE_TOKEN

import json
import os
import unittest
from unittest import mock

from test_worker_actor import _import_main


def api_event(role=None, resource="/admin/guideline", method="GET"):
    authorizer = {"userId": "sub-1", "email": "admin@example.org"}
    if role is not None:
        authorizer["role"] = role
    return {
        "httpMethod": method,
        "resource": resource,
        "path": resource,
        "headers": {},
        "requestContext": {"requestId": "req-1", "authorizer": authorizer},
    }


class WorkerTokenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = _import_main()

    def setUp(self):
        self.connect = mock.patch.object(self.main, "_connect_to_db", return_value=mock.MagicMock()).start()
        self.addCleanup(mock.patch.stopall)
        self.worker = mock.Mock(return_value={"status": "succeeded"})
        mock.patch.dict(self.main._EMBEDDING_TASKS, {"validate_space": self.worker}).start()

    def _assert_rejected(self, event):
        with self.assertLogs(level="WARNING") as logs:
            result = self.main.handler(event)
        self.assertEqual(result, {"error": "Unauthorized worker invocation"})
        self.connect.assert_not_called()
        output = "\n".join(logs.output)
        self.assertIn(f"task={event['task']}", output)
        self.assertNotIn(TEST_INVOKE_TOKEN, output)
        return output

    def test_task_without_a_token_is_rejected(self):
        self._assert_rejected({"task": "validate_space", "job_id": "j"})
        self.worker.assert_not_called()

    def test_task_with_a_wrong_token_is_rejected_and_not_logged(self):
        output = self._assert_rejected({"task": "validate_space", "job_id": "j", "invoke_token": "forged-token"})
        self.assertNotIn("forged-token", output)
        self.worker.assert_not_called()

    def test_task_with_the_right_token_runs_and_the_token_is_never_logged(self):
        with self.assertLogs(level="INFO") as logs:
            self.main.handler({"task": "validate_space", "job_id": "j", "invoke_token": TEST_INVOKE_TOKEN})
        self.worker.assert_called_once()
        self.assertNotIn(TEST_INVOKE_TOKEN, "\n".join(logs.output))

    def test_every_worker_branch_requires_the_token(self):
        patches = {
            "process_document_batch": "process_document_batch",
            "process_csv_links": "process_csv_links",
            "process_guideline_document": "process_guideline_document",
            "reembed_guideline_sections": "reembed_guideline_sections",
        }
        for task, attr in patches.items():
            with self.subTest(task=task), mock.patch.object(self.main, attr) as fn:
                self._assert_rejected({"task": task})
                fn.assert_not_called()
        for task in ("reembed_space", "activate_space", "rollback_space"):
            fn = mock.Mock()
            with self.subTest(task=task), mock.patch.dict(self.main._EMBEDDING_TASKS, {task: fn}):
                self._assert_rejected({"task": task})
                fn.assert_not_called()

    def test_eventbridge_events_need_no_token(self):
        with mock.patch.object(self.main, "handle_ecs_task_stopped", return_value={"ok": 1}) as ecs:
            self.assertEqual(self.main.handler({"source": "aws.ecs", "detail": {}}), {"ok": 1})
        ecs.assert_called_once()
        with mock.patch.object(self.main, "handle_transcribe_complete", return_value={"ok": 2}) as tr:
            self.assertEqual(self.main.handler({"source": "aws.transcribe", "detail": {}}), {"ok": 2})
        tr.assert_called_once()


class AdminGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = _import_main()

    def setUp(self):
        self.connect = mock.patch.object(self.main, "_connect_to_db", return_value=mock.MagicMock()).start()
        self.guideline = mock.patch.object(
            self.main, "handle_guideline_request", return_value={"statusCode": 200}
        ).start()
        self.addCleanup(mock.patch.stopall)

    def test_missing_or_non_admin_role_is_403(self):
        for role in (None, "user", "Admin", ""):
            with self.subTest(role=role):
                response = self.main.handler(api_event(role=role))
                self.assertEqual(response["statusCode"], 403)
                self.assertEqual(json.loads(response["body"]), {"error": "Admin access required"})
        self.guideline.assert_not_called()
        self.connect.assert_not_called()

    def test_admin_role_reaches_the_route(self):
        self.assertEqual(self.main.handler(api_event(role="admin")), {"statusCode": 200})
        self.guideline.assert_called_once()

    def test_authorization_header_is_never_logged(self):
        event = api_event(role="admin")
        event["headers"] = {"Authorization": "Bearer admin-id-token-secret"}
        event["multiValueHeaders"] = {"Authorization": ["Bearer admin-id-token-secret"]}
        with self.assertLogs(level="INFO") as logs:
            self.main.handler(event)
        output = "\n".join(logs.output)
        self.assertNotIn("admin-id-token-secret", output)
        self.assertIn("/admin/guideline", output)

    def test_presigned_url_route_is_gated_too(self):
        with mock.patch.object(self.main, "generate_presigned_url") as presign:
            response = self.main.handler(api_event(role="user", resource="/admin/generate-presigned-url"))
        self.assertEqual(response["statusCode"], 403)
        presign.assert_not_called()


class DbTlsTests(unittest.TestCase):
    """The DB connection verifies the server certificate and hostname, not just encryption."""

    def test_connect_uses_verify_full_with_a_real_ca_bundle(self):
        main = _import_main()
        secret = {"dbname": "d", "username": "u", "password": "p", "port": 5432}
        with mock.patch.object(main, "connection", None), \
                mock.patch.object(main, "_get_secret", return_value=secret), \
                mock.patch.object(main.psycopg2, "connect", create=True) as connect:
            main._connect_to_db()
        kwargs = connect.call_args.kwargs
        self.assertEqual(kwargs["sslmode"], "verify-full")
        self.assertTrue(os.path.isfile(kwargs["sslrootcert"]))


if __name__ == "__main__":
    unittest.main()
