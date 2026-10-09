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
    stream_settled_length,
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

    def test_bare_uris_are_removed(self):
        text = "Stored at s3://ingest-bucket/uploads/h.pdf and csvlink://row/12.\nAlso (upload://doc.pdf)."
        self.assertEqual(strip_internal_links(text), "Stored at  and \nAlso ().")

    def test_autolinks_and_reference_definitions_are_removed(self):
        text = "See <s3://bucket/key> now.\n[1]: upload://doc.pdf\n  [2]: <csvlink://row/3>\n[3]: https://example.org/"
        self.assertEqual(strip_internal_links(text), "See  now.\n\n\n[3]: https://example.org/")

    def test_http_urls_survive_and_nested_internal_uris_do_not(self):
        self.assertEqual(strip_internal_links("Open https://example.org/a_b today."), "Open https://example.org/a_b today.")
        self.assertEqual(
            strip_internal_links("Open https://example.org/view?src=s3://bucket/key today."),
            "Open https://example.org/view?src= today.",
        )

    def test_whole_key_is_removed_even_inside_emphasis(self):
        self.assertEqual(strip_internal_links("See **s3://bucket/my_file.pdf** now"), "See ** now")
        self.assertEqual(strip_internal_links("| upload://a_b/c | x |"), "|  | x |")

    def test_no_internal_uri_survives(self):
        for text in ("x s3://a/b", "[t](upload://a)", "<csvlink://a>", "[r]: s3://a", "'s3://a'", "`upload://a`",
                     "**s3://a/b**", "_upload://a_", ",s3://a", "-csvlink://a", ">s3://a", "|s3://a|", "=s3://a"):
            with self.subTest(text=text):
                self.assertNotRegex(strip_internal_links(text), r"(s3|upload|csvlink)://")


class StreamSettledLengthTests(unittest.TestCase):
    def stream(self, text, step):
        """Simulate chat.py streaming `text` in `step`-sized deltas; return what the client saw."""
        sent = ""
        for end in range(step, len(text) + step, step):
            partial = text[:end]
            visible = strip_internal_links(partial[:stream_settled_length(partial)])
            if len(visible) > len(sent) and visible.startswith(sent):
                sent = visible
        return sent

    def test_trailing_word_is_held(self):
        self.assertEqual(stream_settled_length("Hello wor"), len("Hello "))
        self.assertEqual(stream_settled_length("Hello world "), len("Hello world "))
        self.assertEqual(stream_settled_length("s3:/"), 0)

    def test_unclosed_link_and_autolink_are_held(self):
        self.assertEqual(stream_settled_length("See [Hand book](s3://b "), len("See "))
        self.assertEqual(stream_settled_length("See [1]: "), len("See "))
        self.assertEqual(stream_settled_length("See <s3://b "), len("See <s3://b "))  # whitespace: not an autolink
        self.assertEqual(stream_settled_length("See [note] and "), len("See [note] and "))

    def test_split_uris_never_reach_the_client(self):
        text = ("Read [the Hand book](s3://bucket/uploads/h.pdf) first, then s3://bucket/k2 and "
                "<upload://doc.pdf> plus\n[1]: csvlink://row/3\nand [Site](https://example.org/a) done. ")
        for step in range(1, 12):
            with self.subTest(step=step):
                sent = self.stream(text, step)
                self.assertNotRegex(sent, r"(s3|upload|csvlink)://")
                self.assertTrue(strip_internal_links(text).startswith(sent))
                self.assertIn("[Site](https://example.org/a) done.", sent)


if __name__ == "__main__":
    unittest.main()
