"""
Finding f-50122d26: the journey-guide candidate query must bind each value to
the placeholder that expects it, and a retrieval failure must not read as
"no guidance applies". The fake cursor below binds parameters the way
psycopg2 does (positional %s in text order, or named %(name)s from a dict)
and checks each value against its cast. Run from textGeneration:

    python -m unittest discover -s tests -p "test_*.py"
"""

import logging
import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.dirname(__file__))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers import chat  # noqa: E402
from helpers import guideline_retrieval as gr  # noqa: E402
from test_chat_guideline_mode import ChatModeTestBase  # noqa: E402
from test_guideline_retrieval import CHUNKS, SPACE  # noqa: E402

DOC_IDS = ["0b6f5f8e-1c1d-4d7a-9d3e-2a1b0c9d8e7f", "5c3b2a19-0d8e-4f7a-b6c5-4e3d2c1b0a99"]
QUERY = "my child keeps getting sent home early"
_PLACEHOLDER_RE = re.compile(r"%\((\w+)\)s|%s")


def bind(sql, params):
    """[(value, text after the placeholder)] in text order, as psycopg2 binds them."""
    bound = []
    positional = iter(params) if isinstance(params, (tuple, list)) else None
    for match in _PLACEHOLDER_RE.finditer(sql):
        if match.group(1):
            if not isinstance(params, dict):
                raise TypeError("named placeholder needs a dict")
            value = params[match.group(1)]  # KeyError, like psycopg2
        else:
            if positional is None:
                raise TypeError("positional placeholder needs a sequence")
            value = next(positional)
        bound.append((value, sql[match.end():match.end() + 12]))
    if positional is not None and next(positional, None) is not None:
        raise TypeError("not all arguments converted")
    return bound


def check_types(sql, params):
    """Raise like Postgres would when a value does not fit its cast."""
    for value, after in bind(sql, params):
        if after.startswith("::uuid[]"):
            if not (isinstance(value, list) and all(isinstance(v, str) for v in value)):
                raise ValueError("malformed array literal")
        elif after.startswith("::vector"):
            if not (isinstance(value, str) and value.startswith("[")):
                raise ValueError("invalid input syntax for type vector")


class BindingCursor:
    def __init__(self, conn):
        self.conn = conn
        self._rows = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params))
        check_types(sql, params)
        if "WITH g AS MATERIALIZED" in sql:
            self._rows = [("d1", "Sent home", 0.9)]
        else:
            docs, keys = params
            self._rows = [r for r in CHUNKS if r[0] in docs and r[1] in keys]

    def fetchall(self):
        return list(self._rows)


class BindingConnection:
    def __init__(self):
        self.executed = []
        self.rollbacks = 0

    def cursor(self):
        return BindingCursor(self)

    def rollback(self):
        self.rollbacks += 1


def run(conn, **kwargs):
    with mock.patch.object(gr, "get_active_space", return_value=SPACE), \
            mock.patch.object(gr, "embed_query", return_value=[0.1, 0.2]):
        return gr.retrieve_guideline_sections(QUERY, conn, "us-east-1", **kwargs)


class CandidateBindingTest(unittest.TestCase):
    def test_restricted_query_binds_document_ids_to_the_uuid_array(self):
        conn = BindingConnection()
        results = run(conn, document_ids=DOC_IDS)
        self.assertEqual([r["metadata"]["section_key"] for r in results], ["Sent home"])
        sql, params = conn.executed[0]
        bound = bind(sql, params)
        self.assertEqual(len(bound), 4)
        self.assertTrue(bound[0][1].startswith("::uuid[]"))
        self.assertEqual(bound[0][0], DOC_IDS)
        for value, after in bound[1:3]:
            self.assertTrue(after.startswith("::vector"))
            self.assertEqual(value, "[0.1,0.2]")
        self.assertEqual(bound[3][0], gr.CANDIDATE_LIMIT)

    def test_unrestricted_query_binds_the_vector_and_limit(self):
        conn = BindingConnection()
        results = run(conn)
        self.assertEqual(len(results), 1)
        sql, params = conn.executed[0]
        self.assertNotIn("uuid[]", sql)
        self.assertEqual([v for v, _ in bind(sql, params)], ["[0.1,0.2]", "[0.1,0.2]", gr.CANDIDATE_LIMIT])

    def test_candidate_sql_uses_named_placeholders_only(self):
        for restricted in (False, True):
            sql = gr.build_candidate_sql(SPACE, restrict_documents=restricted)
            self.assertNotIn("%s", sql)
            names = set(re.findall(r"%\((\w+)\)s", sql))
            params = gr.candidate_params("[0]", DOC_IDS if restricted else None)
            self.assertEqual(names, set(params))


class FailClosedTest(unittest.TestCase):
    def test_query_failure_raises_logs_the_class_only_and_rolls_back(self):
        conn = BindingConnection()
        conn.cursor = mock.Mock(side_effect=RuntimeError(f"syntax error near {QUERY}"))
        with self.assertLogs(gr.logger, level=logging.ERROR) as logs, \
                self.assertRaises(gr.GuidelineRetrievalError) as raised:
            run(conn, document_ids=DOC_IDS)
        output = "\n".join(logs.output)
        self.assertIn("RuntimeError", output)
        self.assertNotIn(QUERY, output)
        self.assertNotIn(QUERY, str(raised.exception))
        self.assertEqual(conn.rollbacks, 1)

    def test_embedding_failure_raises(self):
        conn = BindingConnection()
        with mock.patch.object(gr, "get_active_space", return_value=SPACE), \
                mock.patch.object(gr, "embed_query", side_effect=RuntimeError(QUERY)), \
                self.assertLogs(gr.logger, level=logging.ERROR) as logs, \
                self.assertRaises(gr.GuidelineRetrievalError):
            gr.retrieve_guideline_sections(QUERY, conn, "us-east-1", document_ids=DOC_IDS)
        self.assertNotIn(QUERY, "\n".join(logs.output))
        self.assertEqual(conn.executed, [])

    def test_no_match_is_still_an_empty_list(self):
        conn = BindingConnection()
        with mock.patch.object(BindingCursor, "fetchall", return_value=[]):
            self.assertEqual(run(conn, document_ids=DOC_IDS), [])


class ChatFailClosedTest(ChatModeTestBase):
    """A covered journey whose guides cannot be read gets no answer at all.
    The real retrieve_guideline_sections runs; only its embedding call and
    the DB (FakeConnection has no cursor) fail."""
    use_journey_documents = True

    def assert_not_answered(self, **embed):
        with mock.patch.object(chat, "retrieve_guideline_sections", gr.retrieve_guideline_sections), \
                mock.patch.object(gr, "get_active_space", return_value=SPACE), \
                mock.patch.object(gr, "embed_query", **embed), \
                self.assertLogs(level=logging.ERROR) as logs:
            result, streamed = self.respond("standard")
        self.bedrock.converse_stream.assert_not_called()
        self.assertEqual(result["response"], "An error occurred.")
        self.assertEqual(result["sources_used"], [])
        self.assertEqual(streamed, "")
        self.patches["save_routing_state"].assert_not_called()
        self.patches["save_guide_state"].assert_not_called()
        self.assertNotIn("sent home early", "\n".join(logs.output))

    def test_embedding_failure_is_not_answered_from_the_library(self):
        self.assert_not_answered(side_effect=RuntimeError("bedrock down"))

    def test_query_failure_is_not_answered_from_the_library(self):
        self.assert_not_answered(return_value=[0.1, 0.2])


if __name__ == "__main__":
    unittest.main()
