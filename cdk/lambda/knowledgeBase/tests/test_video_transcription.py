"""
Unit tests for helpers/video_transcription.handle_transcribe_complete and the cutover
lock. The DB and the ECS launch are faked. Run from knowledgeBase:

    python -m unittest discover -s tests -p "test_video_transcription.py"
"""

import _setup  # noqa: F401  (must be first)

import json
import unittest
from unittest import mock

from helpers import video_transcription as vt

JOB = "kc-video-abc"
DS_ID = "11111111-1111-4111-8111-111111111111"
RUN_ID = "22222222-2222-4222-8222-222222222222"


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._result = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.log.append(("execute", sql, params))
        self._result = self.conn.respond(sql)

    def fetchone(self):
        return self._result[0] if self._result else None


class FakeConnection:
    def __init__(self, locked: bool, run_status: str = "pending"):
        self.locked = locked
        self.run_status = run_status
        self.log = []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.log.append(("commit", None, None))

    def rollback(self):
        self.log.append(("rollback", None, None))

    def respond(self, sql):
        if "FROM data_sources ds" in sql:
            return [(DS_ID, "talk.mp4", {"transcribe_job_name": JOB}, RUN_ID, self.run_status)]
        if "FROM embedding_active_space" in sql:
            return [(self.locked, None, "job-1", False)]
        return []

    def statements(self, fragment):
        return [entry for entry in self.log if entry[0] == "execute" and fragment in entry[1]]


def _event():
    return {"detail": {"TranscriptionJobName": JOB, "TranscriptionJobStatus": "COMPLETED"}}


class TranscribeCompleteLockTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(vt, "launch_transcriber_for_run",
                                    return_value={"ingestion_run_id": RUN_ID, "ecs_task_arn": "arn"})
        self.launch = patcher.start()
        self.addCleanup(patcher.stop)
        self.get_job = mock.patch.object(
            vt.transcribe_client, "get_transcription_job",
            return_value={"TranscriptionJob": {"TranscriptionJobStatus": "COMPLETED"}},
        ).start()
        self.addCleanup(mock.patch.stopall)

    def test_cutover_defers_the_run_instead_of_launching(self):
        for run_status in ("pending", "queued"):
            conn = FakeConnection(locked=True, run_status=run_status)
            result = vt.handle_transcribe_complete(_event(), conn)
            self.assertEqual(result["status"], "deferred", run_status)
            self.launch.assert_not_called()
            update = conn.statements("UPDATE ingestion_runs")
            self.assertEqual(len(update), 1)
            self.assertIn("'pending'::ingestion_status", update[0][1])
            self.assertTrue(json.loads(update[0][2][0])["deferred_by_cutover"])
            # The transcript location is kept, so the next sync can launch the run.
            meta = json.loads(conn.statements("UPDATE data_sources")[0][2][0])
            self.assertEqual(meta["transcribe_status"], "COMPLETED")
            self.assertEqual(conn.log[-1][0], "commit")

    def test_unlocked_launches_while_holding_the_pointer_row(self):
        conn = FakeConnection(locked=False)
        result = vt.handle_transcribe_complete(_event(), conn)
        self.assertEqual(result["status"], "completed")
        self.launch.assert_called_once()
        check = conn.statements("FROM embedding_active_space")
        self.assertEqual(len(check), 1)
        self.assertIn("FOR SHARE", check[0][1])
        # No commit between the lock check and the launch (which commits 'running').
        after_check = conn.log[conn.log.index(check[0]):]
        self.assertNotIn("commit", [kind for kind, _, _ in after_check])
        self.assertIn("'queued'::ingestion_status", conn.statements("UPDATE ingestion_runs")[0][1])


class TranscribeEventIsNotTrustedTest(unittest.TestCase):
    """The event is unauthenticated: status comes from Transcribe, not the payload."""

    def setUp(self):
        self.launch = mock.patch.object(vt, "launch_transcriber_for_run").start()
        self.get_job = mock.patch.object(vt.transcribe_client, "get_transcription_job").start()
        self.addCleanup(mock.patch.stopall)

    def test_forged_completed_event_for_a_running_job_changes_nothing(self):
        self.get_job.return_value = {"TranscriptionJob": {"TranscriptionJobStatus": "IN_PROGRESS"}}
        conn = FakeConnection(locked=False)
        self.assertEqual(vt.handle_transcribe_complete(_event(), conn), {"ignored": True})
        self.get_job.assert_called_once_with(TranscriptionJobName=JOB)
        self.assertEqual(conn.statements("UPDATE"), [])
        self.launch.assert_not_called()

    def test_unknown_job_changes_nothing(self):
        self.get_job.side_effect = RuntimeError("BadRequestException: job not found")
        conn = FakeConnection(locked=False)
        with self.assertLogs(level="ERROR"):
            result = vt.handle_transcribe_complete(_event(), conn)
        self.assertEqual(result["error"], "transcription job not found")
        self.assertEqual(conn.log, [])

    def test_failure_reason_comes_from_transcribe_not_the_event(self):
        self.get_job.return_value = {"TranscriptionJob": {"TranscriptionJobStatus": "FAILED", "FailureReason": "real"}}
        conn = FakeConnection(locked=False)
        event = {"detail": {"TranscriptionJobName": JOB, "TranscriptionJobStatus": "FAILED", "FailureReason": "forged"}}
        self.assertEqual(vt.handle_transcribe_complete(event, conn)["status"], "failed")
        self.assertEqual(conn.statements("UPDATE ingestion_runs")[0][2][0], "real")


if __name__ == "__main__":
    unittest.main()
