"""
Staging takes the uploaded object's bucket/key from the request body
(finding f-cedd2bee). It is accepted only when:
- it is a location the presigned-URL endpoint issues (the ingest bucket,
  under uploads/), checked before the object is read, transcribed, recorded,
  or later deleted;
- it was issued to the same admin, is inside its staging window and was not
  staged before (helpers/upload_issuance.py, migration 045), claimed once in
  the staging transaction before its first write.
The presign endpoints record every key they issue against the acting admin's
sub, and the S3 delete helper refuses anything outside the ingest bucket's
upload and transcript prefixes. S3, DNS and the database are faked.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_upload_location.py" -v
"""

import importlib
import json
import os
import socket
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

# Staging only needs trigger_uploaded_document from process_document_batch;
# stub it so these tests don't need docx/lxml installed locally.
if "helpers.process_document_batch" not in sys.modules:
    _stub = types.ModuleType("helpers.process_document_batch")
    _stub.trigger_uploaded_document = mock.Mock()
    sys.modules["helpers.process_document_batch"] = _stub

from helpers import stage_data_sources as stage  # noqa: E402
from helpers import upload_identity, upload_issuance  # noqa: E402

BUCKET = "ingest-bucket"
SUB = "sub-1"


def _import_with_bucket(name):
    """The presign modules read KNOWLEDGE_BASE_BUCKET_NAME at import; _setup unsets it."""
    was_set = "KNOWLEDGE_BASE_BUCKET_NAME" in os.environ
    os.environ.setdefault("KNOWLEDGE_BASE_BUCKET_NAME", BUCKET)
    try:
        return importlib.import_module(name)
    finally:
        if not was_set:
            os.environ.pop("KNOWLEDGE_BASE_BUCKET_NAME", None)


presign = _import_with_bucket("helpers.generate_presigned_url")
presign_batch = _import_with_bucket("helpers.generate_presigned_urls_batch")


def _public_dns(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((" ".join(sql.split()), params))

    def fetchall(self):
        return self.conn.rows


class FakeConnection:
    """Records SQL; every SELECT returns `rows`."""

    def __init__(self, rows=()):
        self.rows = list(rows)
        self.executed = []
        self.commit = mock.Mock()
        self.rollback = mock.Mock()

    def cursor(self):
        return FakeCursor(self)


class _EnvBase(unittest.TestCase):
    def setUp(self):
        env = mock.patch.dict("os.environ", {"KNOWLEDGE_BASE_BUCKET_NAME": BUCKET})
        env.start()
        self.addCleanup(env.stop)


class IsIssuedUploadTests(_EnvBase):
    def test_upload_in_ingest_bucket_is_accepted(self):
        self.assertTrue(upload_identity.is_issued_upload(BUCKET, "uploads/document/1_a.pdf"))

    def test_other_bucket_is_rejected(self):
        self.assertFalse(upload_identity.is_issued_upload("other-bucket", "uploads/document/1_a.pdf"))

    def test_key_outside_uploads_is_rejected(self):
        for key in ("transcripts/kc-video-1.json", "guidelines/a.pdf", "uploads", "uploads/", "x/uploads/a.pdf"):
            with self.subTest(key=key):
                self.assertFalse(upload_identity.is_issued_upload(BUCKET, key))

    def test_non_string_values_are_rejected(self):
        self.assertFalse(upload_identity.is_issued_upload([BUCKET], "uploads/a.pdf"))
        self.assertFalse(upload_identity.is_issued_upload(BUCKET, {"k": "uploads/a.pdf"}))

    def test_fails_closed_without_configured_bucket(self):
        with mock.patch.dict("os.environ", {"KNOWLEDGE_BASE_BUCKET_NAME": ""}):
            self.assertFalse(upload_identity.is_issued_upload("", "uploads/a.pdf"))
            self.assertFalse(upload_identity.is_issued_upload(BUCKET, "uploads/a.pdf"))


class UploadIssuanceTests(unittest.TestCase):
    OBJ = (BUCKET, "uploads/csv/1_x_a.csv")
    META = (BUCKET, "uploads/json/1_y_a.csv.metadata.json")

    def test_record_inserts_each_key_for_the_issuer(self):
        conn = FakeConnection()
        upload_issuance.record_issued_uploads(conn, issued_to=SUB, bucket=BUCKET, keys=[self.OBJ[1], self.META[1]])
        inserts = [params for sql, params in conn.executed if sql.startswith("INSERT INTO upload_issuances")]
        self.assertEqual(
            inserts,
            [
                (BUCKET, self.OBJ[1], SUB, upload_issuance.STAGE_WINDOW_SECONDS),
                (BUCKET, self.META[1], SUB, upload_issuance.STAGE_WINDOW_SECONDS),
            ],
        )

    def test_pre_check_is_scoped_to_issuer_unconsumed_and_unexpired(self):
        conn = FakeConnection(rows=[self.OBJ])
        self.assertTrue(upload_issuance.has_unclaimed_uploads(conn, issued_to=SUB, objects=[self.OBJ]))
        sql, params = conn.executed[0]
        self.assertIn("issued_to_sub = %s", sql)
        self.assertIn("consumed_at IS NULL", sql)
        self.assertIn("expires_at > now()", sql)
        self.assertNotIn("FOR UPDATE", sql)
        self.assertEqual(params, [*self.OBJ, SUB])

    def test_pre_check_fails_when_any_object_is_not_claimable(self):
        conn = FakeConnection(rows=[self.OBJ])
        self.assertFalse(upload_issuance.has_unclaimed_uploads(conn, issued_to=SUB, objects=[self.OBJ, self.META]))

    def test_missing_issuer_or_objects_never_matches(self):
        conn = FakeConnection(rows=[self.OBJ])
        self.assertFalse(upload_issuance.has_unclaimed_uploads(conn, issued_to="", objects=[self.OBJ]))
        self.assertFalse(upload_issuance.has_unclaimed_uploads(conn, issued_to=SUB, objects=[]))
        self.assertFalse(upload_issuance.claim_issued_uploads(conn, issued_to=None, objects=[self.OBJ]))
        self.assertEqual(conn.executed, [])

    def test_claim_locks_then_marks_consumed(self):
        conn = FakeConnection(rows=[self.OBJ, self.META])
        self.assertTrue(upload_issuance.claim_issued_uploads(conn, issued_to=SUB, objects=[self.OBJ, self.META]))
        (select_sql, _), (update_sql, update_params) = conn.executed
        self.assertTrue(select_sql.endswith("FOR UPDATE"))
        self.assertIn("SET consumed_at = now()", update_sql)
        self.assertEqual(update_params, [*self.OBJ, *self.META])

    def test_claim_writes_nothing_when_not_all_claimable(self):
        conn = FakeConnection(rows=[self.OBJ])
        self.assertFalse(upload_issuance.claim_issued_uploads(conn, issued_to=SUB, objects=[self.OBJ, self.META]))
        self.assertEqual(len(conn.executed), 1)
        self.assertTrue(conn.executed[0][0].startswith("SELECT"))


class PresignRecordsIssuanceTests(unittest.TestCase):
    def setUp(self):
        for patcher in (
            mock.patch.object(presign, "get_cors_headers", return_value={}),
            mock.patch.object(presign_batch, "get_cors_headers", return_value={}),
            mock.patch.object(presign, "s3"),
            mock.patch.object(presign_batch, "s3"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        presign.s3.generate_presigned_url.return_value = "https://signed"
        presign_batch.s3.generate_presigned_url.return_value = "https://signed"

    @staticmethod
    def event(sub=SUB, **extra):
        authorizer = {"userId": sub, "email": "admin@example.org"} if sub else {}
        return {"headers": {}, "requestContext": {"authorizer": authorizer}, **extra}

    def test_single_key_is_recorded_for_the_caller_and_committed(self):
        conn = mock.MagicMock()
        with mock.patch.object(presign, "record_issued_uploads") as record:
            response = presign.generate_presigned_url(
                self.event(queryStringParameters={"file_name": "talk.mp4", "content_type": "video/mp4"}), conn
            )
        self.assertEqual(response["statusCode"], 200)
        key = json.loads(response["body"])["key"]
        record.assert_called_once_with(conn, issued_to=SUB, bucket=presign.BUCKET, keys=[key])
        conn.commit.assert_called_once()

    def test_same_name_gets_distinct_keys(self):
        with mock.patch.object(presign, "record_issued_uploads"):
            keys = {
                json.loads(
                    presign.generate_presigned_url(
                        self.event(queryStringParameters={"file_name": "a.pdf", "content_type": "application/pdf"}),
                        mock.MagicMock(),
                    )["body"]
                )["key"]
                for _ in range(2)
            }
        self.assertEqual(len(keys), 2)

    def test_single_without_sub_is_unauthorized(self):
        conn = mock.MagicMock()
        with mock.patch.object(presign, "record_issued_uploads") as record:
            response = presign.generate_presigned_url(
                self.event(sub=None, queryStringParameters={"file_name": "a.pdf"}), conn
            )
        self.assertEqual(response["statusCode"], 401)
        record.assert_not_called()

    def test_single_fails_closed_when_recording_fails(self):
        conn = mock.MagicMock()
        with mock.patch.object(presign, "record_issued_uploads", side_effect=RuntimeError("db down")):
            response = presign.generate_presigned_url(
                self.event(queryStringParameters={"file_name": "a.pdf", "content_type": "application/pdf"}), conn
            )
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("presignedUrl", json.loads(response["body"]))
        conn.rollback.assert_called_once()

    def test_batch_records_every_key_for_the_caller(self):
        conn = mock.MagicMock()
        files = [
            {"file_name": "a b.csv", "content_type": "text/csv"},
            {"file_name": "a_b.csv", "content_type": "text/csv"},
        ]
        with mock.patch.object(presign_batch, "record_issued_uploads") as record:
            response = presign_batch.generate_presigned_urls_batch(self.event(), {"files": files}, conn)
        self.assertEqual(response["statusCode"], 200)
        keys = [entry["key"] for entry in json.loads(response["body"])["presigned_urls"]]
        self.assertEqual(len(set(keys)), 2)
        record.assert_called_once_with(conn, issued_to=SUB, bucket=presign_batch.BUCKET, keys=keys)
        conn.commit.assert_called_once()

    def test_batch_fails_closed_when_recording_fails(self):
        conn = mock.MagicMock()
        with mock.patch.object(presign_batch, "record_issued_uploads", side_effect=RuntimeError("db down")):
            response = presign_batch.generate_presigned_urls_batch(
                self.event(), {"files": [{"file_name": "a.csv", "content_type": "text/csv"}]}, conn
            )
        self.assertEqual(response["statusCode"], 500)
        self.assertNotIn("presigned_urls", json.loads(response["body"]))
        conn.rollback.assert_called_once()

    def test_batch_without_sub_is_unauthorized(self):
        response = presign_batch.generate_presigned_urls_batch(
            self.event(sub=None), {"files": [{"file_name": "a.csv"}]}, mock.MagicMock()
        )
        self.assertEqual(response["statusCode"], 401)


class _StagingBase(_EnvBase):
    def setUp(self):
        super().setUp()
        for patcher in (
            mock.patch.object(stage, "get_cors_headers", return_value={}),
            mock.patch("socket.getaddrinfo", _public_dns),
            mock.patch.object(stage, "_source_type_at_url", return_value=None),
            mock.patch.object(stage, "find_existing_upload", return_value=None),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.head = mock.patch.object(stage, "head_etag", side_effect=AssertionError("S3 must not be called"))
        self.head_mock = self.head.start()
        self.addCleanup(self.head.stop)
        self.unclaimed = mock.patch.object(stage, "has_unclaimed_uploads", return_value=True)
        self.unclaimed_mock = self.unclaimed.start()
        self.addCleanup(self.unclaimed.stop)
        self.claim = mock.patch.object(stage, "claim_issued_uploads", return_value=True)
        self.claim_mock = self.claim.start()
        self.addCleanup(self.claim.stop)
        self.connection = mock.MagicMock()

    def assert_error(self, response, status, error):
        self.assertEqual(response["statusCode"], status)
        self.assertEqual(json.loads(response["body"])["error"], error)
        self.connection.commit.assert_not_called()

    def stage_document(self, bucket=BUCKET, key="uploads/document/1_x_handbook.pdf"):
        return stage._stage_document(
            {},
            {
                "document_file_name": "handbook.pdf",
                "document_s3_bucket": bucket,
                "document_s3_key": key,
                "document_url": "https://example.org/handbook.pdf",
            },
            self.connection, created_by="admin@example.org", created_by_user_id="u1", admin_sub=SUB,
        )

    def stage_video(self, bucket=BUCKET, key="uploads/video/1_x_talk.mp4"):
        return stage._stage_video(
            {},
            {
                "video_file_name": "talk.mp4",
                "video_s3_bucket": bucket,
                "video_s3_key": key,
                "video_url": "https://example.org/talk",
            },
            self.connection, created_by="admin@example.org", created_by_user_id="u1", admin_sub=SUB,
        )

    def stage_pair(self, metadata_bucket=BUCKET, metadata_key="uploads/json/1_y_a.md.metadata.json"):
        return stage.stage_file_pair(
            self.connection,
            created_by_user_id="u1",
            issued_to=SUB,
            source_type="markdown",
            primary_file_name="a.md",
            primary_s3_bucket=BUCKET,
            primary_s3_key="uploads/markdown/1_x_a.md",
            metadata_file_name="a.md.metadata.json",
            metadata_s3_bucket=metadata_bucket,
            metadata_s3_key=metadata_key,
        )


class StagingRejectsForeignLocationTests(_StagingBase):
    def test_document_in_other_bucket_is_rejected(self):
        self.assert_error(self.stage_document(bucket="other-bucket"), 400, stage.UPLOAD_LOCATION_ERROR)

    def test_document_key_outside_uploads_is_rejected(self):
        self.assert_error(self.stage_document(key="transcripts/kc-video-1.json"), 400, stage.UPLOAD_LOCATION_ERROR)

    def test_video_in_other_bucket_is_rejected(self):
        with mock.patch.object(stage, "start_transcription_job") as transcribe:
            self.assert_error(self.stage_video(bucket="other-bucket"), 400, stage.UPLOAD_LOCATION_ERROR)
        transcribe.assert_not_called()

    def test_video_key_outside_uploads_is_rejected(self):
        with mock.patch.object(stage, "start_transcription_job") as transcribe:
            self.assert_error(self.stage_video(key="uploads"), 400, stage.UPLOAD_LOCATION_ERROR)
        transcribe.assert_not_called()

    def test_file_pair_with_foreign_metadata_key_is_rejected(self):
        for metadata_bucket, metadata_key in (
            ("other-bucket", "uploads/json/1_meta.json"),
            (BUCKET, "transcripts/kc-video-1.json"),
        ):
            with self.subTest(bucket=metadata_bucket, key=metadata_key):
                with self.assertRaises(stage.StageRejected) as raised:
                    self.stage_pair(metadata_bucket=metadata_bucket, metadata_key=metadata_key)
                self.assertEqual(raised.exception.status_code, 400)
                self.assertEqual(raised.exception.body["error"], stage.UPLOAD_LOCATION_ERROR)


class StagingRequiresIssuanceTests(_StagingBase):
    """Another admin's upload, an expired one, or one already staged."""

    def test_document_not_issued_to_caller_is_rejected_before_s3(self):
        self.unclaimed_mock.return_value = False
        self.assert_error(self.stage_document(), 400, stage.UPLOAD_NOT_ISSUED_ERROR)
        self.unclaimed_mock.assert_called_once_with(
            self.connection, issued_to=SUB, objects=[(BUCKET, "uploads/document/1_x_handbook.pdf")]
        )
        self.head_mock.assert_not_called()

    def test_video_not_issued_to_caller_is_rejected_before_s3_and_transcribe(self):
        self.unclaimed_mock.return_value = False
        with mock.patch.object(stage, "start_transcription_job") as transcribe:
            self.assert_error(self.stage_video(), 400, stage.UPLOAD_NOT_ISSUED_ERROR)
        self.head_mock.assert_not_called()
        transcribe.assert_not_called()

    def test_file_pair_checks_both_objects(self):
        self.unclaimed_mock.return_value = False
        with self.assertRaises(stage.StageRejected) as raised:
            self.stage_pair()
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.body["error"], stage.UPLOAD_NOT_ISSUED_ERROR)
        self.unclaimed_mock.assert_called_once_with(
            self.connection,
            issued_to=SUB,
            objects=[(BUCKET, "uploads/markdown/1_x_a.md"), (BUCKET, "uploads/json/1_y_a.md.metadata.json")],
        )
        self.head_mock.assert_not_called()

    def test_issued_document_reaches_existence_check(self):
        self.head_mock.side_effect = RuntimeError("missing")
        response = self.stage_document()
        self.head_mock.assert_called_once_with(BUCKET, "uploads/document/1_x_handbook.pdf")
        self.assertIn("does not exist in S3", json.loads(response["body"])["error"])
        self.claim_mock.assert_not_called()

    def test_lost_claim_rejects_document_before_any_write(self):
        self.head_mock.side_effect = None
        self.head_mock.return_value = "etag"
        self.claim_mock.return_value = False
        with mock.patch.object(stage, "_insert_data_source_row") as insert:
            with self.assertRaises(stage.StageRejected) as raised:
                self.stage_document()
        self.assertEqual(raised.exception.status_code, 409)
        insert.assert_not_called()
        self.connection.commit.assert_not_called()

    def test_lost_claim_rejects_video_before_transcribe(self):
        self.head_mock.side_effect = None
        self.head_mock.return_value = "etag"
        self.claim_mock.return_value = False
        with mock.patch.object(stage, "start_transcription_job") as transcribe:
            with self.assertRaises(stage.StageRejected) as raised:
                self.stage_video()
        self.assertEqual(raised.exception.status_code, 409)
        transcribe.assert_not_called()

    def test_failed_transcription_releases_the_claim(self):
        self.head_mock.side_effect = None
        self.head_mock.return_value = "etag"
        with mock.patch.object(stage, "start_transcription_job", side_effect=RuntimeError("bad media")):
            response = self.stage_video()
        self.assertEqual(response["statusCode"], 500)
        self.claim_mock.assert_called_once()
        self.connection.rollback.assert_called_once()
        self.connection.commit.assert_not_called()

    def test_lost_claim_rejects_file_pair_before_any_write(self):
        self.head_mock.side_effect = None
        self.head_mock.return_value = "etag"
        self.claim_mock.return_value = False
        links = {
            "url_column": None, "row_id_column": None, "title_column": None,
            "description_column": None, "citation_column": None, "suggested_url_column": None,
        }
        with mock.patch.object(stage, "_link_config", return_value=links), \
                mock.patch.object(stage, "_insert_data_source_row") as insert:
            with self.assertRaises(stage.StageRejected) as raised:
                self.stage_pair()
        self.assertEqual(raised.exception.status_code, 409)
        insert.assert_not_called()


class DeleteS3ObjectsGuardTests(_EnvBase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(upload_identity, "s3_client")
        self.s3 = patcher.start()
        self.addCleanup(patcher.stop)

    def test_uploads_and_transcripts_in_ingest_bucket_are_deleted(self):
        failed = upload_identity.delete_s3_objects(
            [(BUCKET, "uploads/video/1_talk.mp4"), (BUCKET, "transcripts/kc-video-1.json")]
        )
        self.assertEqual(failed, [])
        self.s3.delete_object.assert_has_calls(
            [
                mock.call(Bucket=BUCKET, Key="uploads/video/1_talk.mp4"),
                mock.call(Bucket=BUCKET, Key="transcripts/kc-video-1.json"),
            ]
        )

    def test_objects_outside_upload_prefixes_are_refused(self):
        failed = upload_identity.delete_s3_objects(
            [
                ("other-bucket", "uploads/video/1_talk.mp4"),
                (BUCKET, "guidelines/policy.pdf"),
                (BUCKET, "transcripts/"),
            ]
        )
        self.assertEqual(failed, ["uploads/video/1_talk.mp4", "guidelines/policy.pdf", "transcripts/"])
        self.s3.delete_object.assert_not_called()

    def test_nothing_is_deleted_without_configured_bucket(self):
        with mock.patch.dict("os.environ", {"KNOWLEDGE_BASE_BUCKET_NAME": ""}):
            failed = upload_identity.delete_s3_objects([(BUCKET, "uploads/a.pdf")])
        self.assertEqual(failed, ["uploads/a.pdf"])
        self.s3.delete_object.assert_not_called()


if __name__ == "__main__":
    unittest.main()
