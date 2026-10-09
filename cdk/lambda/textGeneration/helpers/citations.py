"""
Parse the model's <cited_indices> block and select the cited retrieval sources.

The suggestion/partial output formats ask for a JSON array such as
`<cited_indices>[1, 3]</cited_indices>`. Models occasionally emit near-misses
(trailing commas, quoted numbers, missing brackets); one stray token must not
discard every citation, so integers are extracted individually.
"""

import re
from typing import Any, Dict, List, Optional

_CITED_BLOCK = re.compile(r"<cited_indices>(.*?)</cited_indices>", re.DOTALL | re.IGNORECASE)
_INTEGER = re.compile(r"\d+")


def parse_cited_indices(response_text: str) -> Optional[List[int]]:
    """
    Return the 1-based source indices listed in the first <cited_indices> block,
    in order and without duplicates. Returns None when no block is present so
    callers can tell "cited nothing" ([]) from "did not follow the format".
    """
    match = _CITED_BLOCK.search(response_text or "")
    if not match:
        return None
    indices: List[int] = []
    for token in _INTEGER.findall(match.group(1)):
        value = int(token)
        if value not in indices:
            indices.append(value)
    return indices


def select_cited_sources(sources: List[Dict[str, Any]], cited_indices: List[int]) -> List[Dict[str, Any]]:
    """Sources referenced by 1-based `cited_indices`, in retrieval order; out-of-range indices are ignored."""
    cited = set(cited_indices)
    return [source for position, source in enumerate(sources, 1) if position in cited]


# Internal storage identities (s3://, upload://, csvlink://, ...) must never
# reach public users, in any markdown form. Mirrors
# handlers/utils/publicSources.js stripInternalLinks; keep the two in sync.
_NON_HTTP_SCHEME = r"(?!https?://)[a-z][a-z0-9+.\-]*://"

# Inline link, e.g. [Handbook](s3://bucket/key) -> "Handbook".
_NON_HTTP_MARKDOWN_LINK = re.compile(
    r'\[([^\]]*)\]\(\s*<?' + _NON_HTTP_SCHEME + r'[^)\s>]*>?(?:\s+"[^"]*")?\s*\)',
    re.IGNORECASE,
)
# Reference definition, e.g. "[1]: upload://doc.pdf" -> removed.
_NON_HTTP_REFERENCE_DEF = re.compile(
    r"^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?" + _NON_HTTP_SCHEME + r"[^\s>]*>?",
    re.IGNORECASE | re.MULTILINE,
)
# Autolink, e.g. <s3://bucket/key> -> removed.
_NON_HTTP_AUTOLINK = re.compile(r"<" + _NON_HTTP_SCHEME + r"[^>\s]*>", re.IGNORECASE)
# Bare URI anywhere, e.g. "see **s3://bucket/my_key**" -> "see **". The
# lookbehind only stops a match from starting mid-scheme (so "https://"
# is never read as "ttps://"); any other preceding character is fine.
_NON_HTTP_BARE_URI = re.compile(
    r"(?<![a-z0-9])" + _NON_HTTP_SCHEME + r"[^\s)\]>\"'`|]*",
    re.IGNORECASE,
)

# Longest construct the stream holds back while waiting for it to close.
_MAX_PENDING_CHARS = 2500
_SETTLED_BRACKET = re.compile(
    r"\[[^\]\n]*\]([^(:\]]|\([^)]*\)|:[ \t]*\S+\s)"  # plain [text], closed inline link, or finished definition
    r"|\[[^\]]*\n",  # a newline before ']' cannot be a link we strip
)


def strip_internal_links(text: str) -> str:
    """Remove internal identities: inline links keep their text; definitions, autolinks and bare URIs are dropped."""
    if not text:
        return text
    text = _NON_HTTP_MARKDOWN_LINK.sub(r"\1", text)
    text = _NON_HTTP_REFERENCE_DEF.sub("", text)
    text = _NON_HTTP_AUTOLINK.sub("", text)
    return _NON_HTTP_BARE_URI.sub("", text)


def stream_settled_length(text: str) -> int:
    """
    Length of the prefix of streamed `text` that later tokens cannot change
    the sanitized form of. Holds back the trailing word (a URI may still be
    arriving), an unclosed '[' link or definition, and an unclosed '<'.
    """
    cut = len(text)
    if text and not text[-1].isspace():
        cut = max(text.rfind(c) for c in " \t\r\n") + 1

    # Each rule is judged on the prefix that would be sent, since a cut can
    # land inside a construct that is closed in the full text.
    while True:
        prefix = text[:cut]
        new_cut = cut
        bracket = prefix.rfind("[")
        if bracket != -1 and cut - bracket <= _MAX_PENDING_CHARS:
            if not _SETTLED_BRACKET.match(prefix, bracket):
                new_cut = bracket
        angle = prefix.rfind("<")
        if angle != -1 and cut - angle <= _MAX_PENDING_CHARS:
            tail = prefix[angle:]
            if ">" not in tail and not any(c.isspace() for c in tail):
                new_cut = min(new_cut, angle)
        if new_cut == cut:
            return cut
        cut = new_cut
