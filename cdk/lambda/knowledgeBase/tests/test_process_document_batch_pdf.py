"""
How process_document_batch reads PDF documents through helpers/pdf_text.py
and hands runs it has no time for to a fresh invocation. extract_pdf, S3,
the database helpers and Lambda are mocked.

Run from the knowledgeBase dir:

    pytest tests
"""

import io
import json
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)
from _setup import TEST_INVOKE_TOKEN  # noqa: E402

from helpers import process_document_batch as batch  # noqa: E402
from helpers.pdf_text import PdfText, TextractPending  # noqa: E402

TEXT = " ".join(["Families can ask the school team for a planning meeting at any time."] * 6)


def document_run(run_id="run-1", file_name="guide.pdf"):
    return {
        "ingestion_run_id": run_id,
        "data_source_id": f"ds-{run_id}",
        "name": file_name,
        "type": "document",
        "metadata": {
            "s3_bucket": "ingest",
            "s3_key": f"uploads/document/1_{file_name}",
            "document_file_name": file_name,
            "source_url": f"upload://document/{file_name}",
        },
        "run_metadata": {"backend": "pgvector_document"},
    }


class Context:
    """The part of the Lambda context the worker reads."""

    def __init__(self, seconds):
        self.seconds = seconds

    def get_remaining_time_in_millis(self):
        return int(self.seconds * 1000)


class DocumentPdfTests(unittest.TestCase):
    def process(self, runs, *, extract=None, event=None, seconds=600, body=b"%PDF-1.4", invoke_error=None):
        s3 = mock.Mock()
        s3.get_object.side_effect = lambda Bucket, Key: {"Body": io.BytesIO(body)}
        lambda_client = mock.Mock()
        lambda_client.invoke.side_effect = invoke_error
        if extract is None:
            extract = mock.Mock(return_value=PdfText(pages=[TEXT], engine="textract", job_id="job-1"))
        with mock.patch.object(batch, "_running_document_runs", return_value=runs), \
                mock.patch.object(batch, "s3_client", s3), \
                mock.patch.object(batch, "extract_pdf", extract), \
                mock.patch.object(batch, "_upsert_source", return_value="src-1"), \
                mock.patch.object(batch, "write_chunks",
                                  return_value={"written": 2, "embedded": 2, "deleted": 0}) as write, \
                mock.patch.object(batch, "_finish_run") as finish, \
                mock.patch.object(batch, "_fail_runs") as fail_runs, \
                mock.patch.object(batch, "lambda_client", lambda_client), \
                mock.patch.object(batch, "LAMBDA_FUNCTION_NAME", "kb-fn"):
            result = batch.process_document_batch(event or {}, mock.MagicMock(), context=Context(seconds))
        return result, {
            "extract": extract,
            "write": write,
            "finish": finish,
            "fail_runs": fail_runs,
            "invoke": lambda_client.invoke,
        }

    def test_pdf_is_read_in_place_and_how_is_recorded_on_the_run(self):
        result, calls = self.process([document_run()])
        self.assertEqual(result["completed"], ["run-1"])
        kwargs = calls["extract"].call_args.kwargs
        self.assertEqual(kwargs["s3_object"], {"Bucket": "ingest", "Name": "uploads/document/1_guide.pdf"})
        self.assertTrue(kwargs["allow_pending"])
        self.assertEqual(kwargs["time_left"](), 600)
        self.assertIn("planning meeting", calls["write"].call_args.args[2][0]["text"])
        finish = calls["finish"].call_args
        self.assertEqual(finish.args[2], "completed")
        extraction = finish.kwargs["metadata"]["pdf_extraction"]
        self.assertEqual((extraction["engine"], extraction["textract_job_id"]), ("textract", "job-1"))

    def test_pdf_without_text_fails_with_the_reason(self):
        pdf = PdfText(pages=[""], note="Textract failed: ThrottlingException", retryable=True)
        result, calls = self.process([document_run()], extract=mock.Mock(return_value=pdf))
        self.assertEqual(result["failed"], ["run-1"])
        calls["write"].assert_not_called()
        finish = calls["finish"].call_args
        self.assertEqual(finish.args[2], "failed")
        message = finish.kwargs["error_message"]
        self.assertIn("no extractable text (Textract failed: ThrottlingException)", message)
        self.assertIn("Retry this source", message)
        self.assertEqual(finish.kwargs["metadata"]["pdf_extraction"]["engine"], "pypdf")

    def test_scan_without_text_even_after_ocr_is_not_offered_a_retry(self):
        pdf = PdfText(pages=["", ""], engine="textract")
        _, calls = self.process([document_run()], extract=mock.Mock(return_value=pdf))
        message = calls["finish"].call_args.kwargs["error_message"]
        self.assertIn("OCR found none", message)
        self.assertNotIn("Retry", message)

    def test_ocr_still_running_hands_this_and_later_runs_to_a_new_invocation(self):
        extract = mock.Mock(side_effect=TextractPending("job-7"))
        result, calls = self.process([document_run("run-1"), document_run("run-2")], extract=extract)
        self.assertEqual(result["deferred"], ["run-1", "run-2"])
        self.assertEqual((result["completed"], result["failed"]), ([], []))
        self.assertEqual(extract.call_count, 1)
        calls["finish"].assert_not_called()
        invoke = calls["invoke"].call_args.kwargs
        self.assertEqual(invoke["InvocationType"], "Event")
        self.assertEqual(json.loads(invoke["Payload"]),
                         {"task": "process_document_batch", "continuation": 1, "invoke_token": TEST_INVOKE_TOKEN})

    def test_no_run_starts_without_enough_time(self):
        result, calls = self.process([document_run()], seconds=batch._MIN_SECONDS_TO_START_RUN - 1)
        calls["extract"].assert_not_called()
        self.assertEqual(result["deferred"], ["run-1"])
        calls["invoke"].assert_called_once()

    def test_last_continuation_reads_without_deferring(self):
        _, calls = self.process([document_run()], event={"continuation": batch._MAX_CONTINUATIONS})
        self.assertFalse(calls["extract"].call_args.kwargs["allow_pending"])

    def test_runs_left_after_the_last_continuation_are_failed(self):
        result, calls = self.process(
            [document_run()],
            event={"continuation": batch._MAX_CONTINUATIONS},
            seconds=batch._MIN_SECONDS_TO_START_RUN - 1,
        )
        calls["invoke"].assert_not_called()
        self.assertEqual(result["failed"], ["run-1"])
        run_ids, message = calls["fail_runs"].call_args.args[1:]
        self.assertEqual(run_ids, ["run-1"])
        self.assertIn("ran out of time", message)

    def test_runs_are_failed_when_the_continuation_cannot_start(self):
        result, calls = self.process([document_run()], seconds=10, invoke_error=RuntimeError("throttled"))
        self.assertEqual(result["failed"], ["run-1"])
        calls["fail_runs"].assert_called_once()

    def test_txt_document_skips_the_pdf_reader(self):
        result, calls = self.process([document_run(file_name="notes.txt")], body=TEXT.encode())
        calls["extract"].assert_not_called()
        self.assertEqual(result["completed"], ["run-1"])
        self.assertNotIn("pdf_extraction", calls["finish"].call_args.kwargs["metadata"])


if __name__ == "__main__":
    unittest.main()
