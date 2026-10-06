"""
pdf_text.py

Reads the text of a PDF for pgvector ingestion: uploaded documents
(process_document_batch.py) and PDFs linked from CSV rows
(process_csv_links.py).

Amazon Textract (document analysis with the LAYOUT feature) reads pages the
way a person does: it OCRs scanned and image-only pages, returns paragraphs in
reading order across columns, and labels running headers, footers and page
numbers so they stay out of chunks. PDF_TEXTRACT_MODE picks when it is used:

- always (default): every PDF;
- auto: only PDFs whose embedded text layer is missing or unreadable on at
  least a quarter of their pages (scans, image-only exports, broken fonts);
- off: never (pypdf only, the behaviour before Textract).

pypdf's embedded text is the fallback whenever Textract is skipped or fails
(an error, out of time, over its limits), so a PDF that indexed before keeps
indexing. Pages a partially successful job did not return keep their pypdf
text too.

Single-page PDFs up to 10 MB go to the synchronous API as bytes; anything else
needs an asynchronous job reading from S3. Uploaded documents pass their own
ingest-bucket object; fetched PDFs are staged under textract/input/. A job is
polled until it finishes or the caller's time budget runs out, and stays
recorded under textract/jobs/ (by content hash) until its results are read,
so a later call for the same bytes (a continuation, a retry, the next sync)
picks it up instead of paying for a new one. Textract keeps async results for
7 days. Callers that can come back later ask for TextractPending instead of
the fallback.

Finished results are cached by content hash under textract/cache/, so
re-syncing an unchanged PDF does not pay for OCR again. The ingest bucket
expires everything under textract/ after 30 days (see
cdk/lib/ingestion-stack.ts).
"""

import hashlib
import io
import json
import logging
import os
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from typing import NamedTuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from pypdf import PdfReader

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ["REGION"]

MODE_ALWAYS = "always"
MODE_AUTO = "auto"
MODE_OFF = "off"
_MODES = (MODE_ALWAYS, MODE_AUTO, MODE_OFF)

_FEATURES = ["LAYOUT"]

# Textract document limits: https://docs.aws.amazon.com/textract/latest/dg/limits-document.html
_SYNC_MAX_BYTES = 10 * 1024 * 1024  # the synchronous API also takes one page only
_ASYNC_MAX_BYTES = 500 * 1024 * 1024
_ASYNC_MAX_PAGES = 3000

# Seconds kept free after OCR for chunking, embedding and database writes.
RESERVE_SECONDS = 90
# How long OCR may wait when the caller gives no time budget.
_DEFAULT_WAIT_SECONDS = 300
# A new job isn't started without at least this long to wait for it, unless
# the caller can come back for it later.
_MIN_WAIT_SECONDS = 15
_POLL_FIRST_SECONDS = 2.0
_POLL_MAX_SECONDS = 10.0
_POLL_BACKOFF = 1.5
_RESULTS_PER_CALL = 1000

# auto mode: a page's embedded text is unreadable with fewer words than this,
# or when under half of its visible characters are letters (the garbage fonts
# without a Unicode map produce). A quarter of unreadable pages means OCR.
_MIN_WORDS_PER_PAGE = 20
_MIN_LETTER_SHARE = 0.5
_UNREADABLE_PAGE_SHARE = 0.25

_STAGING_PREFIX = "textract/input/"
_JOBS_PREFIX = "textract/jobs/"
_CACHE_PREFIX = "textract/cache/"
# Bump when linearized output changes so older cache entries stop matching.
_CACHE_VERSION = 1

# Layout elements left out of the text, and those whose lines stay on their
# own line instead of being unwrapped into a paragraph.
_SKIPPED_LAYOUT = {"LAYOUT_HEADER", "LAYOUT_FOOTER", "LAYOUT_PAGE_NUMBER"}
_LINE_BY_LINE_LAYOUT = {"LAYOUT_LIST", "LAYOUT_TABLE", "LAYOUT_KEY_VALUE", "LAYOUT_FIGURE"}

# Textract errors about the document itself: retrying the same bytes won't help.
_DOCUMENT_ERRORS = {
    "BadDocumentException",
    "DocumentTooLargeException",
    "InvalidParameterException",
    "UnsupportedDocumentException",
}

# Adaptive retries absorb Textract's low default TPS quotas (1-2 requests/s
# outside the largest regions) when several PDFs are read at once.
textract_client = boto3.client(
    "textract",
    region_name=REGION,
    config=Config(retries={"mode": "adaptive", "max_attempts": 8}, connect_timeout=10, read_timeout=60),
)
s3_client = boto3.client("s3", region_name=REGION)
_sleep = time.sleep


@dataclass
class PdfText:
    """A PDF's text, one string per page, and how it was read."""

    pages: list = field(default_factory=list)
    engine: str = "pypdf"  # whose text `pages` holds: "textract" or "pypdf"
    note: str | None = None  # why Textract wasn't used, or what it couldn't do
    retryable: bool = False  # Textract was wanted but failed in a way a retry may fix
    job_id: str | None = None  # async Textract job that produced the text
    cached: bool = False
    seconds: float = 0.0

    @property
    def text(self) -> str:
        return "\n\n".join(page for page in self.pages if page.strip())

    def summary(self) -> dict:
        """How the PDF was read, without any of its text (safe to log and store)."""
        summary = {
            "engine": self.engine,
            "pages": len(self.pages),
            "characters": len(self.text),
            "seconds": self.seconds,
        }
        if self.cached:
            summary["cached"] = True
        if self.job_id:
            summary["textract_job_id"] = self.job_id
        if self.note:
            summary["note"] = self.note
        return summary

    def empty_reason(self) -> str:
        """Why no text came out, for run errors and CSV link reasons."""
        if self.engine == "textract":
            return "no extractable text (OCR found none)"
        return f"no extractable text ({self.note})" if self.note else "no extractable text"


class TextractPending(Exception):
    """
    A Textract job outlived the time budget. It keeps running and stays
    recorded, so calling extract_pdf again with the same bytes picks it up.
    """

    def __init__(self, job_id: str):
        super().__init__(f"Textract job {job_id} is still running")
        self.job_id = job_id


class _Unusable(Exception):
    """Textract can't provide this PDF's text right now; fall back to pypdf."""

    def __init__(self, note: str, *, retryable: bool):
        super().__init__(note)
        self.note = note
        self.retryable = retryable


class _OutOfTime(Exception):
    pass


class _Read(NamedTuple):
    pages: list
    seen: set  # page numbers Textract returned
    job_id: str | None
    cached: bool


def textract_mode() -> str:
    mode = (os.environ.get("PDF_TEXTRACT_MODE") or MODE_ALWAYS).strip().lower()
    if mode not in _MODES:
        logger.warning("Unknown PDF_TEXTRACT_MODE %r; using %r", mode, MODE_ALWAYS)
        return MODE_ALWAYS
    return mode


def ocr_enabled() -> bool:
    return textract_mode() != MODE_OFF


# ── Entry point ───────────────────────────────────────────────────────────────

def extract_pdf(
    raw_bytes: bytes,
    *,
    s3_object: dict | None = None,
    time_left=None,
    allow_pending: bool = False,
) -> PdfText:
    """
    Text of a PDF, one string per page. Unreadable input and Textract failures
    never raise (the result's note says what happened); the only exception is
    TextractPending, when allow_pending is set and a Textract job outlives the
    time budget.

    s3_object: {"Bucket", "Name"} holding these same bytes, so an async job
               can read them without staging a copy.
    time_left: callable returning the seconds the invocation has left; OCR
               stops waiting RESERVE_SECONDS before that.
    """
    started = time.monotonic()
    mode = textract_mode()
    reader, page_count, read_error = _open(raw_bytes)
    notes = [read_error] if read_error else []
    embedded = None

    def embedded_pages() -> list:
        nonlocal embedded
        if embedded is None:
            embedded = _embedded_pages(reader, page_count)
        return embedded

    def result(pages: list, **fields) -> PdfText:
        return PdfText(
            pages=pages,
            note="; ".join(notes) or None,
            seconds=round(time.monotonic() - started, 1),
            **fields,
        )

    if page_count == 0:
        notes.append("the PDF has no pages")
        return result([])
    if mode == MODE_OFF:
        notes.append("OCR is turned off")
        return result(embedded_pages())
    if mode == MODE_AUTO and reader is not None and not needs_ocr(embedded_pages()):
        notes.append("OCR not needed (auto mode)")
        return result(embedded_pages())

    try:
        read = _read_with_textract(
            raw_bytes,
            page_count,
            s3_object=s3_object,
            time_left=time_left,
            allow_pending=allow_pending,
        )
    except _Unusable as e:
        logger.warning("Textract not used for a PDF: %s", e.note)
        notes.append(e.note)
        return result(embedded_pages(), retryable=e.retryable)

    pages = list(read.pages)
    missing = [index for index in range(len(pages)) if index + 1 not in read.seen]
    if missing:
        fallback = embedded_pages()
        for index in missing:
            if index < len(fallback):
                pages[index] = fallback[index]
        notes.append(f"Textract returned {len(pages) - len(missing)} of {len(pages)} pages; embedded text used for the rest")
    return result(pages, engine="textract", job_id=read.job_id, cached=read.cached)


# ── pypdf ─────────────────────────────────────────────────────────────────────

def _open(raw_bytes: bytes):
    """(reader, page count, error note); reader is None when pypdf can't parse the file."""
    try:
        reader = PdfReader(io.BytesIO(raw_bytes))
        return reader, len(reader.pages), None
    except Exception as e:  # noqa: BLE001  (malformed, encrypted, not a PDF)
        return None, None, f"pypdf could not read the file: {e.__class__.__name__}"


def _embedded_pages(reader, page_count) -> list:
    """pypdf's text per page; a page it can't read is left empty instead of losing the rest."""
    pages = []
    for index in range(page_count or 0):
        try:
            pages.append(reader.pages[index].extract_text() or "")
        except Exception as e:  # noqa: BLE001
            logger.warning("pypdf could not read page %d: %s", index + 1, e.__class__.__name__)
            pages.append("")
    return pages


def needs_ocr(pages: list) -> bool:
    """auto mode: whether the embedded text is missing or unreadable on enough pages."""
    if not pages:
        return True
    unreadable = sum(1 for page in pages if not _readable(page))
    return unreadable >= len(pages) * _UNREADABLE_PAGE_SHARE


def _readable(text: str) -> bool:
    if len(text.split()) < _MIN_WORDS_PER_PAGE:
        return False
    visible = [char for char in text if not char.isspace()]
    letters = sum(1 for char in visible if char.isalpha())
    return letters >= len(visible) * _MIN_LETTER_SHARE


# ── Textract ──────────────────────────────────────────────────────────────────

def _read_with_textract(raw_bytes: bytes, page_count, *, s3_object, time_left, allow_pending) -> _Read:
    if len(raw_bytes) > _ASYNC_MAX_BYTES:
        raise _Unusable("the file is over Textract's 500 MB limit", retryable=False)
    if page_count and page_count > _ASYNC_MAX_PAGES:
        raise _Unusable(f"the PDF is over Textract's {_ASYNC_MAX_PAGES:,}-page limit", retryable=False)

    digest = hashlib.sha256(raw_bytes).hexdigest()
    cached = _cache_get(digest)
    if cached is not None:
        return _Read(cached, set(range(1, len(cached) + 1)), None, True)

    seconds_left = _wait_budget(time_left)
    job = None
    try:
        if page_count == 1 and len(raw_bytes) <= _SYNC_MAX_BYTES:
            response = textract_client.analyze_document(Document={"Bytes": raw_bytes}, FeatureTypes=_FEATURES)
            blocks, complete = _slim(response.get("Blocks")), True
        else:
            job, status, blocks = _run_job(digest, raw_bytes, s3_object, seconds_left, allow_pending)
            complete = status == "SUCCEEDED"
        pages, seen = linearize(blocks, page_count)
    except (TextractPending, _Unusable):
        raise
    except ClientError as e:
        code = _code(e)
        raise _Unusable(f"Textract failed: {code}", retryable=code not in _DOCUMENT_ERRORS) from e
    except Exception as e:  # noqa: BLE001  (network errors, timeouts, unexpected responses)
        raise _Unusable(f"Textract failed: {e.__class__.__name__}", retryable=True) from e

    if seen and complete:
        _cache_put(digest, pages)
    if job is not None:
        _forget_job(digest, job)  # only after caching, so a crash here can't lose paid-for results
    if not seen:
        raise _Unusable("Textract returned no pages", retryable=True)
    return _Read(pages, seen, job["job_id"] if job else None, False)


def _run_job(digest: str, raw_bytes: bytes, s3_object, seconds_left, allow_pending) -> tuple:
    """(job, status, slim blocks) of a finished async job: the one recorded for these bytes, or a new one."""
    can_defer = allow_pending and _bucket() is not None
    job = _recorded_job(digest)
    if job is not None:
        try:
            status, blocks = _await_job(digest, job, seconds_left, can_defer, resumed=True)
            return job, status, blocks
        except ClientError as e:
            if _code(e) != "InvalidJobIdException":
                raise
            logger.info("Textract job %s has expired; starting a new one", job["job_id"])
            _forget_job(digest, job)

    if not can_defer and seconds_left() < _MIN_WAIT_SECONDS:
        raise _Unusable("not enough time left to wait for Textract", retryable=True)
    staged = _stage(raw_bytes) if s3_object is None else None
    location = s3_object or staged
    try:
        job_id = textract_client.start_document_analysis(
            DocumentLocation={"S3Object": {"Bucket": location["Bucket"], "Name": location["Name"]}},
            FeatureTypes=_FEATURES,
        )["JobId"]
    except Exception:
        if staged is not None:
            _delete(staged["Name"])
        raise
    logger.info("Started Textract job %s", job_id)
    job = {"job_id": job_id, "staged_key": staged["Name"] if staged else None}
    # A job nobody could find again must not be left running for later.
    recorded = _record_job(digest, job)
    status, blocks = _await_job(digest, job, seconds_left, can_defer and recorded, resumed=False)
    return job, status, blocks


def _await_job(digest: str, job: dict, seconds_left, can_defer: bool, *, resumed: bool) -> tuple:
    """(status, slim blocks) once a job finishes. A failed job is forgotten; one still running stays recorded."""
    try:
        return _poll(job["job_id"], seconds_left, resumed=resumed)
    except _OutOfTime:
        if can_defer:
            raise TextractPending(job["job_id"]) from None
        raise _Unusable("Textract did not finish in time", retryable=True) from None
    except _Unusable:  # the job failed, so a later call starts a new one
        _forget_job(digest, job)
        raise


def _poll(job_id: str, seconds_left, *, resumed: bool) -> tuple:
    """Wait for an async job to finish: (status, slim blocks)."""
    delays = _poll_delays()
    if not resumed:  # a recorded job may already be done, so check it right away
        _wait(next(delays), seconds_left)
    while True:
        response = textract_client.get_document_analysis(JobId=job_id, MaxResults=_RESULTS_PER_CALL)
        status = response.get("JobStatus")
        if status in ("SUCCEEDED", "PARTIAL_SUCCESS"):
            return status, _all_blocks(job_id, response, seconds_left)
        if status == "FAILED":
            reason = response.get("StatusMessage") or "no reason given"
            raise _Unusable(f"Textract job failed: {reason}", retryable=True)
        _wait(next(delays), seconds_left)


def _poll_delays():
    delay = _POLL_FIRST_SECONDS
    while True:
        yield delay
        delay = min(delay * _POLL_BACKOFF, _POLL_MAX_SECONDS)


def _wait(delay: float, seconds_left):
    if seconds_left() < delay:
        raise _OutOfTime()
    _sleep(delay)


def _all_blocks(job_id: str, response: dict, seconds_left) -> list:
    """Every result page of a finished job, slimmed as it is read."""
    blocks = _slim(response.get("Blocks"))
    token = response.get("NextToken")
    while token:
        if seconds_left() <= 0:
            raise _OutOfTime()  # the job stays recorded, so a later call reads it again
        response = textract_client.get_document_analysis(
            JobId=job_id, MaxResults=_RESULTS_PER_CALL, NextToken=token,
        )
        blocks.extend(_slim(response.get("Blocks")))
        token = response.get("NextToken")
    return blocks


def _wait_budget(time_left):
    """Seconds OCR may still wait: the caller's remaining time minus RESERVE_SECONDS."""
    if time_left is None:
        deadline = time.monotonic() + _DEFAULT_WAIT_SECONDS
        return lambda: deadline - time.monotonic()
    return lambda: time_left() - RESERVE_SECONDS


def _code(error: ClientError) -> str:
    return (error.response.get("Error") or {}).get("Code") or "ClientError"


# ── Reading order ─────────────────────────────────────────────────────────────

def _slim(blocks) -> list:
    """The parts of Textract blocks linearize() uses; WORD blocks and geometry are most of a response."""
    slim = []
    for block in blocks or ():
        kind = block.get("BlockType") or ""
        is_layout = kind.startswith("LAYOUT_")
        if not is_layout and kind not in ("PAGE", "LINE"):
            continue
        children = []
        if is_layout:
            for relationship in block.get("Relationships") or ():
                if relationship.get("Type") == "CHILD":
                    children.extend(relationship.get("Ids") or ())
        slim.append({
            "Id": block.get("Id"),
            "BlockType": kind,
            "Page": block.get("Page") or 1,
            "Text": block.get("Text") or "",
            "Children": children,
        })
    return slim


def linearize(blocks: list, page_count: int | None = None) -> tuple:
    """
    (page texts, page numbers covered) from _slim() blocks. Layout elements
    arrive in reading order (down each column, then the next column); headers,
    footers and page numbers are dropped. Lines no layout element claims (all
    of them, for a response without LAYOUT) are kept at the end of their page.
    """
    by_id = {block["Id"]: block for block in blocks}
    layout = [block for block in blocks if block["BlockType"].startswith("LAYOUT_")]
    nested = {
        child_id
        for block in layout
        for child_id in block["Children"]
        if by_id.get(child_id, {}).get("BlockType", "").startswith("LAYOUT_")
    }
    claimed: set = set()
    parts: dict = defaultdict(list)
    for block in layout:
        if block["Id"] in nested:
            continue
        text = _render(block, by_id, claimed)  # also claims header/footer lines
        if text and block["BlockType"] not in _SKIPPED_LAYOUT:
            parts[block["Page"]].append(text)

    stray: dict = defaultdict(list)
    for block in blocks:
        if block["BlockType"] == "LINE" and block["Id"] not in claimed and block["Text"].strip():
            stray[block["Page"]].append(block["Text"].strip())
    for page, lines in stray.items():
        parts[page].append("\n".join(lines))

    seen = {block["Page"] for block in blocks if block["BlockType"] == "PAGE"} | set(parts)
    last = max([page_count or 0, *seen])
    return ["\n\n".join(parts.get(number, ())) for number in range(1, last + 1)], seen


def _render(block: dict, by_id: dict, claimed: set) -> str:
    """Text of one layout element, claiming its lines."""
    pieces = []
    for child_id in block["Children"]:
        child = by_id.get(child_id)
        if child is None:
            continue
        if child["BlockType"] == "LINE":
            claimed.add(child_id)
            piece = child["Text"].strip()
        elif child["BlockType"].startswith("LAYOUT_"):
            piece = _render(child, by_id, claimed)  # list items
        else:
            continue
        if piece:
            pieces.append(piece)
    if block["BlockType"] in _LINE_BY_LINE_LAYOUT:
        return "\n".join(pieces)
    return _paragraph(pieces)


def _paragraph(lines: list) -> str:
    """
    Unwrap a paragraph's lines. A line ending in "-" before a lowercase word is
    joined without a space but keeps the hyphen, since a word broken across
    lines can't be told apart from a compound like "family-centred".
    """
    text = ""
    for line in lines:
        if not text:
            text = line
        elif text.endswith("-") and line[:1].islower():
            text += line
        else:
            text += " " + line
    return text


# ── S3: staged copies, job records and the cache ─────────────────────────────

def _bucket() -> str | None:
    return os.environ.get("KNOWLEDGE_BASE_BUCKET_NAME") or None


def _stage(raw_bytes: bytes) -> dict:
    """Upload bytes for an async job; _forget_job() deletes the copy once the job is done with."""
    bucket = _bucket()
    if not bucket:
        raise _Unusable("no ingest bucket configured to stage the PDF for Textract", retryable=True)
    key = f"{_STAGING_PREFIX}{uuid.uuid4().hex}.pdf"
    try:
        s3_client.put_object(Bucket=bucket, Key=key, Body=raw_bytes, ContentType="application/pdf")
    except ClientError as e:
        raise _Unusable(f"could not stage the PDF for Textract: {_code(e)}", retryable=True) from e
    return {"Bucket": bucket, "Name": key}


def _job_key(digest: str) -> str:
    return f"{_JOBS_PREFIX}{digest}.json"


def _recorded_job(digest: str) -> dict | None:
    """The job an earlier call started for these bytes, until its results are read."""
    record = _read_json(_job_key(digest))
    if not isinstance(record, dict) or not isinstance(record.get("job_id"), str):
        return None
    staged_key = record.get("staged_key")
    return {"job_id": record["job_id"], "staged_key": staged_key if isinstance(staged_key, str) else None}


def _record_job(digest: str, job: dict) -> bool:
    return _write_json(_job_key(digest), job)


def _forget_job(digest: str, job: dict):
    """Drop a job's record and staged copy once its results are read, or it failed or expired."""
    if job.get("staged_key"):
        _delete(job["staged_key"])
    _delete(_job_key(digest))


def _cache_key(digest: str) -> str:
    return f"{_CACHE_PREFIX}v{_CACHE_VERSION}/{digest}.json"


def _cache_get(digest: str) -> list | None:
    record = _read_json(_cache_key(digest))
    pages = record.get("pages") if isinstance(record, dict) else None
    if not isinstance(pages, list) or not all(isinstance(page, str) for page in pages):
        return None
    return pages


def _cache_put(digest: str, pages: list):
    _write_json(_cache_key(digest), {"pages": pages})


def _read_json(key: str):
    """A JSON value stored in the ingest bucket, or None: missing or unreadable entries are misses, not errors."""
    bucket = _bucket()
    if not bucket:
        return None
    try:
        return json.loads(s3_client.get_object(Bucket=bucket, Key=key)["Body"].read())
    except ClientError as e:
        if _code(e) not in ("NoSuchKey", "404"):
            logger.warning("Could not read %s: %s", key, _code(e))
    except Exception as e:  # noqa: BLE001
        logger.warning("Ignoring unreadable %s: %s", key, e.__class__.__name__)
    return None


def _write_json(key: str, value) -> bool:
    bucket = _bucket()
    if not bucket:
        return False
    try:
        s3_client.put_object(
            Bucket=bucket,
            Key=key,
            Body=json.dumps(value, ensure_ascii=False).encode("utf-8"),
            ContentType="application/json",
        )
        return True
    except Exception as e:  # noqa: BLE001  (best-effort: a lost entry only means more OCR later)
        logger.warning("Could not write %s: %s", key, e.__class__.__name__)
        return False


def _delete(key: str):
    bucket = _bucket()
    if not bucket:
        return
    try:
        s3_client.delete_object(Bucket=bucket, Key=key)
    except Exception as e:  # noqa: BLE001  (the textract/ lifecycle rule removes it eventually)
        logger.warning("Could not delete %s: %s", key, e.__class__.__name__)
