"""
Unit tests for helpers/guideline_document.py (guideline-mode ingestion).
S3, Bedrock, Cohere and the DB are mocked. Run from knowledgeBase:

    python -m unittest discover -s tests -v
"""

import _setup  # noqa: F401  (must be first)

import sys
import types
import unittest
from unittest import mock

# python-docx needs the Lambda's vendored linux lxml; ingestion of guides
# never touches DOCX, so a stub keeps this test runnable on any machine.
try:  # pragma: no cover - depends on the local interpreter
    import docx  # noqa: F401
except Exception:  # noqa: BLE001
    _docx = types.ModuleType("docx")
    _docx.Document = object
    sys.modules["docx"] = _docx

from helpers import guideline_document as gd  # noqa: E402


STRUCTURED = """# Journey 1: School exclusion

Families whose child is kept out of school.

## Sent home early

### Ask first
How long has this been happening?

### How to respond
Keep a dated record of each early pickup. Ask the school for its reasons in writing.

## Reduced schedule

Short.
"""

PLAIN = " ".join(f"Sentence number {i} about inclusive education planning." for i in range(120))


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn
        self._result = []
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))
        if self.conn.fail_on and self.conn.fail_on in sql:
            raise RuntimeError("boom")
        self._result = self.conn.respond(sql, params)

    def fetchone(self):
        return self._result[0] if self._result else None

    def fetchall(self):
        return list(self._result)


class FakeConnection:
    def __init__(self, existing=None, fail_on=None):
        self.executed = []
        self.commits = 0
        self.rollbacks = 0
        self.existing = existing or []
        self.fail_on = fail_on

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def respond(self, sql, params):
        if "FROM guideline_documents WHERE id" in sql:
            return [("doc-1", "guide.md", "uploads/guideline/abc.md")]
        if "FROM guideline_sections" in sql and "SELECT id::text, section_key" in sql:
            return self.existing
        if "INSERT INTO sources" in sql:
            return [("source-1",)]
        return []

    def statuses(self):
        return [p[0] for sql, p in self.executed if "UPDATE guideline_documents" in sql]


class ParseSectionsTest(unittest.TestCase):
    def test_heading_sections_merge_deeper_headings_and_keep_short(self):
        sections = gd.parse_guideline_sections(STRUCTURED)
        keys = [s["section_key"] for s in sections]
        self.assertEqual(keys, [
            "Journey 1: School exclusion",
            "Journey 1: School exclusion > Sent home early",
            "Journey 1: School exclusion > Reduced schedule",
        ])
        sent_home = sections[1]
        self.assertIn("Ask first:", sent_home["body"])
        self.assertIn("How to respond:", sent_home["body"])
        self.assertEqual(sent_home["title"], "Sent home early")
        # One-word section survives (no minimum word count).
        self.assertEqual(sections[2]["body"], "Short.")
        self.assertEqual([s["sort_order"] for s in sections], [0, 1, 2])

    def test_documents_starting_at_level_two(self):
        text = "## A\ntext a\n### detail\nmore\n#### step\nfinal\n## B\ntext b\n"
        sections = gd.parse_guideline_sections(text)
        # "##" and "###" are the two shallowest levels; "####" stays inside.
        self.assertEqual([s["section_key"] for s in sections], ["A", "A > detail", "B"])
        self.assertIn("step:", sections[1]["body"])

    def test_headingless_windows(self):
        sections = gd.parse_guideline_sections(PLAIN)
        self.assertGreater(len(sections), 1)
        self.assertTrue(all(s["section_key"].startswith("window-") for s in sections))
        self.assertTrue(all(len(s["body"].split()) <= gd._WINDOW_WORDS for s in sections))
        self.assertEqual(sections[0]["heading_path"], "")

    def test_content_hash_changes_with_body(self):
        a = gd.parse_guideline_sections("# A\none")[0]["content_hash"]
        b = gd.parse_guideline_sections("# A\ntwo")[0]["content_hash"]
        self.assertNotEqual(a, b)


class LabelTest(unittest.TestCase):
    def test_parses_model_json(self):
        client = mock.Mock()
        client.converse.return_value = {"output": {"message": {"content": [
            {"text": '{"situation_label": "Child sent home early from school", "summary": "When a child is picked up early."}'}
        ]}}}
        with mock.patch.object(gd, "_get_llm_client", return_value=client), \
             mock.patch.object(gd, "_get_haiku_model_id", return_value="haiku"):
            result = gd.label_section({"body": "text", "heading_path": "A > B", "title": "B"})
        self.assertEqual(result["situation_label"], "Child sent home early from school")

    def test_long_label_is_truncated(self):
        result = gd._parse_label_json('{"situation_label": "one two three four five six seven eight nine ten", "summary": ""}')
        self.assertEqual(len(result["situation_label"].split()), gd._LABEL_MAX_WORDS)

    def test_fallback_uses_heading_then_first_sentence(self):
        with mock.patch.object(gd, "_get_llm_client", side_effect=RuntimeError("no bedrock")):
            by_heading = gd.label_section({"body": "Body text.", "heading_path": "J > Sent home", "title": "Sent home"})
            by_sentence = gd.label_section({"body": "Families often ask this. More text.", "heading_path": "", "title": ""})
        self.assertEqual(by_heading["situation_label"], "Sent home")
        self.assertEqual(by_sentence["situation_label"], "Families often ask this.")

    def test_reuses_unchanged_labels_and_keeps_overrides(self):
        sections = gd.parse_guideline_sections(STRUCTURED)
        existing = {
            sections[1]["section_key"]: {
                "content_hash": sections[1]["content_hash"],
                "auto_label": "Stored label", "summary": "Stored", "label_override": "Admin name",
            },
            sections[2]["section_key"]: {
                "content_hash": "changed", "auto_label": "Old", "summary": "", "label_override": "Kept",
            },
        }
        with mock.patch.object(gd, "label_section", return_value={"situation_label": "New", "summary": "S"}) as label:
            gd.label_sections(sections, existing)
        self.assertEqual(label.call_count, 2)  # section 0 (new) and section 2 (changed)
        self.assertEqual(sections[1]["auto_label"], "Stored label")
        self.assertEqual(sections[1]["label_override"], "Admin name")
        self.assertEqual(sections[2]["auto_label"], "New")
        self.assertEqual(sections[2]["label_override"], "Kept")
        self.assertEqual(gd.effective_label(sections[2]), "Kept")


class BuildChunksTest(unittest.TestCase):
    def test_embed_text_and_metadata(self):
        sections = gd.parse_guideline_sections(STRUCTURED)
        for s in sections:
            s.update(auto_label=f"Label {s['sort_order']}", summary="Summary.", label_override=None)
        chunks = gd.build_chunks(sections)
        self.assertEqual([c["chunk_index"] for c in chunks], list(range(len(chunks))))
        first = chunks[1]
        self.assertTrue(first["text"].startswith("Label 1\nSummary.\nJourney 1: School exclusion > Sent home early\n\n"))
        self.assertEqual(first["metadata"]["section_key"], sections[1]["section_key"])
        self.assertEqual(first["metadata"]["situation_label"], "Label 1")


class ProcessDocumentTest(unittest.TestCase):
    def _run(self, conn, text):
        with mock.patch.object(gd, "_read_guide_text", return_value=text), \
             mock.patch.object(gd, "label_section", return_value={"situation_label": "L", "summary": "S"}), \
             mock.patch.object(gd, "write_chunks", return_value={"written": 3, "embedded": 3, "deleted": 0}) as wc:
            result = gd.process_guideline_document({"document_id": "doc-1"}, conn)
        return result, wc

    def test_ready_path(self):
        conn = FakeConnection()
        result, wc = self._run(conn, STRUCTURED)
        self.assertEqual(result["status"], "ready")
        self.assertEqual(conn.statuses(), ["ready"])
        self.assertEqual(conn.commits, 1)
        source_sql = [p for sql, p in conn.executed if "INSERT INTO sources" in sql][0]
        self.assertEqual(source_sql[1], "guideline://doc/doc-1")
        self.assertIn('"retrieval_hidden": "true"', source_sql[2])
        self.assertIn('"kb_role": "guideline"', source_sql[2])
        self.assertEqual(wc.call_args[0][1], "source-1")
        # Upserts never overwrite label_override.
        upserts = [sql for sql, _ in conn.executed if "INSERT INTO guideline_sections" in sql]
        self.assertTrue(upserts)
        self.assertNotIn("label_override", upserts[0])

    def test_empty_file_fails_with_plain_message(self):
        conn = FakeConnection()
        result, _ = self._run(conn, "   \n")
        self.assertEqual(result["status"], "failed")
        error_params = [p for sql, p in conn.executed if "UPDATE guideline_documents" in sql][-1]
        self.assertEqual(error_params[0], "failed")
        self.assertIn("empty", error_params[1])
        self.assertEqual(conn.rollbacks, 1)

    def test_unexpected_error_fails_with_generic_message(self):
        conn = FakeConnection(fail_on="INSERT INTO sources")
        result, _ = self._run(conn, STRUCTURED)
        self.assertEqual(result["status"], "failed")
        error_params = [p for sql, p in conn.executed if "UPDATE guideline_documents" in sql][-1]
        self.assertIn("try uploading it again", error_params[1])

    def test_missing_document_id(self):
        self.assertIn("error", gd.process_guideline_document({}, FakeConnection()))


if __name__ == "__main__":
    unittest.main()
