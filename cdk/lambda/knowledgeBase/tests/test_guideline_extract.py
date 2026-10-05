"""
Unit tests for helpers/guideline_extract.py (Markdown/Word/PDF guide text).
python-docx objects are replaced with simple stand-ins (the vendored lxml is
linux-only) and extract_pdf is mocked. Run from knowledgeBase:

    python -m unittest discover -s tests -v
"""

import _setup  # noqa: F401  (must be first)

import unittest
from types import SimpleNamespace
from unittest import mock

from helpers import guideline_document as gd  # noqa: E402
from helpers import guideline_extract as ge  # noqa: E402
from helpers.pdf_text import PdfText  # noqa: E402

BODY = "Keep a dated record of each early pickup and ask the school to share its reasons in writing."


def para(text, style="Normal", numbered=False):
    p = SimpleNamespace(text=text, style=SimpleNamespace(name=style))
    p._p = SimpleNamespace(pPr=SimpleNamespace(numPr=object() if numbered else None))
    return p


def table(rows):
    return SimpleNamespace(rows=[SimpleNamespace(cells=[SimpleNamespace(text=c) for c in r]) for r in rows])


class FileKindTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(ge.file_kind("a.MD"), "markdown")
        self.assertEqual(ge.file_kind("a.markdown"), "markdown")
        self.assertEqual(ge.file_kind("a.docx"), "docx")
        self.assertEqual(ge.file_kind("a.PDF"), "pdf")
        self.assertIsNone(ge.file_kind("a.doc"))


class WordTest(unittest.TestCase):
    def test_styles_become_markdown_in_order(self):
        text = ge.blocks_to_markdown([
            para("Family guide", "Title"),
            para("School exclusion", "Heading 1"),
            para("Sent home early", "Heading 2"),
            para(BODY),
            para("Ask how long it has been happening", "List Bullet"),
            para("Write down each date", numbered=True),
            table([["Step", "What to say"], ["1", "Please put it in writing"], ["1", "1"]]),
            para("   "),
        ])
        self.assertEqual(text.split("\n\n"), [
            "# Family guide",
            "# School exclusion",
            "## Sent home early",
            BODY,
            "- Ask how long it has been happening",
            "- Write down each date",
            "Step | What to say",
            "1 | Please put it in writing",
            "1",
        ])
        sections = gd.parse_guideline_sections(text)
        self.assertIn("School exclusion > Sent home early", [s["section_key"] for s in sections])

    def test_unstyled_word_infers_headings(self):
        blocks = [para("Sent home early"), para(BODY), para("Reduced school day"), para(BODY)]
        with mock.patch.object(ge, "docx_to_markdown", return_value=ge.blocks_to_markdown(blocks)):
            text, summary = ge.extract_guide_text("guide.docx", b"x")
        self.assertFalse(summary["heading_styles"])
        self.assertIn("## Sent home early", text)
        self.assertIn("## Reduced school day", text)

    def test_broken_word_file_has_plain_error(self):
        with self.assertRaises(ge.ExtractionError) as ctx:
            ge.docx_to_markdown(b"not a zip")
        self.assertIn("Word file", str(ctx.exception))


class HeadingInferenceTest(unittest.TestCase):
    def test_marks_short_lines_before_paragraphs(self):
        text = f"Sent home early\n\n{BODY}\n\nReduced school day\n\n{BODY}"
        out = ge.infer_headings(text)
        self.assertTrue(out.startswith("## Sent home early\n\n"))
        self.assertIn("\n\n## Reduced school day\n\n", out)

    def test_needs_at_least_two_headings(self):
        text = f"Only one heading\n\n{BODY}"
        self.assertEqual(ge.infer_headings(text), text)

    def test_ignores_sentences_bullets_and_short_followers(self):
        text = (
            f"This is a sentence.\n\n{BODY}\n\n- bullet item\n\n{BODY}\n\n"
            f"Heading A\n\nToo short.\n\nHeading B\n\n{BODY}"
        )
        out = ge.infer_headings(text)
        self.assertNotIn("## This is a sentence.", out)
        self.assertNotIn("## - bullet", out)
        self.assertNotIn("## Heading A", out)


class PdfTest(unittest.TestCase):
    def test_pdf_text_with_inferred_headings(self):
        pdf = PdfText(pages=[f"Sent home early\n\n{BODY}", f"Reduced school day\n\n{BODY}"], engine="textract")
        with mock.patch.object(ge, "extract_pdf", return_value=pdf) as extract:
            text, summary = ge.extract_guide_text(
                "uploads/guideline/x.pdf", b"%PDF", s3_object={"Bucket": "b", "Name": "k"}, time_left=lambda: 500,
            )
        self.assertEqual(extract.call_args.kwargs["allow_pending"], False)
        self.assertEqual(extract.call_args.kwargs["s3_object"], {"Bucket": "b", "Name": "k"})
        self.assertEqual(summary["format"], "pdf")
        self.assertNotIn(BODY, str(summary))  # summary never carries text
        keys = [s["section_key"] for s in gd.parse_guideline_sections(text)]
        self.assertEqual(keys, ["Sent home early", "Reduced school day"])

    def test_empty_pdf_has_plain_error(self):
        with mock.patch.object(ge, "extract_pdf", return_value=PdfText(pages=[""], engine="textract")):
            with self.assertRaises(ge.ExtractionError) as ctx:
                ge.extract_guide_text("x.pdf", b"%PDF")
        self.assertIn("couldn't find any text in this PDF", str(ctx.exception))


class MarkdownTest(unittest.TestCase):
    def test_markdown_unchanged(self):
        text, summary = ge.extract_guide_text("x.md", "# A\nbody".encode("utf-8-sig"))
        self.assertEqual(text, "# A\nbody")
        self.assertEqual(summary, {"format": "markdown"})

    def test_binary_markdown_rejected(self):
        with self.assertRaises(ge.ExtractionError):
            ge.extract_guide_text("x.md", b"\xff\xfe\x00bad\x80")

    def test_unsupported(self):
        with self.assertRaises(ge.ExtractionError):
            ge.extract_guide_text("x.doc", b"")


class WorkerReadTest(unittest.TestCase):
    def test_uses_stored_key_extension_and_maps_errors(self):
        s3 = mock.Mock()
        s3.get_object.return_value = {"Body": mock.Mock(read=mock.Mock(return_value=b"%PDF"))}
        with mock.patch.dict("os.environ", {"KNOWLEDGE_BASE_BUCKET_NAME": "bucket"}), \
             mock.patch.object(gd, "s3_client", s3), \
             mock.patch.object(gd, "extract_guide_text", side_effect=ge.ExtractionError("plain message")) as extract:
            with self.assertRaises(gd.GuidelineError) as ctx:
                gd._read_guide_text("Display name", "uploads/guideline/a.pdf")
        self.assertEqual(str(ctx.exception), "plain message")
        self.assertEqual(extract.call_args.args[0], "uploads/guideline/a.pdf")


if __name__ == "__main__":
    unittest.main()
