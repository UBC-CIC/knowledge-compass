"""Focused prompt-context tests for discrete CSV row resources."""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers.bedrock import format_context_for_prompt  # noqa: E402


class CsvRowContextTests(unittest.TestCase):
    def test_exact_retrieved_row_is_rendered_with_its_citation_and_columns(self):
        context = format_context_for_prompt([
            {
                "title": "Family planning guide",
                "url": "https://public.example/guide",
                "source_type": "csv_row",
                "content": "Description first. Fetched guidance follows.",
                "metadata": {
                    "csv_row": {
                        "description": "A guide selected for families in BC.",
                        "columns": {"Title": "Family planning guide", "Province": "BC"},
                    }
                },
            }
        ])

        self.assertIn("[1] Family planning guide", context)
        self.assertIn("URL: https://public.example/guide", context)
        self.assertIn("Type: csv_row", context)
        self.assertIn("Resource description: A guide selected for families in BC.", context)
        self.assertIn("CSV row: Title: Family planning guide, Province: BC", context)
        self.assertIn("Content: Description first. Fetched guidance follows.", context)

    def test_row_without_public_url_does_not_emit_url_line(self):
        context = format_context_for_prompt([
            {
                "title": "Non-clickable row",
                "url": "",
                "source_type": "csv_row",
                "content": "Short searchable row text.",
                "metadata": {"csv_row": {"columns": {"Title": "Non-clickable row"}}},
            }
        ])

        self.assertNotIn("URL:", context)
        self.assertIn("Non-clickable row", context)


if __name__ == "__main__":
    unittest.main()
