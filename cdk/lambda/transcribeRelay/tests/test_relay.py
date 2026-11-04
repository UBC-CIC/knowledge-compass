"""
transcribeRelay (finding f-9d5748bc): genuine EventBridge events reach
lambdaKnowledgeBase with the worker invoke token and only the id field the
handler reads; anything else is dropped. No AWS.

Run from transcribeRelay:  python -m unittest discover -s tests -p "test_*.py"
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["AWS_ACCESS_KEY_ID"] = "testing"
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
os.environ.pop("AWS_PROFILE", None)
os.environ["TARGET_FUNCTION_NAME"] = "KC-Api-lambdaKnowledgeBase"
os.environ["WORKER_INVOKE_SECRET_NAME"] = "KC-Api-KC-WorkerInvokeSecret"

import index  # noqa: E402

TOKEN = "relay-test-token"

ECS_EVENT = {
    "version": "0", "id": "e-1", "source": "aws.ecs", "detail-type": "ECS Task State Change",
    "account": "000000000000", "region": "us-east-1",
    "detail": {"taskArn": "arn:aws:ecs:us-east-1:000000000000:task/c/t", "lastStatus": "STOPPED",
               "clusterArn": "arn:aws:ecs:us-east-1:000000000000:cluster/c", "stoppedReason": "x"},
}
TRANSCRIBE_EVENT = {
    "version": "0", "id": "e-2", "source": "aws.transcribe", "detail-type": "Transcribe Job State Change",
    "detail": {"TranscriptionJobName": "job-1", "TranscriptionJobStatus": "COMPLETED"},
}


class RelayTests(unittest.TestCase):
    def setUp(self):
        index._cached_token, index._cached_at = None, 0.0
        self.invoke = mock.patch.object(index.lambda_client, "invoke").start()
        self.get_secret = mock.patch.object(
            index.secrets_client, "get_secret_value",
            return_value={"SecretString": json.dumps({"token": TOKEN, "previousToken": "old"})},
        ).start()
        self.addCleanup(mock.patch.stopall)

    def _forwarded(self):
        self.invoke.assert_called_once()
        kwargs = self.invoke.call_args.kwargs
        self.assertEqual(kwargs["FunctionName"], "KC-Api-lambdaKnowledgeBase")
        self.assertEqual(kwargs["InvocationType"], "Event")
        return json.loads(kwargs["Payload"])

    def test_ecs_task_stopped_is_forwarded_with_the_token_and_only_the_task_arn(self):
        self.assertEqual(index.handler(ECS_EVENT, None), {"ok": True})
        self.assertEqual(self._forwarded(), {
            "source": "aws.ecs", "detail-type": "ECS Task State Change",
            "detail": {"taskArn": ECS_EVENT["detail"]["taskArn"]}, "invoke_token": TOKEN,
        })
        self.get_secret.assert_called_once_with(SecretId="KC-Api-KC-WorkerInvokeSecret")

    def test_transcribe_complete_is_forwarded_with_the_token_and_only_the_job_name(self):
        self.assertEqual(index.handler(TRANSCRIBE_EVENT, None), {"ok": True})
        self.assertEqual(self._forwarded(), {
            "source": "aws.transcribe", "detail-type": "Transcribe Job State Change",
            "detail": {"TranscriptionJobName": "job-1"}, "invoke_token": TOKEN,
        })

    def test_token_is_cached(self):
        index.handler(ECS_EVENT, None)
        index.handler(TRANSCRIBE_EVENT, None)
        self.get_secret.assert_called_once()

    def test_other_events_are_not_forwarded(self):
        cases = {
            "task payload": {"task": "reembed_space"},
            "wrong detail-type": {**ECS_EVENT, "detail-type": "ECS Container Instance State Change"},
            "mismatched pair": {**ECS_EVENT, "source": "aws.transcribe"},
            "missing id": {**ECS_EVENT, "detail": {"lastStatus": "STOPPED"}},
            "non-string id": {**TRANSCRIBE_EVENT, "detail": {"TranscriptionJobName": ["x"]}},
            "api gateway": {**ECS_EVENT, "requestContext": {"requestId": "r"}},
            "not a dict": ["aws.ecs"],
        }
        for name, event in cases.items():
            with self.subTest(case=name), self.assertLogs(level="WARNING"):
                self.assertEqual(index.handler(event, None), {"ok": False, "reason": "unsupported_event"})
        self.invoke.assert_not_called()
        self.get_secret.assert_not_called()

    def test_secret_error_fails_without_forwarding_or_logging_the_secret(self):
        self.get_secret.return_value = {"SecretString": json.dumps({})}
        with self.assertLogs(level="ERROR") as logs, self.assertRaises(RuntimeError):
            index.handler(ECS_EVENT, None)
        self.invoke.assert_not_called()
        self.assertIn("RuntimeError", "\n".join(logs.output))

    def test_token_is_never_logged(self):
        with self.assertLogs(level="DEBUG") as logs:
            index.logger.info("marker")
            index.handler(ECS_EVENT, None)
        self.assertNotIn(TOKEN, "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
