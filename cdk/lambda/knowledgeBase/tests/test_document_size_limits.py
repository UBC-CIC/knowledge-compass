"""
Uploaded data-source files are size-checked before they are parsed: over
50 MB is refused, and a DOCX may not inflate past its memory budget (finding
f-5f6320bb). S3 is faked; no network.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_document_size_limits.py" -v
"""

import io
import sys
import types
import unittest
import zipfile
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

try:  # pragma: no cover - python-docx needs a working lxml, absent locally
    import docx  # noqa: F401
except Exception:  # noqa: BLE001
    _docx = types.ModuleType("docx")
    _docx.Document = object  # every test patches batch.DocxDocument
    sys.modules["docx"] = _docx

from helpers import process_document_batch as batch  # noqa: E402


def docx_with(parts: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return buffer.getvalue()


class ReadSourceObjectTests(unittest.TestCase):
    def _read(self, body: bytes, content_length=None):
        s3 = mock.Mock()
        response = {"Body": io.BytesIO(body)}
        if content_length is not None:
            response["ContentLength"] = content_length
        s3.get_object.return_value = response
        with mock.patch.object(batch, "MAX_SOURCE_FILE_BYTES", 1000), mock.patch.object(batch, "s3_client", s3):
            return batch._read_source_object("bucket", "key")

    def test_files_within_the_cap_are_read(self):
        self.assertEqual(self._read(b"x" * 1000), b"x" * 1000)

    def test_oversized_files_are_refused_by_header_or_by_bytes(self):
        with self.assertRaisesRegex(RuntimeError, "larger than 50 MB"):
            self._read(b"x", content_length=1001)
        with self.assertRaisesRegex(RuntimeError, "larger than 50 MB"):
            self._read(b"x" * 1001)


class DocxExpansionTests(unittest.TestCase):
    def test_a_docx_that_inflates_too_far_is_refused_before_parsing(self):
        bomb = docx_with({"word/document.xml": b"\0" * (2 * 1024 * 1024)})  # compresses to a few KB
        with mock.patch.object(batch, "MAX_DOCX_XML_PART_BYTES", 1024 * 1024), \
                mock.patch.object(batch, "DocxDocument") as parse:
            with self.assertRaisesRegex(RuntimeError, "expands to too much data"):
                batch._extract_docx_text(bomb)
        parse.assert_not_called()

    def test_total_expanded_size_is_bounded(self):
        archive = docx_with({f"word/media/image{i}.bin": b"\0" * 1024 for i in range(10)})
        with mock.patch.object(batch, "MAX_DOCX_EXPANDED_BYTES", 5 * 1024), \
                mock.patch.object(batch, "DocxDocument") as parse:
            with self.assertRaisesRegex(RuntimeError, "expands to too much data"):
                batch._extract_docx_text(archive)
        parse.assert_not_called()

    def test_a_normal_docx_is_parsed(self):
        archive = docx_with({"word/document.xml": b"<w:document/>"})
        doc = mock.Mock(paragraphs=[mock.Mock(text="Keep a dated record.")])
        with mock.patch.object(batch, "DocxDocument", return_value=doc):
            self.assertEqual(batch._extract_docx_text(archive), "Keep a dated record.")

    def test_a_file_that_is_not_a_zip_is_a_clear_error(self):
        with self.assertRaisesRegex(RuntimeError, "Could not read this DOCX"):
            batch._extract_docx_text(b"not a zip")


if __name__ == "__main__":
    unittest.main()
