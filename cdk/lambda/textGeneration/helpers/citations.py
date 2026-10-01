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


# Markdown links whose target is not http(s), e.g. [Handbook](s3://bucket/key).
# Mirrors handlers/utils/publicSources.js stripInternalLinks.
_NON_HTTP_MARKDOWN_LINK = re.compile(
    r'\[([^\]]*)\]\(\s*<?(?!https?://)[a-z][a-z0-9+.\-]*://[^)\s>]*>?(?:\s+"[^"]*")?\s*\)',
    re.IGNORECASE,
)


def strip_internal_links(text: str) -> str:
    """Replace markdown links to internal identities (upload://, s3://, ...) with their link text."""
    if not text:
        return text
    return _NON_HTTP_MARKDOWN_LINK.sub(r"\1", text)
