"""
Text extraction for guideline-mode uploads (Markdown, Word, PDF).

Every format is turned into Markdown-style text so the same section parser
(guideline_document.parse_guideline_sections) handles all of them:

  .md / .markdown  used as-is.
  .docx            read with python-docx (MIT, already vendored for document
                   ingestion). Word heading styles ("Title", "Heading 1"...)
                   become "#" headings, list paragraphs become "- " items and
                   tables become "cell | cell" rows, in document order.
  .pdf             read with the existing helpers/pdf_text.extract_pdf
                   (Amazon Textract layout analysis, pypdf fallback; pypdf is
                   BSD-3-Clause). PDFs carry no heading markup, so headings are
                   inferred from short standalone lines (infer_headings).

Word files written without heading styles (bold lines instead) get the same
inference. When too few headings are found the text is left alone and the
section parser falls back to ~300-word passages.

No new third-party dependencies. Never logs document text.
"""

import io
import logging
import re

from helpers.pdf_text import extract_pdf

logger = logging.getLogger()
logger.setLevel(logging.INFO)

MARKDOWN_EXTENSIONS = (".md", ".markdown")
DOCX_EXTENSIONS = (".docx",)
PDF_EXTENSIONS = (".pdf",)
SUPPORTED_EXTENSIONS = MARKDOWN_EXTENSIONS + DOCX_EXTENSIONS + PDF_EXTENSIONS

_HEADING_LINE_RE = re.compile(r"^#{1,6}\s+\S", re.MULTILINE)
_HEADING_STYLE_RE = re.compile(r"^heading\s*([1-6])$", re.IGNORECASE)
_BULLET_RE = re.compile(r"^\s*([-*\u2022\u25aa\u25cf\u2013]|\(?[a-z]\)|\d+\))\s+")
_HEADING_MAX_WORDS = 12
_HEADING_MAX_CHARS = 90
_HEADING_MIN_FOLLOWING_WORDS = 12
_MIN_INFERRED_HEADINGS = 2


class ExtractionError(Exception):
    """Message is safe and useful to show to an admin."""


def file_kind(name: str) -> str | None:
    lower = (name or "").lower()
    if lower.endswith(MARKDOWN_EXTENSIONS):
        return "markdown"
    if lower.endswith(DOCX_EXTENSIONS):
        return "docx"
    if lower.endswith(PDF_EXTENSIONS):
        return "pdf"
    return None


# ── Heading inference (PDF, unstyled Word) ───────────────────────────────────

def _looks_like_heading(paragraph: str) -> bool:
    if "\n" in paragraph:
        return False
    text = paragraph.strip()
    if not text or len(text) > _HEADING_MAX_CHARS:
        return False
    if len(text.split()) > _HEADING_MAX_WORDS:
        return False
    if _BULLET_RE.match(text):
        return False
    if text[-1] in ".,;:!\u201d\"')]":
        return False
    return any(ch.isalpha() for ch in text)


def infer_headings(text: str) -> str:
    """
    Mark short standalone lines that introduce a longer paragraph as "## "
    headings. Returns the text unchanged when fewer than
    _MIN_INFERRED_HEADINGS are found (the parser then uses passages).
    """
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    marks = []
    for i, paragraph in enumerate(paragraphs):
        following = paragraphs[i + 1] if i + 1 < len(paragraphs) else ""
        marks.append(
            _looks_like_heading(paragraph)
            and not _looks_like_heading(following)
            and len(following.split()) >= _HEADING_MIN_FOLLOWING_WORDS
        )
    if sum(marks) < _MIN_INFERRED_HEADINGS:
        return text
    return "\n\n".join(f"## {p}" if mark else p for p, mark in zip(paragraphs, marks))


# ── Word ──────────────────────────────────────────────────────────────────────

def _style_name(paragraph) -> str:
    try:
        return (paragraph.style.name or "").strip()
    except Exception:  # noqa: BLE001 - missing or broken style part
        return ""


def _is_list_paragraph(paragraph, style: str) -> bool:
    if "list" in style.lower():
        return True
    try:
        ppr = paragraph._p.pPr  # noqa: SLF001 - python-docx has no public numbering API
        return ppr is not None and ppr.numPr is not None
    except Exception:  # noqa: BLE001
        return False


def blocks_to_markdown(blocks) -> str:
    """
    Markdown-style text for python-docx Paragraph/Table objects in document
    order (Document.iter_inner_content()). Duck-typed so tests can pass simple
    stand-ins: tables expose .rows[].cells[].text, paragraphs .text and .style.
    """
    out = []
    for block in blocks:
        if hasattr(block, "rows"):
            for row in block.rows:
                cells = []
                for cell in row.cells:
                    value = re.sub(r"\s+", " ", cell.text or "").strip()
                    if value and (not cells or cells[-1] != value):  # merged cells repeat
                        cells.append(value)
                if cells:
                    out.append(" | ".join(cells))
            continue

        text = re.sub(r"[ \t]+", " ", (block.text or "")).strip()
        if not text:
            continue
        style = _style_name(block)
        heading = _HEADING_STYLE_RE.match(style)
        if style.lower() == "title":
            out.append(f"# {text}")
        elif heading:
            out.append(f"{'#' * int(heading.group(1))} {text}")
        elif _is_list_paragraph(block, style):
            out.append(f"- {text}")
        else:
            out.append(text)
    return "\n\n".join(out)


def docx_to_markdown(raw_bytes: bytes) -> str:
    try:
        from docx import Document  # vendored python-docx (MIT)

        document = Document(io.BytesIO(raw_bytes))
        return blocks_to_markdown(document.iter_inner_content())
    except Exception as e:  # noqa: BLE001
        logger.warning("Guideline Word file could not be opened: %s", type(e).__name__)
        raise ExtractionError(
            "We couldn't open this Word file. Please check it opens in Word, save it as .docx and upload it again."
        )


# ── Entry point ───────────────────────────────────────────────────────────────

def extract_guide_text(file_name: str, raw_bytes: bytes, *, s3_object=None, time_left=None) -> tuple:
    """
    (markdown_text, summary) for an uploaded guide. summary describes how the
    file was read (no document text) and is safe to log.
    """
    kind = file_kind(file_name)
    if kind == "markdown":
        try:
            return raw_bytes.decode("utf-8-sig"), {"format": "markdown"}
        except UnicodeDecodeError:
            raise ExtractionError(
                "This file isn't plain text. Please save it as a Markdown (.md) file and upload it again."
            )

    if kind == "docx":
        text = docx_to_markdown(raw_bytes)
        styled = bool(_HEADING_LINE_RE.search(text))
        if not styled:
            text = infer_headings(text)
        return text, {"format": "docx", "heading_styles": styled}

    if kind == "pdf":
        # allow_pending=False: if OCR outlives this invocation, extract_pdf
        # settles for the PDF's embedded text instead of deferring.
        pdf = extract_pdf(raw_bytes, s3_object=s3_object, time_left=time_left, allow_pending=False)
        text = pdf.text
        if not text.strip():
            raise ExtractionError(
                f"We couldn't find any text in this PDF ({pdf.empty_reason()}). "
                "If it is a scan, try exporting it from the original document instead."
            )
        return infer_headings(text), {"format": "pdf", **pdf.summary()}

    raise ExtractionError("Please upload a Markdown (.md), Word (.docx) or PDF (.pdf) file.")
