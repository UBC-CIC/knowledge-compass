"""
The originating admin travels with every self-invoked {task} payload and is
logged per task by main.py (finding f-0d57a9d0). No AWS, no database.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_worker_actor.py"
"""

import _setup  # noqa: F401  (must be first)
from _setup import TEST_INVOKE_TOKEN

import importlib
import json
import os
import sys
import types
import unittest
from unittest import mock

from _embedding_fakes import ScriptedConnection

# python-docx needs the Lambda's vendored linux lxml; these paths never touch
# DOCX, so a stub keeps the test runnable on any machine (same approach as
# test_guideline_admin.py).
try:  # pragma: no cover - depends on the local interpreter
    import docx  # noqa: F401
except Exception:  # noqa: BLE001
    _docx = types.ModuleType("docx")
    _docx.Document = object
    sys.modules["docx"] = _docx

_BATCH = "helpers.process_document_batch"


def _swap_modules(replacements: dict):
    """Put `replacements` into sys.modules; return a restore() callback."""
    saved = {name: sys.modules.get(name) for name in replacements}
    for name, module in replacements.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module

    def restore():
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    return restore


def _real_batch_module():
    """The real process_document_batch, even if another test module stubbed it."""
    current = sys.modules.get(_BATCH)
    if current is not None and hasattr(current, "_continue_later"):
        return current
    restore = _swap_modules({_BATCH: None})
    try:
        return importlib.import_module(_BATCH)
    finally:
        restore()


batch = _real_batch_module()
_restore = _swap_modules({_BATCH: batch})
try:
    from helpers import admin_audit  # noqa: E402,F401
    from helpers import embedding_admin as ea  # noqa: E402
    from helpers import guideline_admin as ga  # noqa: E402
    from helpers import reembed_space as rs  # noqa: E402
finally:
    _restore()


def _import_main():
    """main.py needs psycopg2 and lxml (Lambda-only); stub them while importing when missing."""
    os.environ.setdefault("SM_DB_CREDENTIALS", "test-secret")
    os.environ.setdefault("RDS_PROXY_ENDPOINT", "proxy.example")
    replacements = {_BATCH: batch}
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        replacements["psycopg2"] = types.ModuleType("psycopg2")
    try:
        import helpers.html_extract  # noqa: F401
    except ImportError:
        stub = types.ModuleType("helpers.html_extract")
        stub.extract_html = lambda *a, **k: None
        replacements["helpers.html_extract"] = stub
    restore = _swap_modules(replacements)
    # Read at import by generate_presigned_url; _setup unsets it for other tests.
    bucket_was_set = "KNOWLEDGE_BASE_BUCKET_NAME" in os.environ
    os.environ.setdefault("KNOWLEDGE_BASE_BUCKET_NAME", "test-bucket")
    try:
        return importlib.import_module("main")
    finally:
        restore()
        if not bucket_was_set:
            os.environ.pop("KNOWLEDGE_BASE_BUCKET_NAME", None)


SUB = "11111111-2222-3333-4444-555555555555"
SECTION_ID = "22222222-2222-4222-8222-222222222222"
ACTOR = {"sub": SUB, "email": "admin@example.org", "request_id": "req-1"}


def admin_event(**extra):
    return {
        "headers": {},
        "requestContext": {"requestId": "req-1", "authorizer": {"userId": SUB, "email": "admin@example.org"}},
        **extra,
    }


def sent_payload(invoke_mock):
    """The sent payload minus its invoke token, which must be present (helpers/worker_envelope.py)."""
    payload = json.loads(invoke_mock.call_args.kwargs["Payload"].decode("utf-8"))
    assert payload.pop("invoke_token") == TEST_INVOKE_TOKEN
    return payload


class DocumentBatchActorTests(unittest.TestCase):
    def setUp(self):
        self.lam = mock.Mock()
        for p in (
            mock.patch.object(batch, "lambda_client", self.lam),
            mock.patch.object(batch, "LAMBDA_FUNCTION_NAME", "kb-fn"),
            mock.patch.object(batch, "_mark_runs_running"),
            mock.patch.object(batch, "_fail_runs"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def test_trigger_document_batch_carries_the_authorizer_actor(self):
        with mock.patch.object(batch, "_latest_queued_document_runs", return_value=[{"ingestion_run_id": "r1"}]):
            result = batch.trigger_document_batch(admin_event(), mock.MagicMock(), "sync-1")
        self.assertTrue(result["started"])
        self.assertEqual(sent_payload(self.lam.invoke),
                         {"task": "process_document_batch", "sync_session_id": "sync-1", "actor": ACTOR})

    def test_trigger_document_batch_without_an_actor_keeps_the_old_payload(self):
        with mock.patch.object(batch, "_latest_queued_document_runs", return_value=[{"ingestion_run_id": "r1"}]):
            batch.trigger_document_batch({"source": "aws.events"}, mock.MagicMock(), "sync-1")
        self.assertEqual(sent_payload(self.lam.invoke),
                         {"task": "process_document_batch", "sync_session_id": "sync-1"})

    def test_trigger_uploaded_document_and_continuations_forward_the_actor(self):
        batch.trigger_uploaded_document(mock.MagicMock(), "r1", actor=ACTOR)
        self.assertEqual(sent_payload(self.lam.invoke), {"task": "process_document_batch", "actor": ACTOR})

        batch._continue_later(mock.MagicMock(), [{"ingestion_run_id": "r1"}], 0, actor=ACTOR)
        self.assertEqual(sent_payload(self.lam.invoke),
                         {"task": "process_document_batch", "continuation": 1, "actor": ACTOR})

        batch.trigger_uploaded_document(mock.MagicMock(), "r1")
        self.assertEqual(sent_payload(self.lam.invoke), {"task": "process_document_batch"})


class AdminRouteActorTests(unittest.TestCase):
    def test_embedding_start_job_carries_the_actor(self):
        mode = next(iter(ea._TASK_FOR_MODE))
        with mock.patch.object(ea, "invoke_self") as invoke:
            response = ea._start_job(admin_event(), mock.MagicMock(), "job-1", mode)
        self.assertEqual(response["statusCode"], 202)
        invoke.assert_called_once_with(
            {"task": ea._TASK_FOR_MODE[mode], "job_id": "job-1", "continuation": 0, "actor": ACTOR}
        )

    def test_guideline_rename_reembed_carries_the_actor(self):
        conn = ScriptedConnection({"UPDATE guideline_sections": [(SECTION_ID, "Auto label")]})
        with mock.patch.object(ga, "_invoke") as invoke:
            response = ga.rename_section(admin_event(), {"label": "New name"}, conn, SECTION_ID)
        self.assertEqual(response["statusCode"], 200)
        invoke.assert_called_once_with(
            {"task": "reembed_guideline_sections", "section_ids": [SECTION_ID], "actor": ACTOR}
        )


class ContinuationActorTests(unittest.TestCase):
    def test_reembed_hand_over_forwards_the_actor(self):
        with mock.patch.object(rs, "invoke_self") as invoke, mock.patch.object(rs, "finish_job"):
            result = rs._hand_over(mock.MagicMock(), {"id": "job-1"}, 0, actor=ACTOR)
        self.assertEqual(result["status"], "continued")
        invoke.assert_called_once_with({"task": "reembed_space", "job_id": "job-1", "continuation": 1, "actor": ACTOR})

    def test_reembed_hand_over_without_an_actor_keeps_the_old_payload(self):
        with mock.patch.object(rs, "invoke_self") as invoke, mock.patch.object(rs, "finish_job"):
            rs._hand_over(mock.MagicMock(), {"id": "job-1"}, 0)
        invoke.assert_called_once_with({"task": "reembed_space", "job_id": "job-1", "continuation": 1})


class MainLogsWorkerActorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = _import_main()

    def _worker_lines(self, logs):
        lines = []
        for record in logs.records:
            message = record.getMessage()
            if message.startswith('{"audit": "worker_task"'):
                lines.append(json.loads(message))
        return lines

    def _run(self, event):
        worker = mock.Mock(return_value={"status": "succeeded"})
        with mock.patch.object(self.main, "_connect_to_db", return_value=mock.MagicMock()), \
                mock.patch.dict(self.main._EMBEDDING_TASKS, {"validate_space": worker}), \
                self.assertLogs(level="INFO") as logs:
            self.main.handler(event)
        worker.assert_called_once()
        return self._worker_lines(logs)

    def test_task_branch_logs_the_payload_actor_once(self):
        lines = self._run({"task": "validate_space", "job_id": "job-1", "actor": ACTOR,
                           "invoke_token": TEST_INVOKE_TOKEN})
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["task"], "validate_space")
        self.assertEqual(lines[0]["actor_sub"], SUB)
        self.assertEqual(lines[0]["actor_email"], "admin@example.org")
        self.assertEqual(lines[0]["request_id"], "req-1")
        self.assertEqual(lines[0]["job_id"], "job-1")

    def test_task_without_an_actor_logs_null_and_still_runs(self):
        (line,) = self._run({"task": "validate_space", "job_id": "job-1", "invoke_token": TEST_INVOKE_TOKEN})
        self.assertIsNone(line["actor_sub"])


if __name__ == "__main__":
    unittest.main()
