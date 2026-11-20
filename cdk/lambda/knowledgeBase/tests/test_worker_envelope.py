"""
Self-invoke payloads carry the worker invoke token, and only that token is
accepted (helpers/worker_envelope.py, finding f-7f03f151). No AWS.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_worker_envelope.py"
"""

import _setup  # noqa: F401  (must be first)
from _setup import TEST_INVOKE_TOKEN

import json
import os
import unittest
from unittest import mock

from helpers import embedding_jobs
from helpers import worker_envelope as we


class WorkerPayloadTests(unittest.TestCase):
    def test_payload_gets_the_token_and_is_not_mutated(self):
        payload = {"task": "reembed_space", "job_id": "j1"}
        sent = json.loads(we.worker_payload(payload).decode("utf-8"))
        self.assertEqual(sent, {"task": "reembed_space", "job_id": "j1", "invoke_token": TEST_INVOKE_TOKEN})
        self.assertNotIn("invoke_token", payload)


class VerifyWorkerEventTests(unittest.TestCase):
    def test_accepts_only_the_right_token(self):
        self.assertTrue(we.verify_worker_event({"task": "t", "invoke_token": TEST_INVOKE_TOKEN}))
        for bad in (None, "", "wrong", TEST_INVOKE_TOKEN + "x", 5, [TEST_INVOKE_TOKEN]):
            self.assertFalse(we.verify_worker_event({"task": "t", "invoke_token": bad}), bad)
        self.assertFalse(we.verify_worker_event({"task": "t"}))
        self.assertFalse(we.verify_worker_event(None))

    def test_uses_a_constant_time_compare(self):
        with mock.patch.object(we.hmac, "compare_digest", wraps=we.hmac.compare_digest) as compare:
            we.verify_worker_event({"task": "t", "invoke_token": "wrong"})
        compare.assert_called()

    def test_secret_failure_fails_closed_without_logging_the_token(self):
        with mock.patch.object(we, "_invoke_tokens", side_effect=RuntimeError("boom")), \
                self.assertLogs(level="ERROR") as logs:
            self.assertFalse(we.verify_worker_event({"task": "t", "invoke_token": TEST_INVOKE_TOKEN}))
        self.assertNotIn(TEST_INVOKE_TOKEN, "\n".join(logs.output))


class InvokeTokenLoaderTests(unittest.TestCase):
    def setUp(self):
        self._saved = (we._cached_tokens, we._cached_at)
        we._cached_tokens, we._cached_at = None, 0.0

    def tearDown(self):
        we._cached_tokens, we._cached_at = self._saved

    def test_reads_the_secret_once_and_caches_it(self):
        client = mock.Mock()
        client.get_secret_value.return_value = {"SecretString": json.dumps({"token": "from-secrets-manager"})}
        with mock.patch.object(we, "_secrets_manager", return_value=client):
            self.assertEqual(we._invoke_token(), "from-secrets-manager")
            self.assertEqual(we._invoke_token(), "from-secrets-manager")
        client.get_secret_value.assert_called_once_with(SecretId=os.environ["WORKER_INVOKE_SECRET_ARN"])

    def _client(self, *secrets):
        client = mock.Mock()
        client.get_secret_value.side_effect = [{"SecretString": json.dumps(s)} for s in secrets]
        return client

    def test_previous_token_is_accepted_and_payloads_use_the_current_one(self):
        client = self._client({"token": "new-token", "previousToken": "old-token"})
        with mock.patch.object(we, "_secrets_manager", return_value=client):
            self.assertTrue(we.verify_worker_event({"task": "t", "invoke_token": "old-token"}))
            self.assertTrue(we.verify_worker_event({"task": "t", "invoke_token": "new-token"}))
            self.assertEqual(json.loads(we.worker_payload({"task": "t"}))["invoke_token"], "new-token")

    def test_a_token_from_a_just_rotated_secret_refetches_once(self):
        client = self._client({"token": "old-token"}, {"token": "new-token", "previousToken": "old-token"})
        with mock.patch.object(we, "_secrets_manager", return_value=client):
            self.assertTrue(we.verify_worker_event({"task": "t", "invoke_token": "old-token"}))
            with mock.patch.object(we.time, "monotonic", return_value=we._cached_at + 31):
                self.assertTrue(we.verify_worker_event({"task": "t", "invoke_token": "new-token"}))
        self.assertEqual(client.get_secret_value.call_count, 2)

    def test_forged_tokens_refetch_at_most_every_refresh_interval(self):
        client = self._client({"token": "real-token"})
        with mock.patch.object(we, "_secrets_manager", return_value=client):
            for _ in range(5):
                self.assertFalse(we.verify_worker_event({"task": "t", "invoke_token": "forged"}))
        client.get_secret_value.assert_called_once()

    def test_missing_configuration_or_token_raises(self):
        with mock.patch.dict(os.environ, {"WORKER_INVOKE_SECRET_ARN": ""}):
            with self.assertRaises(RuntimeError):
                we._invoke_token()
        client = mock.Mock()
        client.get_secret_value.return_value = {"SecretString": json.dumps({})}
        with mock.patch.object(we, "_secrets_manager", return_value=client):
            with self.assertRaises(RuntimeError):
                we._invoke_token()
            with self.assertRaises(RuntimeError):
                we.worker_payload({"task": "t"})


class InvokeSitesCarryTheTokenTests(unittest.TestCase):
    def _sent(self, invoke_mock):
        return json.loads(invoke_mock.call_args.kwargs["Payload"].decode("utf-8"))

    def test_embedding_jobs_invoke_self(self):
        lam = mock.Mock()
        with mock.patch.object(embedding_jobs, "_lambda_client", return_value=lam), \
                mock.patch.object(embedding_jobs, "LAMBDA_FUNCTION_NAME", "kb-fn"):
            embedding_jobs.invoke_self({"task": "validate_space", "job_id": "j1"})
        self.assertEqual(self._sent(lam.invoke)["invoke_token"], TEST_INVOKE_TOKEN)

    def test_csv_links_invoke_link_worker(self):
        try:
            from helpers import csv_links
        except ImportError as e:  # Lambda-only deps (lxml) missing locally
            self.skipTest(f"helpers.csv_links not importable here: {e}")
        lam = mock.Mock()
        with mock.patch.object(csv_links, "lambda_client", lam), \
                mock.patch.object(csv_links, "LAMBDA_FUNCTION_NAME", "kb-fn"):
            csv_links.invoke_link_worker(
                ingestion_run_id="r1", data_source_id="d1", sync_session_id="s1", continuation=0
            )
        sent = self._sent(lam.invoke)
        self.assertEqual(sent["task"], "process_csv_links")
        self.assertEqual(sent["invoke_token"], TEST_INVOKE_TOKEN)


if __name__ == "__main__":
    unittest.main()
