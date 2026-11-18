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
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers.citations import (  # noqa: E402
    merge_cited_and_linked,
    parse_cited_indices,
    parse_cited_refs,
    select_cited_sources,
    select_linked_sources,
    stream_settled_length,
    strip_internal_links,
    strip_unverified_links,
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


class ParseCitedRefsTests(unittest.TestCase):
    def test_mixed_guide_and_library(self):
        self.assertEqual(parse_cited_refs("<cited_indices>[G1, 2]</cited_indices>"), ([1], [2]))

    def test_plain_integers_are_library(self):
        self.assertEqual(parse_cited_refs("<cited_indices>[1, 3, 1]</cited_indices>"), ([], [1, 3]))

    def test_lowercase_and_quoted_guide_labels(self):
        self.assertEqual(parse_cited_refs('<cited_indices>["g2", "G2", 4]</cited_indices>'), ([2], [4]))

    def test_empty_and_missing(self):
        self.assertEqual(parse_cited_refs("<cited_indices>[]</cited_indices>"), ([], []))
        self.assertIsNone(parse_cited_refs("<answer>x</answer>"))


LINK_SOURCES = [
    {"title": "guide", "source_type": "guideline", "url": "https://example.org/guide", "uri": "https://example.org/guide"},
    {"title": "video", "source_type": "video", "url": "https://example.org/v", "uri": "https://example.org/v"},
    {"title": "doc", "source_type": "document", "url": "", "uri": "upload://document/h.pdf"},
    {"title": "page", "source_type": "http", "url": "https://example.org/p", "uri": "https://example.org/p"},
]


class SelectLinkedSourcesTests(unittest.TestCase):
    def titles(self, text):
        return [s["title"] for s in select_linked_sources(LINK_SOURCES, text)]

    def test_link_order_and_internal_uri(self):
        text = "See [Page](https://example.org/p), then [Doc](upload://document/h.pdf) and https://example.org/v."
        self.assertEqual(self.titles(text), ["page", "doc", "video"])

    def test_guides_and_invented_urls_are_ignored(self):
        self.assertEqual(self.titles("[G](https://example.org/guide) [X](https://example.org/x)"), [])

    def test_longer_url_does_not_match_a_prefix(self):
        self.assertEqual(self.titles("Open https://example.org/video and https://example.org/p/2"), [])

    def test_empty_text(self):
        self.assertEqual(self.titles(""), [])

    def test_one_source_per_linked_value(self):
        chunks = [LINK_SOURCES[1], dict(LINK_SOURCES[1], title="video chunk 2")]
        self.assertEqual([s["title"] for s in select_linked_sources(chunks, "https://example.org/v")], ["video"])


class MergeCitedAndLinkedTests(unittest.TestCase):
    def test_cited_first_without_duplicates(self):
        video, doc, page = LINK_SOURCES[1], LINK_SOURCES[2], LINK_SOURCES[3]
        other_video_chunk = dict(video, title="video chunk 2")
        merged = merge_cited_and_linked([page], [video, page, other_video_chunk, doc])
        self.assertEqual([s["title"] for s in merged], ["page", "video", "doc"])


class StripUnverifiedLinksTests(unittest.TestCase):
    def strip(self, text):
        return strip_unverified_links(text, LINK_SOURCES)

    def test_link_to_a_retrieved_source_is_kept(self):
        text = 'See [Video](https://example.org/v), [Page](https://example.org/p "Title") and <https://example.org/p>.'
        self.assertEqual(self.strip(text), (text, 0))

    def test_invented_inline_link_keeps_its_text(self):
        self.assertEqual(self.strip("See [A page](https://example.org/made-up)."), ("See A page.", 1))
        self.assertEqual(self.strip("![Chart](http://other.org/c.png)"), ("Chart", 1))

    def test_link_text_that_is_an_invented_url_is_dropped_too(self):
        self.assertEqual(self.strip("[https://evil.org/x](https://evil.org/x) now"), (" now", 2))
        self.assertEqual(self.strip("[https://example.org/v](https://evil.org/x)"), ("https://example.org/v", 1))

    def test_reference_definition_is_removed_and_uses_keep_their_text(self):
        text = (
            "Read [the guide][1], [Other][] and [kept][2].\n\n"
            "[1]: https://evil.org/guide\n"
            '[other]: <https://evil.org/o> "Other"\n'
            "[2]: https://example.org/p"
        )
        self.assertEqual(
            self.strip(text),
            ("Read the guide, Other and [kept][2].\n\n\n\n[2]: https://example.org/p", 2),
        )

    def test_invented_autolink_is_removed(self):
        self.assertEqual(self.strip("Visit <https://evil.org/a> today."), ("Visit  today.", 1))

    def test_bare_urls(self):
        self.assertEqual(self.strip("Go to https://evil.org/a. Then (https://evil.org/b)"), ("Go to . Then ()", 2))
        self.assertEqual(self.strip("Go to https://example.org/v. Or (https://example.org/p)"),
                         ("Go to https://example.org/v. Or (https://example.org/p)", 0))
        self.assertEqual(self.strip("See **https://evil.org/x** now"), ("See **** now", 1))

    def test_longer_url_or_embedded_source_url_is_not_verified(self):
        self.assertEqual(self.strip("Open https://example.org/p/2 now"), ("Open  now", 1))
        self.assertEqual(self.strip("[X](https://evil.org/?u=https://example.org/p)"), ("X", 1))

    def test_guide_urls_are_never_verified(self):
        self.assertEqual(self.strip("See [Guide](https://example.org/guide)."), ("See Guide.", 1))

    def test_mixed_answer(self):
        text = (
            "Watch [the video](https://example.org/v), skip [this](https://made.up/x), "
            "read <https://example.org/p> and https://made.up/y.\n"
            "[Handbook](upload://document/h.pdf) stays for strip_internal_links."
        )
        cleaned, removed = self.strip(text)
        self.assertEqual(removed, 2)
        self.assertEqual(
            cleaned,
            "Watch [the video](https://example.org/v), skip this, read <https://example.org/p> and .\n"
            "[Handbook](upload://document/h.pdf) stays for strip_internal_links.",
        )
        # Every link left gets a card, and only those.
        self.assertEqual([s["title"] for s in select_linked_sources(LINK_SOURCES, cleaned)], ["video", "page", "doc"])

    def test_no_sources_removes_every_http_link(self):
        self.assertEqual(strip_unverified_links("[A](https://example.org/v) https://x.org", []), ("A ", 2))

    def test_text_without_links(self):
        self.assertEqual(self.strip(""), ("", 0))
        self.assertEqual(self.strip("No links [here]."), ("No links [here].", 0))


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
