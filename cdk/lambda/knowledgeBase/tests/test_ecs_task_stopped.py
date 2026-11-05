"""
handle_ecs_task_stopped takes only the task ARN from the (unauthenticated)
event and reads the task's state back from ECS, so a forged "STOPPED" event
cannot fail a running ingestion run or plant an error message. ECS and the DB
are faked.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_ecs_task_stopped.py" -v
"""

import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import process_crawler_batch as batch  # noqa: E402

TASK = "arn:aws:ecs:ca-central-1:123456789012:task/cluster/abc"


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))

    def fetchone(self):
        return ("run-1",)


class FakeConnection:
    def __init__(self):
        self.executed = []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        pass


def forged_event():
    return {
        "source": "aws.ecs",
        "detail": {"taskArn": TASK, "lastStatus": "STOPPED", "stoppedReason": "forged reason"},
    }


class EcsTaskStoppedTests(unittest.TestCase):
    def setUp(self):
        self.ecs = mock.Mock()
        mock.patch.object(batch, "ecs_client", self.ecs).start()
        mock.patch.object(batch, "ECS_CLUSTER_ARN", "arn:cluster").start()
        self.addCleanup(mock.patch.stopall)

    def test_forged_stopped_event_for_a_running_task_changes_nothing(self):
        self.ecs.describe_tasks.return_value = {"tasks": [{"taskArn": TASK, "lastStatus": "RUNNING"}]}
        conn = FakeConnection()
        result = batch.handle_ecs_task_stopped(forged_event(), conn)
        self.assertEqual(result, {"ignored": True, "reason": "not_stopped"})
        self.ecs.describe_tasks.assert_called_once_with(cluster="arn:cluster", tasks=[TASK])
        self.assertEqual(conn.executed, [])

    def test_task_outside_the_cluster_changes_nothing(self):
        self.ecs.describe_tasks.return_value = {"tasks": [], "failures": [{"arn": TASK, "reason": "MISSING"}]}
        conn = FakeConnection()
        self.assertEqual(batch.handle_ecs_task_stopped(forged_event(), conn)["reason"], "unknown_task")
        self.assertEqual(conn.executed, [])

    def test_stopped_task_error_comes_from_ecs_not_the_event(self):
        self.ecs.describe_tasks.return_value = {"tasks": [{
            "taskArn": TASK, "lastStatus": "STOPPED", "stoppedReason": "Essential container exited",
            "containers": [{"name": "crawler", "exitCode": 137}],
        }]}
        conn = FakeConnection()
        result = batch.handle_ecs_task_stopped(forged_event(), conn)
        self.assertEqual(result["failed_run_id"], "run-1")
        self.assertEqual(result["error"], "Essential container exited; crawler: exit=137")
        self.assertNotIn("forged", conn.executed[0][1][0])


if __name__ == "__main__":
    unittest.main()
