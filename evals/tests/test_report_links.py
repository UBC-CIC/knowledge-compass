import unittest

from evals import report


def source_lines(*sources):
    return [l for l in report._assistant_block({"sources": list(sources)}) if l.startswith("- ")]


class TranscriptSourceLinkTests(unittest.TestCase):
    def test_http_source_is_a_link(self):
        self.assertEqual(
            source_lines({"title": "IEP guide", "url": "https://example.org/iep"}),
            ["- [IEP guide](https://example.org/iep)"],
        )

    def test_title_markdown_and_html_are_escaped(self):
        [line] = source_lines({"title": "x](javascript:alert(1)) <img src=x onerror=alert(1)> `c`",
                               "url": "https://example.org/a"})
        self.assertNotIn("<img", line)
        self.assertIn("&lt;img", line)
        self.assertIn("x\\](javascript", line)
        self.assertIn("\\`c\\`", line)
        self.assertTrue(line.endswith("(https://example.org/a)"))

    def test_non_http_schemes_are_not_linked(self):
        for url in ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
                    "s3://bucket/key", "//evil.example/x", "https:///nohost"]:
            for title in ["Doc", None]:
                [line] = source_lines({"title": title, "url": url})
                self.assertNotIn("](", line, url)
                self.assertNotIn("<script", line, url)

    def test_url_cannot_break_out_of_the_link(self):
        [line] = source_lines({"title": "t", "url": "https://example.org/a) <b>x</b> [y](z"})
        self.assertNotIn("<b>", line)
        self.assertEqual(line.count("("), 1)
        self.assertEqual(line.count(")"), 1)
        self.assertTrue(line.startswith("- [t](https://example.org/a%29%20%3Cb%3Ex"))

    def test_missing_url_keeps_plain_title(self):
        self.assertEqual(source_lines({"title": "Handbook"}), ["- Handbook"])
        self.assertEqual(source_lines({}), ["- untitled"])


if __name__ == "__main__":
    unittest.main()
