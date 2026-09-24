"""
html_extract.py

Main-text extraction for HTML pages linked from CSV rows, using the lxml that
is already vendored for python-docx (trafilatura, which the website crawler
uses, would add ~47 MB of dependencies to this zip-asset Lambda).

The page is rendered as Markdown-style text ("# Heading" lines, paragraphs
separated by blank lines) so process_document_batch._chunk_markdown can split
it by heading exactly like an uploaded Markdown file.
"""

import re

from lxml import etree
from lxml import html as lxml_html

# Never part of the readable content.
_DROP_TAGS = {
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
    "embed", "form", "button", "select", "input", "textarea", "nav", "header",
    "footer", "aside", "head",
}
_BLOCK_TAGS = {
    "p", "div", "section", "article", "main", "blockquote", "pre", "ul", "ol", "dl",
    "dt", "dd", "figure", "figcaption", "table", "thead", "tbody", "tfoot",
    "address", "details", "summary", "body",
}
_HEADINGS = {f"h{n}": n for n in range(1, 7)}
_MAIN_XPATHS = ("//main", "//article", "//*[@role='main']", "//body")


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _parse(raw: bytes, charset: str | None):
    if charset:
        try:
            parser = lxml_html.HTMLParser(encoding=charset)
            return lxml_html.document_fromstring(raw, parser=parser)
        except (LookupError, ValueError, etree.ParserError):
            pass  # unknown/wrong declared charset
    # Without a usable header charset lxml honours <meta charset> but otherwise
    # assumes Latin-1, garbling the (far more common) undeclared UTF-8 page.
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return lxml_html.document_fromstring(raw)
    return lxml_html.document_fromstring(raw, parser=lxml_html.HTMLParser(encoding="utf-8"))


def _title(doc) -> str:
    for xpath in ("//meta[@property='og:title']/@content", "//title//text()", "//h1//text()"):
        values = [_clean_text(v) for v in doc.xpath(xpath)]
        text = _clean_text(" ".join(v for v in values if v))
        if text:
            return text[:300]
    return ""


def _render(element, out: list):
    """Append `element`'s readable text to `out`, marking headings and blocks."""
    tag = element.tag if isinstance(element.tag, str) else None
    if tag is None:  # comment / processing instruction
        out.append(element.tail or "")
        return
    tag = tag.lower()
    if tag in _HEADINGS:
        text = _clean_text(element.text_content())
        if text:
            out.append(f"\n\n{'#' * _HEADINGS[tag]} {text}\n\n")
    elif tag == "br":
        out.append("\n")
    elif tag == "tr":
        cells = [_clean_text(c.text_content()) for c in element if isinstance(c.tag, str)]
        row = " | ".join(c for c in cells if c)
        if row:
            out.append(f"\n{row}\n")
    else:
        if tag == "li":
            out.append("\n- ")
        elif tag in _BLOCK_TAGS:
            out.append("\n\n")
        out.append(element.text or "")
        for child in element:
            _render(child, out)
        if tag in _BLOCK_TAGS or tag == "li":
            out.append("\n\n" if tag != "li" else "\n")
    out.append(element.tail or "")


def extract_html(raw: bytes, charset: str | None = None) -> tuple[str, str]:
    """(title, Markdown-style text) of an HTML page's main content."""
    doc = _parse(raw, charset)
    title = _title(doc)

    for bad in doc.xpath("//*[@hidden or @aria-hidden='true']"):
        bad.drop_tree()
    for bad in [el for el in doc.iter() if isinstance(el.tag, str) and el.tag.lower() in _DROP_TAGS]:
        if bad.getparent() is None:
            continue
        # An article's own <header>/<footer> (title, byline) is content; the page's is chrome.
        if bad.tag.lower() in ("header", "footer") and bad.xpath("ancestor::article or ancestor::main"):
            continue
        bad.drop_tree()

    root = None
    for xpath in _MAIN_XPATHS:
        found = doc.xpath(xpath)
        if found:
            root = found[0]
            break
    if root is None:
        root = doc

    out: list = []
    try:
        _render(root, out)
        text = "".join(out[:-1])  # drop the root's own tail
    except RecursionError:  # pathologically nested markup
        text = root.text_content()

    lines = [_clean_text(line) for line in text.splitlines()]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()

    # Give pages without their own <h1> the page title as the top heading, so
    # every chunk is labelled with what page it came from.
    if title and not re.search(r"^# ", text, flags=re.MULTILINE):
        text = f"# {title}\n\n{text}"
    return title, text
