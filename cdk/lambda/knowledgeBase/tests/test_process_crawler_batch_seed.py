"""
The stored website name is re-validated before ecs:RunTask: a seed that is not
a public http(s) URL (possibly written before staging validated it) must never
reach the crawler task. DNS and ECS are faked; no network is used.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_process_crawler_batch_seed.py" -v
"""

import socket
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import process_crawler_batch as batch  # noqa: E402

DNS = {
    "example.org": ["93.184.216.34"],
    "internal.example.org": ["172.16.0.4"],
}


def fake_getaddrinfo(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    if host not in DNS:
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]]


class CrawlerSeedRevalidationTests(unittest.TestCase):
    def setUp(self):
        self.ecs = mock.Mock()
        self.ecs.run_task.return_value = {"tasks": [{"taskArn": "arn:task"}], "failures": []}
        self.runs = []
        for patcher in (
            mock.patch.object(batch, "ECS_CLUSTER_ARN", "arn:cluster"),
            mock.patch.object(batch, "CRAWLER_TASK_DEF_ARN", "arn:taskdef"),
            mock.patch.object(batch, "INGESTION_SUBNET_IDS", ["subnet-1"]),
            mock.patch.object(batch, "INGESTION_SECURITY_GROUP_IDS", ["sg-1"]),
            mock.patch.object(batch, "ecs_client", self.ecs),
            mock.patch.object(batch, "_latest_queued_runs", side_effect=lambda *a, **k: self.runs),
            mock.patch("socket.getaddrinfo", fake_getaddrinfo),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.connection = mock.MagicMock()
        self.cursor = self.connection.cursor.return_value.__enter__.return_value

    def run_batch(self, name):
        self.runs = [{
            "ingestion_run_id": "run-1",
            "data_source_id": "ds-1",
            "name": name,
            "type": "website",
            "include_patterns": [],
            "exclude_patterns": [],
            "data_source_metadata": {},
        }]
        return batch.process_crawler_batch({}, self.connection, "sync-1")

    def executed_sql(self):
        return [c.args for c in self.cursor.execute.call_args_list]

    def test_unsafe_stored_seeds_are_not_launched_and_fail_the_run(self):
        for name in (
            "file:///etc/passwd",
            "http://169.254.170.2/v2/credentials",
            "http://127.0.0.1:8080/",
            "http://10.0.0.9/",
            "http://user:pw@example.org/",
            "https://internal.example.org/",
            None,
        ):
            with self.subTest(name=name):
                self.ecs.run_task.reset_mock()
                self.cursor.execute.reset_mock()
                result = self.run_batch(name)
                self.ecs.run_task.assert_not_called()
                self.assertEqual(result["launched_count"], 0)
                self.assertEqual(result["failures"][0]["error"], batch.REJECTED_SEED_MESSAGE)
                failed = [
                    (sql, params) for sql, params in self.executed_sql()
                    if "'failed'::ingestion_status" in sql
                ]
                self.assertEqual(len(failed), 1)
                self.assertEqual(failed[0][1][0], batch.REJECTED_SEED_MESSAGE)
                self.assertEqual(failed[0][1][-1], "run-1")
                self.assertNotIn("172.16.0.4", repr(result))

    def test_unresolvable_seed_stays_queued(self):
        result = self.run_batch("https://unknown.invalid/")
        self.ecs.run_task.assert_not_called()
        self.assertEqual(result["launched_count"], 0)
        self.assertEqual(len(result["failures"]), 1)
        self.assertFalse(any("'failed'::ingestion_status" in sql for sql, _ in self.executed_sql()))

    def test_public_seed_is_launched_unchanged(self):
        result = self.run_batch("https://example.org")
        self.ecs.run_task.assert_called_once()
        env = self.ecs.run_task.call_args.kwargs["overrides"]["containerOverrides"][0]["environment"]
        self.assertIn({"name": "SEED_URL", "value": "https://example.org"}, env)
        self.assertEqual(result["launched_count"], 1)
        self.assertTrue(any("'running'::ingestion_status" in sql for sql, _ in self.executed_sql()))


if __name__ == "__main__":
    unittest.main()
