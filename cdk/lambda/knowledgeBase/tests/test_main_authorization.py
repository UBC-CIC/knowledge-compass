"""
main.handler authorization (finding f-7f03f151):
- self-invoked {task} events run only with the worker invoke token;
- EventBridge events (aws.ecs / aws.transcribe) need the same token, which
  transcribeRelay adds (finding f-9d5748bc);
- API Gateway events need requestContext.authorizer.role == "admin";
- only allow-listed routing fields are logged (finding f-342ab3ef).
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

    def test_forged_eventbridge_events_are_rejected(self):
        # Finding f-9d5748bc: a direct invoke with {"source": "aws.ecs"} or
        # {"source": "aws.transcribe"} reached the DB handlers with no check.
        events = {
            "handle_ecs_task_stopped": {"source": "aws.ecs", "detail-type": "ECS Task State Change",
                                        "detail": {"taskArn": "arn:aws:ecs:us-east-1:0:task/c/t"}},
            "handle_transcribe_complete": {"source": "aws.transcribe", "detail-type": "Transcribe Job State Change",
                                           "detail": {"TranscriptionJobName": "job-1"}},
        }
        for attr, event in events.items():
            for token in (None, "forged-token"):
                forged = dict(event) if token is None else {**event, "invoke_token": token}
                with self.subTest(handler=attr, token=token), mock.patch.object(self.main, attr) as fn:
                    with self.assertLogs(level="WARNING") as logs:
                        result = self.main.handler(forged)
                    self.assertEqual(result, {"error": "Unauthorized worker invocation"})
                    fn.assert_not_called()
                    self.connect.assert_not_called()
                    self.assertIn(f"source={event['source']}", "\n".join(logs.output))
                    self.assertNotIn("forged-token", "\n".join(logs.output))

    def test_relayed_eventbridge_events_with_the_token_run(self):
        # transcribeRelay adds the invoke token to genuine EventBridge events.
        with mock.patch.object(self.main, "handle_ecs_task_stopped", return_value={"ok": 1}) as ecs, \
                self.assertLogs(level="INFO") as logs:
            self.assertEqual(
                self.main.handler({"source": "aws.ecs", "detail": {}, "invoke_token": TEST_INVOKE_TOKEN}),
                {"ok": 1},
            )
        ecs.assert_called_once()
        self.assertNotIn(TEST_INVOKE_TOKEN, "\n".join(logs.output))
        with mock.patch.object(self.main, "handle_transcribe_complete", return_value={"ok": 2}) as tr:
            self.assertEqual(
                self.main.handler({"source": "aws.transcribe", "detail": {}, "invoke_token": TEST_INVOKE_TOKEN}),
                {"ok": 2},
            )
        tr.assert_called_once()

    def test_api_gateway_event_cannot_reach_the_eventbridge_branches(self):
        # A REST proxy event's top-level keys are set by API Gateway, so a
        # client can only put "source" in the body; it then hits the admin gate.
        event = api_event(role=None)
        event["body"] = json.dumps({"source": "aws.ecs", "detail": {"taskArn": "t"}})
        with mock.patch.object(self.main, "handle_ecs_task_stopped") as ecs:
            response = self.main.handler(event)
        self.assertEqual(response["statusCode"], 403)
        ecs.assert_not_called()


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

    def test_no_header_query_cookie_identity_or_body_value_is_logged(self):
        # Finding f-342ab3ef: only allow-listed routing fields may be logged.
        event = api_event(role="admin")
        event["requestContext"]["authorizer"]["tokenId"] = "secret-token-id"
        event["requestContext"]["authorizer"]["email"] = "secret-admin@example.org"
        event["requestContext"]["identity"] = {"sourceIp": "203.0.113.9", "userAgent": "secret-agent"}
        event["headers"] = {
            "Authorization": "Bearer secret-bearer",
            "Cookie": "session=secret-cookie",
            "X-Amz-Security-Token": "secret-sts",
            "X-Api-Key": "secret-api-key",
        }
        event["multiValueHeaders"] = {k: [v] for k, v in event["headers"].items()}
        event["queryStringParameters"] = {"token": "secret-query"}
        event["multiValueQueryStringParameters"] = {"token": ["secret-query"]}
        event["cookies"] = ["session=secret-cookie-v2"]
        event["body"] = json.dumps({"name": "secret-body"})
        with self.assertLogs(level="DEBUG") as logs:
            self.main.handler(event)
        output = "\n".join(logs.output)
        for marker in ("secret-", "203.0.113.9", "Authorization", "Cookie"):
            self.assertNotIn(marker, output)
        self.assertIn("req-1", output)

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
