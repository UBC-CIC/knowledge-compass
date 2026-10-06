"""
Unit tests for helpers/html_extract.py.

Run from the knowledgeBase dir:

    pytest tests
"""

import unittest

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers.html_extract import extract_html  # noqa: E402
from helpers.process_document_batch import _chunk_markdown  # noqa: E402

LOREM = " ".join(["Inclusive education supports every learner in the classroom."] * 6)

PAGE = f"""<!doctype html>
<html><head><title>Family Rights | Example Org</title>
<style>.x {{ color: red }}</style><script>var tracking = "do not index";</script></head>
<body>
  <header><nav><a href="/">Home</a> <a href="/about">About us menu</a></nav></header>
  <main>
    <article>
      <header><h1>Family Rights Guide</h1></header>
      <p>{LOREM}</p>
      <h2>School Meetings</h2>
      <p>{LOREM}</p>
      <ul><li>Bring notes</li><li>Ask questions</li></ul>
      <table><tr><th>Step</th><th>Who</th></tr><tr><td>Request</td><td>Parent</td></tr></table>
      <div hidden>secret hidden text</div>
    </article>
  </main>
  <aside>Related links sidebar</aside>
  <footer>Copyright footer text</footer>
</body></html>"""


class ExtractHtmlTests(unittest.TestCase):
    def test_keeps_main_content_and_headings(self):
        title, text = extract_html(PAGE.encode("utf-8"), "utf-8")
        self.assertEqual(title, "Family Rights | Example Org")
        self.assertIn("# Family Rights Guide", text)
        self.assertIn("## School Meetings", text)
        self.assertIn("- Bring notes", text)
        self.assertIn("Request | Parent", text)
        for junk in ("tracking", "About us menu", "sidebar", "Copyright footer", "secret hidden", "color: red"):
            self.assertNotIn(junk, text)

    def test_chunks_by_heading(self):
        _, text = extract_html(PAGE.encode("utf-8"))
        labels = [c["heading_path"] for c in _chunk_markdown(text)]
        self.assertEqual(labels, ["Family Rights Guide", "Family Rights Guide > School Meetings"])

    def test_title_becomes_heading_when_page_has_no_h1(self):
        html = f"<html><head><title>Plain Page</title></head><body><div>{LOREM}</div></body></html>"
        title, text = extract_html(html.encode())
        self.assertTrue(text.startswith("# Plain Page"))
        self.assertEqual(_chunk_markdown(text)[0]["heading_path"], "Plain Page")

    def test_charset_handling(self):
        latin = "<html><body><p>Café crème</p></body></html>".encode("latin-1")
        self.assertIn("Café crème", extract_html(latin, "iso-8859-1")[1])
        html = "<html><body><p>Café crème — naïve</p></body></html>"
        self.assertIn("Café crème — naïve", extract_html(html.encode("utf-8"), "utf-8")[1])
        # A bogus declared charset falls back to detection instead of failing.
        self.assertIn("Café", extract_html(html.encode("utf-8"), "not-a-charset")[1])

    def test_empty_page(self):
        title, text = extract_html(b"<html><body><script>x()</script></body></html>")
        self.assertEqual((title, text), ("", ""))
        self.assertEqual(_chunk_markdown(text), [])


if __name__ == "__main__":
    unittest.main()
