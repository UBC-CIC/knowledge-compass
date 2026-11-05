"""
Crawl scope of a website data source: the admin's include/exclude patterns.

Two identical copies of this file exist (containers/tests/test_crawl_scope_container.py
checks that they match):
  cdk/lambda/knowledgeBase/helpers/crawl_scope.py  staging validation and the
                                                   check before ecs:RunTask
  cdk/containers/common/crawl_scope.py             enforcement in the crawler

Patterns are Python regular expressions, one per line in the admin form. Each is
matched with re.search against the page URL, so "^" anchors at the start of the
URL. A URL is in scope when no exclude pattern matches it and, if any include
patterns exist, at least one include pattern matches it.

Every URL is tested in two spellings: as given, and canonicalized (lowercase
scheme and host, default port and fragment dropped, percent-encoded unreserved
characters decoded, "." / ".." segments and repeated slashes removed). An
exclude pattern that matches either spelling excludes the URL, so
"/science/%70rivate/" cannot slip past an exclude written for "/science/private/".
Matching is case-sensitive in the path; start a pattern with (?i) to ignore case.
"""

import json
import re
from urllib.parse import urlsplit

# Limits keep the patterns inside the 8192-character ecs:RunTask overrides
# (they travel as task environment variables) and keep matching cheap.
MAX_PATTERNS = 20
MAX_PATTERN_LENGTH = 300
# Combined size of both lists as they appear, JSON-encoded twice, in the RunTask request.
MAX_ENCODED_LENGTH = 4000

INCLUDE_ENV = "CRAWL_INCLUDE_PATTERNS"
EXCLUDE_ENV = "CRAWL_EXCLUDE_PATTERNS"

_DEFAULT_PORTS = {"http": 80, "https": 443}
_UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
_PERCENT = re.compile(r"%([0-9A-Fa-f]{2})")


class InvalidPatterns(ValueError):
    """The include/exclude patterns are malformed. The message is safe to show to an admin."""


def validate_patterns(value, field: str) -> list:
    """Return the patterns as a list of strings, or raise InvalidPatterns."""
    if not isinstance(value, list):
        raise InvalidPatterns(f"{field} must be an array")
    if len(value) > MAX_PATTERNS:
        raise InvalidPatterns(f"{field} has more than {MAX_PATTERNS} patterns")
    for i, pattern in enumerate(value):
        if not isinstance(pattern, str):
            raise InvalidPatterns(f"{field}[{i}] must be a string")
        if not pattern.strip():
            raise InvalidPatterns(f"{field}[{i}] is empty")
        if len(pattern) > MAX_PATTERN_LENGTH:
            raise InvalidPatterns(f"{field}[{i}] is longer than {MAX_PATTERN_LENGTH} characters")
        try:
            re.compile(pattern)
        except (re.error, OverflowError, RecursionError, ValueError) as e:
            reason = getattr(e, "msg", None) or type(e).__name__
            raise InvalidPatterns(f"{field}[{i}] is not a valid regular expression ({reason})") from None
    return list(value)


def _encoded_length(include: list, exclude: list) -> int:
    return len(json.dumps(json.dumps(include))) + len(json.dumps(json.dumps(exclude)))


def _decode_unreserved(text: str) -> str:
    def repl(match):
        char = chr(int(match.group(1), 16))
        return char if char in _UNRESERVED else "%" + match.group(1).upper()

    return _PERCENT.sub(repl, text)


def _clean_path(path: str) -> str:
    path = re.sub(r"/{2,}", "/", path or "/")
    trailing = path.endswith(("/", "/.", "/.."))
    segments = []
    for segment in path.lstrip("/").split("/"):
        if segment == ".":
            continue
        if segment == "..":
            if segments:
                segments.pop()
            continue
        segments.append(segment)
    cleaned = "/" + "/".join(segments)
    if trailing and not cleaned.endswith("/"):
        cleaned += "/"
    return cleaned


def canonical_url(url: str):
    """The canonical spelling of an http(s) URL, or None when it cannot be parsed."""
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except (ValueError, AttributeError):
        return None
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").rstrip(".")
    if not scheme or not host:
        return None
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port in (None, _DEFAULT_PORTS.get(scheme)) else f"{host}:{port}"
    path = _clean_path(_decode_unreserved(parts.path))
    query = _decode_unreserved(parts.query)
    return f"{scheme}://{netloc}{path}" + (f"?{query}" if query else "")


class CrawlScope:
    """Compiled include/exclude patterns. CrawlScope() allows every URL."""

    def __init__(self, include_patterns=(), exclude_patterns=()):
        self.include_patterns = list(include_patterns)
        self.exclude_patterns = list(exclude_patterns)
        self._include = [re.compile(p) for p in self.include_patterns]
        self._exclude = [re.compile(p) for p in self.exclude_patterns]

    @classmethod
    def from_patterns(cls, include_patterns, exclude_patterns) -> "CrawlScope":
        """Validate both lists (None counts as empty) and compile them. Raises InvalidPatterns."""
        include = validate_patterns([] if include_patterns is None else include_patterns, "include_patterns")
        exclude = validate_patterns([] if exclude_patterns is None else exclude_patterns, "exclude_patterns")
        if _encoded_length(include, exclude) > MAX_ENCODED_LENGTH:
            raise InvalidPatterns("include_patterns and exclude_patterns are too long in total")
        return cls(include, exclude)

    @property
    def unrestricted(self) -> bool:
        return not self._include and not self._exclude

    def allows(self, url) -> bool:
        """True when the URL may be fetched and stored."""
        if not isinstance(url, str) or not url:
            return False
        if self.unrestricted:
            return True
        spellings = [url]
        canonical = canonical_url(url)
        if canonical and canonical != url:
            spellings.append(canonical)
        if any(p.search(s) for p in self._exclude for s in spellings):
            return False
        if self._include and not any(p.search(s) for p in self._include for s in spellings):
            return False
        return True


def to_env(include_patterns, exclude_patterns) -> list:
    """ECS containerOverrides environment entries carrying the patterns."""
    return [
        {"name": INCLUDE_ENV, "value": json.dumps(list(include_patterns or []))},
        {"name": EXCLUDE_ENV, "value": json.dumps(list(exclude_patterns or []))},
    ]


def from_env(environ) -> CrawlScope:
    """The scope passed by to_env. Unset variables mean no patterns. Raises InvalidPatterns."""
    lists = []
    for name, field in ((INCLUDE_ENV, "include_patterns"), (EXCLUDE_ENV, "exclude_patterns")):
        raw = (environ.get(name) or "").strip()
        if not raw:
            lists.append([])
            continue
        try:
            lists.append(json.loads(raw))
        except ValueError:
            raise InvalidPatterns(f"{field} is not a JSON array") from None
    return CrawlScope.from_patterns(*lists)
