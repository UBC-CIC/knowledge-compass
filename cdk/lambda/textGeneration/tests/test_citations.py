"""
Tests for helpers/citations.py: tolerant <cited_indices> parsing, source
selection, and stripping of internal-scheme markdown links.

Run from the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers.citations import (  # noqa: E402
    parse_cited_indices,
    select_cited_sources,
    strip_internal_links,
)


class ParseCitedIndicesTests(unittest.TestCase):
    def test_well_formed_array(self):
        self.assertEqual(parse_cited_indices("<answer>x</answer><cited_indices>[1, 3]</cited_indices>"), [1, 3])

    def test_trailing_comma_keeps_valid_indices(self):
        self.assertEqual(parse_cited_indices("<cited_indices>[1, 3,]</cited_indices>"), [1, 3])

    def test_quoted_and_unbracketed_values(self):
        self.assertEqual(parse_cited_indices('<cited_indices>"2", 4</cited_indices>'), [2, 4])

    def test_duplicates_removed_in_order(self):
        self.assertEqual(parse_cited_indices("<cited_indices>[3, 1, 3]</cited_indices>"), [3, 1])

    def test_empty_array(self):
        self.assertEqual(parse_cited_indices("<cited_indices>[]</cited_indices>"), [])

    def test_missing_block_returns_none(self):
        self.assertIsNone(parse_cited_indices("<answer>no citations</answer>"))
        self.assertIsNone(parse_cited_indices(""))

    def test_multiline_block(self):
        self.assertEqual(parse_cited_indices("<cited_indices>\n[\n 1,\n 2\n]\n</cited_indices>"), [1, 2])


class SelectCitedSourcesTests(unittest.TestCase):
    def test_selects_in_retrieval_order_and_ignores_out_of_range(self):
        sources = [{"title": "a"}, {"title": "b"}, {"title": "c"}]
        selected = select_cited_sources(sources, [3, 1, 0, 9])
        self.assertEqual([s["title"] for s in selected], ["a", "c"])


class StripInternalLinksTests(unittest.TestCase):
    def test_internal_links_become_plain_text(self):
        text = "See [Handbook](s3://bucket/uploads/h.pdf) and [Guide](upload://document/guide.pdf)."
        self.assertEqual(strip_internal_links(text), "See Handbook and Guide.")

    def test_http_links_are_kept(self):
        text = "See [Site](https://example.org/page) and [Old](http://example.org)."
        self.assertEqual(strip_internal_links(text), text)

    def test_empty_text(self):
        self.assertEqual(strip_internal_links(""), "")


if __name__ == "__main__":
    unittest.main()
