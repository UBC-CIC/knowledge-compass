"""
Parse the model's <cited_indices> block and select the cited retrieval sources.

The suggestion/partial output formats ask for a JSON array such as
`<cited_indices>[1, 3]</cited_indices>`. Models occasionally emit near-misses
(trailing commas, quoted numbers, missing brackets); one stray token must not
discard every citation, so integers are extracted individually.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

_CITED_BLOCK = re.compile(r"<cited_indices>(.*?)</cited_indices>", re.DOTALL | re.IGNORECASE)
_INTEGER = re.compile(r"\d+")
# On turns with journey guides, guide sections are labeled G1, G2, ... and
# library sources keep plain numbers. A letter right before the token (for
# example "XG2") does not count as a label.
_CITED_REF = re.compile(r"(?<![a-z0-9])(g?)(\d+)", re.IGNORECASE)

# Source type of journey guide sections (guideline_retrieval.GUIDELINE_SOURCE_TYPE).
_GUIDE_SOURCE_TYPE = "guideline"
# A linked URL ends at whitespace, closing markdown or quote characters, or
# sentence punctuation followed by whitespace or the end of the text. This
# keeps "https://x.org/a" from matching inside "https://x.org/ab".
_URL_END = re.compile(r"$|[\s)\]>\"'`*|<]|[.,;:!?](?:$|[\s)\]*])")


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


def parse_cited_refs(response_text: str) -> Optional[Tuple[List[int], List[int]]]:
    """
    (guide_numbers, library_numbers) from the first <cited_indices> block on a
    turn with journey guides: "G2" is guide section 2, a plain "2" is library
    source 2. Each list keeps order without duplicates. Returns None when no
    block is present, like parse_cited_indices.
    """
    match = _CITED_BLOCK.search(response_text or "")
    if not match:
        return None
    guides: List[int] = []
    library: List[int] = []
    for prefix, token in _CITED_REF.findall(match.group(1)):
        target = guides if prefix else library
        value = int(token)
        if value not in target:
            target.append(value)
    return guides, library


def _source_link_values(source: Dict[str, Any]) -> List[str]:
    values = []
    for key in ("url", "uri"):
        value = source.get(key)
        if isinstance(value, str) and value.strip() and value.strip() not in values:
            values.append(value.strip())
    return values


def _first_link_position(text: str, value: str) -> int:
    """Index of the first occurrence of `value` in `text` that ends at a URL boundary, or -1."""
    start = text.find(value)
    while start != -1:
        if _URL_END.match(text, start + len(value)):
            return start
        start = text.find(value, start + 1)
    return -1


def select_linked_sources(sources: List[Dict[str, Any]], answer_text: str) -> List[Dict[str, Any]]:
    """
    Retrieved library sources whose url or uri appears in `answer_text`, in the
    order they are first linked. Guide sections are never returned. Pass the
    answer before strip_internal_links: the prompt shows internal values
    (s3://, upload://, csvlink://) that are removed from the visible text.
    Only one source is returned per linked value.
    """
    if not answer_text:
        return []
    found = []
    for position, source in enumerate(sources):
        if source.get("source_type") == _GUIDE_SOURCE_TYPE:
            continue
        hits = [
            index for index in (_first_link_position(answer_text, value) for value in _source_link_values(source))
            if index != -1
        ]
        if hits:
            found.append((min(hits), position, source))
    found.sort(key=lambda item: (item[0], item[1]))
    linked: List[Dict[str, Any]] = []
    seen_values = set()
    for _, _, source in found:
        values = set(_source_link_values(source))
        if values & seen_values:
            continue
        seen_values |= values
        linked.append(source)
    return linked


def merge_cited_and_linked(
    cited: List[Dict[str, Any]], linked: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Cited sources first, then linked ones not already cited (same object or same url/uri)."""
    merged = list(cited)
    seen_values = set()
    for source in cited:
        seen_values |= set(_source_link_values(source))
    for source in linked:
        if any(source is chosen for chosen in merged):
            continue
        values = set(_source_link_values(source))
        if values & seen_values:
            continue
        seen_values |= values
        merged.append(source)
    return merged


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
