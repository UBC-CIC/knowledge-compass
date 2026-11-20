"""
transcribeRelay (findings f-9d5748bc, f-0ddd7657): genuine EventBridge events
reach lambdaKnowledgeBase with the worker invoke token and only the id field
the handler reads; anything else, including well-shaped events for another
account, region, cluster or job-name format, is dropped before the token is
read. No AWS.

Run from transcribeRelay:  python -m unittest discover -s tests -p "test_*.py"
"""

import json
import os
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["AWS_ACCESS_KEY_ID"] = "testing"
os.environ["AWS_SECRET_ACCESS_KEY"] = "testing"
os.environ.pop("AWS_PROFILE", None)
os.environ["TARGET_FUNCTION_NAME"] = "KC-Api-lambdaKnowledgeBase"
os.environ["WORKER_INVOKE_SECRET_NAME"] = "KC-Api-KC-WorkerInvokeSecret"
os.environ["ECS_CLUSTER_NAME"] = "KC-Ingestion-Cluster1A2B3C"

import index  # noqa: E402

TOKEN = "relay-test-token"
ACCOUNT = "123456789012"
REGION = "ca-central-1"
CONTEXT = SimpleNamespace(
    invoked_function_arn=f"arn:aws:lambda:{REGION}:{ACCOUNT}:function:KC-Ingestion-transcribeRelay",
)
TASK_ID = "0123456789abcdef0123456789abcdef"
TASK_ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/KC-Ingestion-Cluster1A2B3C/{TASK_ID}"
JOB_NAME = "kc-video-" + "a1b2c3d4" * 4

ECS_EVENT = {
    "version": "0", "id": "e-1", "source": "aws.ecs", "detail-type": "ECS Task State Change",
    "account": ACCOUNT, "region": REGION,
    "detail": {"taskArn": TASK_ARN, "lastStatus": "STOPPED",
               "clusterArn": f"arn:aws:ecs:{REGION}:{ACCOUNT}:cluster/KC-Ingestion-Cluster1A2B3C",
               "stoppedReason": "x"},
}
TRANSCRIBE_EVENT = {
    "version": "0", "id": "e-2", "source": "aws.transcribe", "detail-type": "Transcribe Job State Change",
    "account": ACCOUNT, "region": REGION,
    "detail": {"TranscriptionJobName": JOB_NAME, "TranscriptionJobStatus": "COMPLETED"},
}


def _with_detail(event, **detail):
    return {**event, "detail": {**event["detail"], **detail}}


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

    def assert_dropped(self, cases, context=CONTEXT):
        for name, event in cases.items():
            with self.subTest(case=name), self.assertLogs(level="WARNING"):
                self.assertEqual(index.handler(event, context), {"ok": False, "reason": "unsupported_event"})
        self.invoke.assert_not_called()
        self.get_secret.assert_not_called()

    def test_ecs_task_stopped_is_forwarded_with_the_token_and_only_the_task_arn(self):
        self.assertEqual(index.handler(ECS_EVENT, CONTEXT), {"ok": True})
        self.assertEqual(self._forwarded(), {
            "source": "aws.ecs", "detail-type": "ECS Task State Change",
            "detail": {"taskArn": TASK_ARN}, "invoke_token": TOKEN,
        })
        self.get_secret.assert_called_once_with(SecretId="KC-Api-KC-WorkerInvokeSecret")

    def test_transcribe_complete_is_forwarded_with_the_token_and_only_the_job_name(self):
        self.assertEqual(index.handler(TRANSCRIBE_EVENT, CONTEXT), {"ok": True})
        self.assertEqual(self._forwarded(), {
            "source": "aws.transcribe", "detail-type": "Transcribe Job State Change",
            "detail": {"TranscriptionJobName": JOB_NAME}, "invoke_token": TOKEN,
        })

    def test_aliased_function_arn_is_accepted(self):
        context = SimpleNamespace(invoked_function_arn=CONTEXT.invoked_function_arn + ":live")
        self.assertEqual(index.handler(ECS_EVENT, context), {"ok": True})

    def test_token_is_cached(self):
        index.handler(ECS_EVENT, CONTEXT)
        index.handler(TRANSCRIBE_EVENT, CONTEXT)
        self.get_secret.assert_called_once()

    def test_other_events_are_not_forwarded(self):
        self.assert_dropped({
            "task payload": {"task": "reembed_space"},
            "wrong detail-type": {**ECS_EVENT, "detail-type": "ECS Container Instance State Change"},
            "mismatched pair": {**ECS_EVENT, "source": "aws.transcribe"},
            "missing id": {**ECS_EVENT, "detail": {"lastStatus": "STOPPED"}},
            "non-string id": {**TRANSCRIBE_EVENT, "detail": {"TranscriptionJobName": ["x"]}},
            "api gateway": {**ECS_EVENT, "requestContext": {"requestId": "r"}},
            "not a dict": ["aws.ecs"],
        })

    def test_events_for_another_account_or_region_are_not_forwarded(self):
        cases = {}
        for name, event in (("ecs", ECS_EVENT), ("transcribe", TRANSCRIBE_EVENT)):
            cases[f"{name} other account"] = {**event, "account": "999999999999"}
            cases[f"{name} other region"] = {**event, "region": "us-east-1"}
            cases[f"{name} no account"] = {k: v for k, v in event.items() if k != "account"}
            cases[f"{name} no region"] = {k: v for k, v in event.items() if k != "region"}
            cases[f"{name} numeric account"] = {**event, "account": int(ACCOUNT)}
        self.assert_dropped(cases)

    def test_events_are_not_forwarded_without_a_function_arn(self):
        for context in (None, SimpleNamespace(), SimpleNamespace(invoked_function_arn="not-an-arn")):
            with self.subTest(context=context):
                self.assert_dropped({"ecs": ECS_EVENT, "transcribe": TRANSCRIBE_EVENT}, context=context)

    def test_task_arns_outside_this_cluster_account_or_region_are_not_forwarded(self):
        base = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task"
        self.assert_dropped({
            name: _with_detail(ECS_EVENT, taskArn=arn) for name, arn in {
                "other cluster": f"{base}/OtherCluster/{TASK_ID}",
                "cluster name prefix": f"{base}/KC-Ingestion-Cluster1A2B3C-x/{TASK_ID}",
                "other account": f"arn:aws:ecs:{REGION}:999999999999:task/KC-Ingestion-Cluster1A2B3C/{TASK_ID}",
                "other region": f"arn:aws:ecs:us-east-1:{ACCOUNT}:task/KC-Ingestion-Cluster1A2B3C/{TASK_ID}",
                "other partition": f"arn:aws-cn:ecs:{REGION}:{ACCOUNT}:task/KC-Ingestion-Cluster1A2B3C/{TASK_ID}",
                "old format": f"{base}/{TASK_ID}",
                "short task id": f"{base}/KC-Ingestion-Cluster1A2B3C/abc",
                "trailing text": f"{TASK_ARN}/x",
                "trailing newline": f"{TASK_ARN}\n",
                "not an arn": "00000000-0000-0000-0000-000000000000",
                "sql": "' OR 1=1 --",
            }.items()
        })

    def test_job_names_outside_the_app_format_are_not_forwarded(self):
        self.assert_dropped({
            name: _with_detail(TRANSCRIBE_EVENT, TranscriptionJobName=job) for name, job in {
                "other prefix": "other-" + "a1b2c3d4" * 4,
                "short": "kc-video-abc",
                "upper hex": "kc-video-" + "A1B2C3D4" * 4,
                "trailing text": JOB_NAME + "-x",
                "trailing newline": JOB_NAME + "\n",
                "uuid with dashes": "kc-video-a1b2c3d4-a1b2-a1b2-a1b2-a1b2c3d4a1b2",
            }.items()
        })

    def test_secret_error_fails_without_forwarding_or_logging_the_secret(self):
        self.get_secret.return_value = {"SecretString": json.dumps({})}
        with self.assertLogs(level="ERROR") as logs, self.assertRaises(RuntimeError):
            index.handler(ECS_EVENT, CONTEXT)
        self.invoke.assert_not_called()
        self.assertIn("RuntimeError", "\n".join(logs.output))

    def test_token_is_never_logged(self):
        with self.assertLogs(level="DEBUG") as logs:
            index.logger.info("marker")
            index.handler(ECS_EVENT, CONTEXT)
            index.handler({**ECS_EVENT, "account": "999999999999"}, CONTEXT)
        self.assertNotIn(TOKEN, "\n".join(logs.output))


if __name__ == "__main__":
    unittest.main()
