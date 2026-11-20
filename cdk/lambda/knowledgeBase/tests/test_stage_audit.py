"""
Staging a data source writes an admin_audit row (finding f-531c9569): the
acting admin from the authorizer context (never the body), the data source and
ingestion run ids, in the same transaction as the staged rows. Document
staging commits that row before its ingestion is started. Targets hold ids
only, never file names, URLs or document content.

DNS, S3, Transcribe and the row writers are faked; no network is used.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_stage_audit.py" -v
"""

import json
import socket
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

# Staging only needs trigger_uploaded_document from process_document_batch;
# stub it so these tests don't need docx/lxml installed locally (same as
# test_stage_url_safety.py).
if "helpers.process_document_batch" not in sys.modules:
    _stub = types.ModuleType("helpers.process_document_batch")
    _stub.trigger_uploaded_document = mock.Mock()
    sys.modules["helpers.process_document_batch"] = _stub

from helpers import stage_data_sources as stage  # noqa: E402
from helpers import stage_data_sources_batch as batch  # noqa: E402

BUCKET = "bucket"
SUB = "admin-sub"
EMAIL = "admin@example.org"


def fake_getaddrinfo(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    if host != "example.org":
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def admin_event():
    return {
        "httpMethod": "POST",
        "path": "/admin/data_sources",
        "requestContext": {"authorizer": {"userId": SUB, "email": EMAIL}, "requestId": "req-1"},
        "headers": {},
    }


class RecordingCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        if self.conn.fail_on and self.conn.fail_on in sql:
            raise RuntimeError("database unavailable")
        self.conn.log.append(("SQL", " ".join(sql.split()), params))

    def fetchone(self):
        return None


class RecordingConnection:
    """Statements, commits, rollbacks and side effects, in the order they happen."""

    def __init__(self, fail_on=None):
        self.log = []
        self.fail_on = fail_on

    def cursor(self):
        return RecordingCursor(self)

    def commit(self):
        self.log.append(("COMMIT",))

    def rollback(self):
        self.log.append(("ROLLBACK",))

    def audits(self):
        return [entry for entry in self.log if entry[0] == "SQL" and "INSERT INTO admin_audit" in entry[1]]

    def index(self, marker):
        return next(i for i, entry in enumerate(self.log) if entry[0] == marker)

    def audit_index(self):
        return next(i for i, entry in enumerate(self.log) if entry in self.audits())


class _Base(unittest.TestCase):
    def setUp(self):
        self.conn = RecordingConnection()
        for patcher in (
            mock.patch.object(stage, "get_cors_headers", return_value={}),
            mock.patch.object(batch, "get_cors_headers", return_value={}),
            mock.patch("socket.getaddrinfo", fake_getaddrinfo),
            mock.patch.object(stage, "reject_if_locked", return_value=None),
            mock.patch.object(batch, "reject_if_locked", return_value=None),
            mock.patch.object(stage, "get_or_create_admin_user_id", return_value="u1"),
            mock.patch.object(batch, "get_or_create_admin_user_id", return_value="u1"),
            mock.patch.object(stage, "_existing_website_row_id", return_value=None),
            mock.patch.object(stage, "_source_type_at_url", return_value=None),
            mock.patch.object(stage, "is_issued_upload", return_value=True),
            mock.patch.object(stage, "has_unclaimed_uploads", return_value=True),
            mock.patch.object(stage, "claim_issued_uploads", return_value=True),
            mock.patch.object(stage, "head_etag", return_value="etag-1"),
            mock.patch.object(stage, "find_existing_upload", return_value=None),
            mock.patch.object(stage, "_insert_data_source_row", return_value="ds-1"),
            mock.patch.object(stage, "_insert_ingestion_run_row", return_value="run-1"),
            mock.patch.object(stage, "delete_s3_objects", return_value=[]),
            mock.patch.object(batch, "delete_s3_objects", return_value=[]),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def stage(self, body):
        with self.assertLogs(level="INFO") as logs:
            response = stage.stage_data_sources(admin_event(), body, self.conn)
        return response, logs.output

    def assert_audit(self, action, target):
        audits = self.conn.audits()
        self.assertEqual(len(audits), 1, self.conn.log)
        sub, email, recorded_action, recorded_target, request_id = audits[0][2]
        self.assertEqual((sub, email, recorded_action, request_id), (SUB, EMAIL, action, "req-1"))
        self.assertEqual(json.loads(recorded_target), target)
        # The row commits with the staged rows: no commit between them.
        commit_after = next(i for i in range(self.conn.audit_index(), len(self.conn.log))
                            if self.conn.log[i] == ("COMMIT",))
        self.assertNotIn(("ROLLBACK",), self.conn.log[self.conn.audit_index():commit_after])
        return recorded_target


class StageAuditTests(_Base):
    def test_website_staging_is_audited_with_the_authorizer_identity(self):
        response, logs = self.stage({
            "type": "website",
            "name": "https://example.org/science/",
            "created_by": "intruder@example.org",
            "actor": {"sub": "intruder", "email": "intruder@example.org"},
        })
        self.assertEqual(response["statusCode"], 200, response["body"])
        target = self.assert_audit("data_source.stage", {
            "type": "website", "outcome": "staged",
            "data_source_ids": ["ds-1"], "ingestion_run_ids": ["run-1"],
        })
        self.assertNotIn("intruder", json.dumps(self.conn.log))
        self.assertNotIn("example.org/science", target)
        self.assertTrue(any('"action": "data_source.stage"' in line for line in logs))

    def test_document_staging_commits_its_audit_before_ingestion_starts(self):
        def trigger(connection, run_id, actor=None):
            self.conn.log.append(("TRIGGER",))
            return {"started": True}

        with mock.patch.object(stage, "trigger_uploaded_document", side_effect=trigger):
            response, _ = self.stage({
                "type": "document",
                "document_file_name": "family-plan.pdf",
                "document_s3_bucket": BUCKET,
                "document_s3_key": "uploads/document/1_x_family-plan.pdf",
                "document_url": "https://example.org/family-plan.pdf",
            })
        self.assertEqual(response["statusCode"], 200, response["body"])
        target = self.assert_audit("data_source.stage", {
            "type": "document", "outcome": "staged",
            "data_source_ids": ["ds-1"], "ingestion_run_ids": ["run-1"],
        })
        self.assertNotIn("family-plan", target)
        audit_commit = self.conn.log.index(("COMMIT",), self.conn.audit_index())
        self.assertLess(audit_commit, self.conn.index("TRIGGER"))

    def test_unchanged_document_reupload_is_audited(self):
        existing = {"id": "ds-old", "type": "document", "metadata": {"s3_key": "uploads/document/0_old.pdf"},
                    "latest_run_status": "succeeded"}
        with mock.patch.object(stage, "find_existing_upload", return_value=existing), \
                mock.patch.object(stage, "_content_unchanged", return_value=True), \
                mock.patch.object(stage, "_apply_details_without_reprocessing", return_value=[]), \
                mock.patch.object(stage, "set_citation_url"):
            response, _ = self.stage({
                "type": "document",
                "document_file_name": "plan.pdf",
                "document_s3_bucket": BUCKET,
                "document_s3_key": "uploads/document/1_x_plan.pdf",
                "document_url": "https://example.org/plan.pdf",
            })
        self.assertEqual(response["statusCode"], 200, response["body"])
        self.assert_audit("data_source.stage", {
            "type": "document", "outcome": "unchanged",
            "data_source_ids": ["ds-old"], "ingestion_run_ids": [],
        })

    def test_video_staging_is_audited(self):
        transcribe = {"transcribe_job_name": "kc-job", "transcript_s3_uri": "s3://bucket/t.json",
                      "media_format": "mp4"}
        with mock.patch.object(stage, "start_transcription_job", return_value=transcribe):
            response, _ = self.stage({
                "type": "video",
                "video_file_name": "talk.mp4",
                "video_s3_bucket": BUCKET,
                "video_s3_key": "uploads/video/1_x_talk.mp4",
                "video_url": "https://example.org/talk",
            })
        self.assertEqual(response["statusCode"], 200, response["body"])
        self.assert_audit("data_source.stage", {
            "type": "video", "outcome": "staged",
            "data_source_ids": ["ds-1"], "ingestion_run_ids": ["run-1"],
        })

    def test_file_pair_staging_is_audited(self):
        result = {"action": "replaced", "data_source_ids": ["ds-1", "ds-2"], "ingestion_run_ids": ["r1", "r2"],
                  "s3_cleanup": [], "suggested_url_column": None}
        with mock.patch.object(stage, "stage_file_pair", return_value=result):
            response, _ = self.stage({
                "type": "csv",
                "csv_file_name": "schools.csv", "csv_s3_bucket": BUCKET, "csv_s3_key": "uploads/csv/1_schools.csv",
                "metadata_file_name": "schools.csv.metadata.json", "metadata_s3_bucket": BUCKET,
                "metadata_s3_key": "uploads/json/1_schools.csv.metadata.json",
            })
        self.assertEqual(response["statusCode"], 200, response["body"])
        self.assert_audit("data_source.stage", {
            "type": "csv", "outcome": "replaced",
            "data_source_ids": ["ds-1", "ds-2"], "ingestion_run_ids": ["r1", "r2"],
        })

    def test_a_failed_audit_insert_rolls_the_staging_back(self):
        self.conn = RecordingConnection(fail_on="INSERT INTO admin_audit")
        response = stage.stage_data_sources(admin_event(), {"type": "website", "name": "https://example.org/"},
                                            self.conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(self.conn.log[-1], ("ROLLBACK",))
        # Only the admin-user lookup commit happened before the staging began.
        self.assertEqual(self.conn.log.count(("COMMIT",)), 1)


class BatchStageAuditTests(_Base):
    def item(self, name):
        return {
            "type": "csv",
            "primary_file_name": name, "primary_s3_bucket": BUCKET, "primary_s3_key": f"uploads/csv/1_{name}",
            "metadata_file_name": f"{name}.metadata.json", "metadata_s3_bucket": BUCKET,
            "metadata_s3_key": f"uploads/json/1_{name}.metadata.json",
        }

    def test_a_batch_is_one_audit_row_listing_each_staged_item(self):
        results = [
            {"action": "staged", "data_source_ids": ["a1", "a2"], "ingestion_run_ids": ["ra1", "ra2"],
             "s3_cleanup": [], "suggested_url_column": None},
            stage.StageRejected(409, {"error": "busy"}),
            {"action": "unchanged", "data_source_ids": ["c1"], "ingestion_run_ids": [],
             "s3_cleanup": [], "suggested_url_column": None},
        ]
        with mock.patch.object(batch, "stage_file_pair", side_effect=results), \
                self.assertLogs(level="INFO") as logs:
            response = batch.stage_data_sources_batch(
                admin_event(), {"items": [self.item("a.csv"), self.item("b.csv"), self.item("c.csv")]}, self.conn
            )
        self.assertEqual(response["statusCode"], 200, response["body"])
        target = self.assert_audit("data_source.stage_batch", {"items": [
            {"type": "csv", "outcome": "staged", "data_source_ids": ["a1", "a2"], "ingestion_run_ids": ["ra1", "ra2"]},
            {"type": "csv", "outcome": "unchanged", "data_source_ids": ["c1"], "ingestion_run_ids": []},
        ]})
        self.assertNotIn(".csv", target)
        self.assertTrue(any('"action": "data_source.stage_batch"' in line for line in logs.output))

    def test_a_batch_that_stages_nothing_writes_no_audit_row(self):
        with mock.patch.object(batch, "stage_file_pair", side_effect=stage.StageRejected(400, {"error": "bad"})):
            response = batch.stage_data_sources_batch(admin_event(), {"items": [self.item("a.csv")]}, self.conn)
        self.assertEqual(response["statusCode"], 200, response["body"])
        self.assertEqual(self.conn.audits(), [])

    def test_a_failed_audit_insert_rolls_the_batch_back(self):
        self.conn = RecordingConnection(fail_on="INSERT INTO admin_audit")
        result = {"action": "staged", "data_source_ids": ["a1", "a2"], "ingestion_run_ids": ["ra1", "ra2"],
                  "s3_cleanup": [], "suggested_url_column": None}
        with mock.patch.object(batch, "stage_file_pair", return_value=result):
            response = batch.stage_data_sources_batch(admin_event(), {"items": [self.item("a.csv")]}, self.conn)
        self.assertEqual(response["statusCode"], 500)
        self.assertEqual(self.conn.log[-1], ("ROLLBACK",))
        self.assertEqual(self.conn.log.count(("COMMIT",)), 1)


if __name__ == "__main__":
    unittest.main()
