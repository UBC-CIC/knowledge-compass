"""
Unit tests for helpers/pdf_text.py: Textract reading order, the auto-mode
check, and how a PDF is routed to Textract (sync, async, cached, picked up
again later) or falls back to pypdf. Textract and S3 are in-memory fakes and
poll sleeps only move a fake clock; nothing calls AWS.

Run from the knowledgeBase dir:

    pytest tests
"""

import hashlib
import io
import json
import os
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from botocore.exceptions import ClientError  # noqa: E402

from helpers import pdf_text  # noqa: E402
from helpers.pdf_text import PdfText, TextractPending, linearize  # noqa: E402

BUCKET = "ingest-bucket"
UPLOAD = {"Bucket": BUCKET, "Name": "uploads/document/1_guide.pdf"}
READABLE = " ".join(["Families and schools can plan inclusive supports together."] * 4)


def make_pdf(*page_texts: str) -> bytes:
    """A minimal PDF, one page per text. An empty text makes a page without a text layer, like a scan."""
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    }
    kids = []
    number = 4
    for text in page_texts:
        page, content = number, number + 1
        number += 2
        kids.append(b"%d 0 R" % page)
        stream = b"BT /F1 9 Tf 20 700 Td (" + text.encode("latin-1") + b") Tj ET" if text else b""
        objects[page] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R "
            b"/Resources << /Font << /F1 3 0 R >> >> >>" % content
        )
        objects[content] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    objects[2] = b"<< /Type /Pages /Kids [" + b" ".join(kids) + b"] /Count %d >>" % len(page_texts)

    out = b"%PDF-1.4\n"
    offsets = {}
    for obj in range(1, number):
        offsets[obj] = len(out)
        out += b"%d 0 obj\n" % obj + objects[obj] + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % number
    out += b"".join(b"%010d 00000 n \n" % offsets[obj] for obj in range(1, number))
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (number, xref)
    return out


# ── Textract blocks ───────────────────────────────────────────────────────────

def page_block(page):
    return {"BlockType": "PAGE", "Id": f"page-{page}", "Page": page}


def line(block_id, text, page=1):
    return {
        "BlockType": "LINE",
        "Id": block_id,
        "Text": text,
        "Page": page,
        "Geometry": {"BoundingBox": {"Left": 0.1, "Top": 0.1, "Width": 0.5, "Height": 0.02}},
    }


def word(block_id, text, page=1):
    return {"BlockType": "WORD", "Id": block_id, "Text": text, "Page": page}


def layout(kind, block_id, children, page=1):
    return {
        "BlockType": f"LAYOUT_{kind}",
        "Id": block_id,
        "Page": page,
        "Relationships": [{"Type": "CHILD", "Ids": list(children)}],
    }


def text_page(page, *paragraphs):
    """A page's blocks, each paragraph a one-line LAYOUT_TEXT element."""
    blocks = [page_block(page)]
    for n, paragraph in enumerate(paragraphs):
        blocks.append(line(f"line-{page}-{n}", paragraph, page))
        blocks.append(layout("TEXT", f"text-{page}-{n}", [f"line-{page}-{n}"], page))
    return blocks


def client_error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "Operation")


def cache_key(raw):
    return f"textract/cache/v1/{hashlib.sha256(raw).hexdigest()}.json"


def job_key(raw):
    return f"textract/jobs/{hashlib.sha256(raw).hexdigest()}.json"


# ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeS3:
    """In-memory S3 holding the cache, job records and staged copies."""

    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.deleted = []
        self.buckets = set()

    def get_object(self, Bucket, Key):
        self.buckets.add(Bucket)
        if Key not in self.objects:
            raise client_error("NoSuchKey")
        return {"Body": io.BytesIO(self.objects[Key])}

    def put_object(self, Bucket, Key, Body, ContentType=None):
        self.buckets.add(Bucket)
        self.objects[Key] = Body
        return {}

    def delete_object(self, Bucket, Key):
        self.buckets.add(Bucket)
        self.objects.pop(Key, None)
        self.deleted.append(Key)
        return {}

    def staged(self):
        return [key for key in self.objects if key.startswith("textract/input/")]

    def json(self, key):
        return json.loads(self.objects[key])


class FakeTextract:
    """
    Scripted Textract. analyze_document returns `blocks`. Each async job
    reports the next of `statuses` per status check (the last one repeats),
    then its `blocks` spread over `result_pages` pages of results.
    """

    def __init__(self, blocks=(), *, statuses=("SUCCEEDED",), result_pages=1, error=None, expired=()):
        self.blocks = list(blocks)
        self.statuses = list(statuses)
        self.result_pages = result_pages
        self.error = error
        self.expired = set(expired)
        self.calls = []
        self.checks = {}
        self.started = 0

    def names(self):
        return [name for name, _ in self.calls]

    def _called(self, name, kwargs):
        self.calls.append((name, kwargs))
        if self.error is not None:
            raise self.error

    def analyze_document(self, **kwargs):
        self._called("analyze_document", kwargs)
        return {"Blocks": self.blocks}

    def start_document_analysis(self, **kwargs):
        self._called("start_document_analysis", kwargs)
        self.started += 1
        return {"JobId": f"job-{self.started}"}

    def get_document_analysis(self, JobId, MaxResults=1000, NextToken=None):
        self._called("get_document_analysis", {"JobId": JobId, "NextToken": NextToken})
        if JobId in self.expired:
            raise client_error("InvalidJobIdException")
        if NextToken is None:
            check = self.checks.get(JobId, 0)
            self.checks[JobId] = check + 1
            status = self.statuses[min(check, len(self.statuses) - 1)]
            if status == "IN_PROGRESS":
                return {"JobStatus": status}
            if status == "FAILED":
                return {"JobStatus": status, "StatusMessage": "the document could not be read"}
            index = 0
        else:
            status, index = "SUCCEEDED", int(NextToken)
        size = -(-len(self.blocks) // self.result_pages)
        response = {"JobStatus": status, "Blocks": self.blocks[index * size:(index + 1) * size]}
        if index + 1 < self.result_pages:
            response["NextToken"] = str(index + 1)
        return response


class Clock:
    """time_left for extract_pdf that only runs down when pdf_text sleeps between polls."""

    def __init__(self, seconds):
        self.seconds = seconds
        self.slept = []

    def __call__(self):
        return self.seconds

    def sleep(self, delay):
        self.slept.append(delay)
        self.seconds -= delay


class PdfTextCase(unittest.TestCase):
    def extract(self, raw, *, mode="always", textract=None, s3=None, bucket=BUCKET, clock=None, **kwargs):
        """extract_pdf against fakes; returns (result, textract, s3)."""
        textract = textract if textract is not None else FakeTextract()
        s3 = s3 if s3 is not None else FakeS3()
        clock = clock if clock is not None else Clock(600)
        env = {"PDF_TEXTRACT_MODE": mode}
        if bucket:
            env["KNOWLEDGE_BASE_BUCKET_NAME"] = bucket
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(pdf_text, "textract_client", textract), \
                mock.patch.object(pdf_text, "s3_client", s3), \
                mock.patch.object(pdf_text, "_sleep", clock.sleep):
            result = pdf_text.extract_pdf(raw, time_left=clock, **kwargs)
        return result, textract, s3


# ── Tests ─────────────────────────────────────────────────────────────────────

class LinearizeTests(unittest.TestCase):
    def test_reading_order_without_headers_footers_or_page_numbers(self):
        blocks = [
            page_block(1),
            line("header", "Inclusion Canada | Family guide"),
            line("title", "Planning a transition"),
            line("a1", "Start early and meet"),
            word("w1", "Start"),
            line("a2", "the school team together."),
            line("b1", "The second column keeps"),
            line("b2", "its own paragraph."),
            line("number", "3"),
            layout("HEADER", "H", ["header"]),
            layout("TITLE", "T", ["title"]),
            layout("TEXT", "A", ["a1", "a2"]),
            layout("TEXT", "B", ["b1", "b2"]),
            layout("PAGE_NUMBER", "N", ["number"]),
        ]
        pages, seen = linearize(pdf_text._slim(blocks))
        self.assertEqual(pages, [
            "Planning a transition\n\n"
            "Start early and meet the school team together.\n\n"
            "The second column keeps its own paragraph."
        ])
        self.assertEqual(seen, {1})

    def test_list_items_stay_on_their_own_lines(self):
        blocks = [
            page_block(1),
            line("i1", "Ask for a meeting"),
            line("i2", "Bring your notes"),
            layout("TEXT", "item1", ["i1"]),
            layout("TEXT", "item2", ["i2"]),
            layout("LIST", "list", ["item1", "item2"]),
        ]
        pages, _ = linearize(pdf_text._slim(blocks))
        self.assertEqual(pages, ["Ask for a meeting\nBring your notes"])

    def test_line_break_after_a_hyphen_joins_the_word(self):
        blocks = [
            page_block(1),
            line("a", "A family-"),
            line("b", "centred plan for Grade 7 -"),
            line("c", "Grade 8"),
            layout("TEXT", "T", ["a", "b", "c"]),
        ]
        pages, _ = linearize(pdf_text._slim(blocks))
        self.assertEqual(pages, ["A family-centred plan for Grade 7 - Grade 8"])

    def test_lines_outside_layout_elements_are_kept(self):
        blocks = [
            page_block(1), line("a", "First line"), line("b", "Second line"),
            page_block(2), line("c", "Page two", page=2),
        ]
        pages, seen = linearize(pdf_text._slim(blocks))
        self.assertEqual(pages, ["First line\nSecond line", "Page two"])
        self.assertEqual(seen, {1, 2})

    def test_pages_missing_from_the_response_are_blank_and_not_seen(self):
        pages, seen = linearize(pdf_text._slim(text_page(2, "Only page two")), page_count=3)
        self.assertEqual(pages, ["", "Only page two", ""])
        self.assertEqual(seen, {2})


class NeedsOcrTests(unittest.TestCase):
    def test_readable_text_layer_needs_no_ocr(self):
        self.assertFalse(pdf_text.needs_ocr([READABLE] * 4))
        self.assertFalse(pdf_text.needs_ocr([READABLE] * 5 + [""]))  # the odd blank page is fine

    def test_missing_or_garbled_text_needs_ocr(self):
        garbled = " ".join(["#$%&*+=0123"] * 30)  # what fonts without a Unicode map produce
        self.assertTrue(pdf_text.needs_ocr([]))
        self.assertTrue(pdf_text.needs_ocr([READABLE] * 3 + [""]))  # a quarter of the pages
        self.assertTrue(pdf_text.needs_ocr([garbled, READABLE]))


class ModeTests(PdfTextCase):
    def test_off_uses_the_embedded_text_only(self):
        result, textract, _ = self.extract(make_pdf(READABLE), mode="off")
        self.assertEqual((result.engine, textract.calls, result.note), ("pypdf", [], "OCR is turned off"))
        self.assertIn("Families and schools", result.text)

    def test_auto_leaves_a_readable_text_layer_alone(self):
        result, textract, _ = self.extract(make_pdf(READABLE, READABLE), mode="auto")
        self.assertEqual((result.engine, textract.calls), ("pypdf", []))
        self.assertIn("not needed", result.note)

    def test_auto_reads_scanned_pages_with_textract(self):
        textract = FakeTextract(text_page(1, "Scanned page one") + text_page(2, "Scanned page two"))
        result, _, _ = self.extract(make_pdf("", ""), mode="auto", textract=textract, s3_object=UPLOAD)
        self.assertEqual(result.engine, "textract")
        self.assertEqual(result.pages, ["Scanned page one", "Scanned page two"])

    def test_unknown_mode_means_always(self):
        result, _, _ = self.extract(make_pdf(READABLE), mode="sometimes",
                                    textract=FakeTextract(text_page(1, "Read by Textract")))
        self.assertEqual(result.engine, "textract")
        with mock.patch.dict(os.environ, {"PDF_TEXTRACT_MODE": " OFF "}):
            self.assertFalse(pdf_text.ocr_enabled())


class RoutingTests(PdfTextCase):
    def test_single_page_pdf_uses_the_synchronous_api_and_is_cached(self):
        raw = make_pdf(READABLE)
        result, textract, s3 = self.extract(raw, textract=FakeTextract(text_page(1, "Read by Textract")))
        self.assertEqual(textract.names(), ["analyze_document"])
        self.assertEqual(textract.calls[0][1], {"Document": {"Bytes": raw}, "FeatureTypes": ["LAYOUT"]})
        self.assertEqual((result.engine, result.pages, result.job_id), ("textract", ["Read by Textract"], None))
        self.assertEqual(s3.json(cache_key(raw)), {"pages": ["Read by Textract"]})
        self.assertEqual(s3.buckets, {BUCKET})

    def test_upload_is_read_in_place_by_an_async_job(self):
        raw = make_pdf("", "")
        textract = FakeTextract(text_page(1, "One") + text_page(2, "Two"))
        result, textract, s3 = self.extract(raw, textract=textract, s3_object=UPLOAD)
        self.assertEqual(textract.names(), ["start_document_analysis", "get_document_analysis"])
        self.assertEqual(textract.calls[0][1], {
            "DocumentLocation": {"S3Object": {"Bucket": BUCKET, "Name": UPLOAD["Name"]}},
            "FeatureTypes": ["LAYOUT"],
        })
        self.assertEqual((result.pages, result.job_id), (["One", "Two"], "job-1"))
        self.assertEqual(s3.staged(), [])
        self.assertNotIn(job_key(raw), s3.objects)  # a job is forgotten once read
        self.assertIn(cache_key(raw), s3.objects)

    def test_fetched_pdf_is_staged_and_the_copy_removed_after_reading(self):
        textract = FakeTextract(text_page(1, "One") + text_page(2, "Two"))
        result, textract, s3 = self.extract(make_pdf("", ""), textract=textract)
        staged_key = textract.calls[0][1]["DocumentLocation"]["S3Object"]["Name"]
        self.assertTrue(staged_key.startswith("textract/input/"))
        self.assertIn(staged_key, s3.deleted)
        self.assertEqual((s3.staged(), result.pages), ([], ["One", "Two"]))

    def test_results_are_read_across_result_pages(self):
        blocks = text_page(1, "One") + text_page(2, "Two") + text_page(3, "Three")
        textract = FakeTextract(blocks, result_pages=3)
        result, textract, _ = self.extract(make_pdf("", "", ""), textract=textract, s3_object=UPLOAD)
        self.assertEqual(result.pages, ["One", "Two", "Three"])
        tokens = [kwargs["NextToken"] for name, kwargs in textract.calls if name == "get_document_analysis"]
        self.assertEqual(tokens, [None, "1", "2"])

    def test_polls_with_backoff_until_the_job_finishes(self):
        textract = FakeTextract(text_page(1, "One") + text_page(2, "Two"),
                                statuses=("IN_PROGRESS", "IN_PROGRESS", "SUCCEEDED"))
        clock = Clock(600)
        result, _, _ = self.extract(make_pdf("", ""), textract=textract, clock=clock, s3_object=UPLOAD)
        self.assertEqual(result.engine, "textract")
        self.assertEqual(clock.slept, [2.0, 3.0, 4.5])

    def test_cached_text_is_used_without_calling_textract(self):
        raw = make_pdf(READABLE, READABLE)
        s3 = FakeS3({cache_key(raw): json.dumps({"pages": ["one", "two"]}).encode()})
        result, textract, _ = self.extract(raw, s3=s3)
        self.assertEqual(textract.calls, [])
        self.assertEqual((result.engine, result.cached, result.pages), ("textract", True, ["one", "two"]))

    def test_a_corrupt_cache_entry_is_a_miss(self):
        raw = make_pdf(READABLE)
        s3 = FakeS3({cache_key(raw): b"not json"})
        result, textract, _ = self.extract(raw, s3=s3, textract=FakeTextract(text_page(1, "Fresh")))
        self.assertEqual(textract.names(), ["analyze_document"])
        self.assertEqual((result.cached, result.pages), (False, ["Fresh"]))


class TimeBudgetTests(PdfTextCase):
    def test_job_that_outlives_the_budget_falls_back_but_stays_recorded(self):
        raw = make_pdf(READABLE, READABLE)
        s3 = FakeS3()
        result, _, _ = self.extract(raw, textract=FakeTextract(statuses=("IN_PROGRESS",)), s3=s3,
                                    clock=Clock(pdf_text.RESERVE_SECONDS + 20))
        self.assertEqual((result.engine, result.retryable), ("pypdf", True))
        self.assertIn("did not finish in time", result.note)
        self.assertIn("Families and schools", result.text)
        record = s3.json(job_key(raw))
        self.assertEqual(record["job_id"], "job-1")
        self.assertIn(record["staged_key"], s3.objects)  # kept until the job's results are read

    def test_a_later_call_for_the_same_bytes_picks_up_the_job(self):
        raw = make_pdf("", "")
        textract = FakeTextract(text_page(1, "One") + text_page(2, "Two"),
                                statuses=("IN_PROGRESS", "IN_PROGRESS", "SUCCEEDED"))
        s3 = FakeS3()
        with self.assertRaises(TextractPending) as pending:
            self.extract(raw, textract=textract, s3=s3, clock=Clock(pdf_text.RESERVE_SECONDS + 3),
                         s3_object=UPLOAD, allow_pending=True)
        self.assertEqual(pending.exception.job_id, "job-1")

        result, _, _ = self.extract(raw, textract=textract, s3=s3, s3_object=UPLOAD, allow_pending=True)
        self.assertEqual(textract.started, 1)
        self.assertEqual((result.engine, result.job_id, result.pages), ("textract", "job-1", ["One", "Two"]))
        self.assertNotIn(job_key(raw), s3.objects)

    def test_pending_needs_a_bucket_to_record_the_job(self):
        result, _, _ = self.extract(make_pdf(READABLE, READABLE), textract=FakeTextract(statuses=("IN_PROGRESS",)),
                                    bucket=None, clock=Clock(pdf_text.RESERVE_SECONDS + 20),
                                    s3_object=UPLOAD, allow_pending=True)
        self.assertEqual(result.engine, "pypdf")
        self.assertIn("did not finish in time", result.note)

    def test_no_time_to_wait_means_no_new_job(self):
        result, textract, _ = self.extract(make_pdf(READABLE, READABLE), clock=Clock(pdf_text.RESERVE_SECONDS + 5))
        self.assertEqual(textract.calls, [])
        self.assertEqual((result.engine, result.retryable), ("pypdf", True))
        self.assertIn("not enough time", result.note)

    def test_an_expired_job_is_replaced(self):
        raw = make_pdf("", "")
        s3 = FakeS3({job_key(raw): json.dumps({"job_id": "old", "staged_key": None}).encode()})
        textract = FakeTextract(text_page(1, "One") + text_page(2, "Two"), expired={"old"})
        result, textract, _ = self.extract(raw, textract=textract, s3=s3, s3_object=UPLOAD)
        self.assertEqual(textract.names(), ["get_document_analysis", "start_document_analysis", "get_document_analysis"])
        self.assertEqual(result.job_id, "job-1")


class FailureTests(PdfTextCase):
    def test_failed_job_falls_back_and_is_forgotten(self):
        raw = make_pdf(READABLE, READABLE)
        result, _, s3 = self.extract(raw, textract=FakeTextract(statuses=("FAILED",)))
        self.assertEqual((result.engine, result.retryable), ("pypdf", True))
        self.assertIn("Textract job failed: the document could not be read", result.note)
        self.assertNotIn(job_key(raw), s3.objects)
        self.assertEqual(s3.staged(), [])

    def test_document_errors_are_not_retryable(self):
        textract = FakeTextract(error=client_error("UnsupportedDocumentException"))
        result, _, s3 = self.extract(make_pdf("", ""), textract=textract)
        self.assertEqual((result.engine, result.retryable, result.text), ("pypdf", False, ""))
        self.assertEqual(result.empty_reason(), "no extractable text (Textract failed: UnsupportedDocumentException)")
        self.assertEqual(s3.staged(), [])  # the staged copy goes when the job can't start

    def test_throttling_is_retryable_and_keeps_the_embedded_text(self):
        textract = FakeTextract(error=client_error("ProvisionedThroughputExceededException"))
        result, _, _ = self.extract(make_pdf(READABLE), textract=textract)
        self.assertEqual((result.engine, result.retryable), ("pypdf", True))
        self.assertIn("Families and schools", result.text)

    def test_partial_success_fills_missing_pages_with_embedded_text(self):
        raw = make_pdf("", READABLE)
        textract = FakeTextract(text_page(1, "Scanned first page"), statuses=("PARTIAL_SUCCESS",))
        result, _, s3 = self.extract(raw, textract=textract, s3_object=UPLOAD)
        self.assertEqual((result.engine, result.pages[0]), ("textract", "Scanned first page"))
        self.assertIn("Families and schools", result.pages[1])
        self.assertIn("Textract returned 1 of 2 pages", result.note)
        self.assertNotIn(cache_key(raw), s3.objects)  # incomplete results aren't cached

    def test_over_the_page_limit_skips_textract(self):
        with mock.patch.object(pdf_text, "_ASYNC_MAX_PAGES", 1):
            result, textract, _ = self.extract(make_pdf(READABLE, READABLE))
        self.assertEqual(textract.calls, [])
        self.assertEqual((result.engine, result.retryable), ("pypdf", False))
        self.assertIn("page limit", result.note)

    def test_multi_page_fetch_without_a_bucket_falls_back(self):
        result, textract, _ = self.extract(make_pdf(READABLE, READABLE), bucket=None)
        self.assertEqual(textract.calls, [])
        self.assertEqual((result.engine, result.retryable), ("pypdf", True))
        self.assertIn("no ingest bucket", result.note)

    def test_file_pypdf_cannot_open_still_goes_to_textract(self):
        textract = FakeTextract(text_page(1, "Recovered by OCR"))
        result, textract, _ = self.extract(b"not really a pdf", textract=textract, s3_object=UPLOAD)
        self.assertIn("pypdf could not read the file", result.note)
        self.assertEqual((result.engine, result.pages), ("textract", ["Recovered by OCR"]))
        self.assertEqual(textract.names()[0], "start_document_analysis")


class SummaryTests(unittest.TestCase):
    def test_summary_describes_the_read_without_its_text(self):
        pdf = PdfText(pages=["A private family story", ""], engine="textract", note="n",
                      job_id="job-9", cached=True, seconds=1.5)
        summary = pdf.summary()
        self.assertEqual(summary, {
            "engine": "textract", "pages": 2, "characters": 22, "seconds": 1.5,
            "cached": True, "textract_job_id": "job-9", "note": "n",
        })
        self.assertNotIn("private", json.dumps(summary))

    def test_empty_reason_says_what_was_tried(self):
        self.assertEqual(PdfText(engine="textract").empty_reason(), "no extractable text (OCR found none)")
        self.assertEqual(PdfText(note="OCR is turned off").empty_reason(), "no extractable text (OCR is turned off)")


if __name__ == "__main__":
    unittest.main()
