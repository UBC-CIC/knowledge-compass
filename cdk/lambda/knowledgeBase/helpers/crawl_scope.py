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

URLs are compared in three spellings:
  raw        as given
  canonical  lowercase scheme and host, default port, fragment and userinfo
             dropped, percent-escapes decoded until stable (at most
             MAX_DECODE_ROUNDS rounds), "\\", "%2F" and "%5C" read as "/",
             "." / ".." segments and repeated slashes removed, then re-encoded
             (reserved and non-ASCII characters as uppercase %XX)
  decoded    the canonical URL with every escape decoded
An exclude pattern that matches any spelling excludes the URL, so
"/science/%70rivate/" or "/science/a/..%2Fprivate/" cannot slip past an exclude
written for "/science/private/". Include patterns are matched against the
canonical spelling only, so "/docs/../private/" is not inside an include written
for "/docs/". URLs with userinfo ("user@host") are never in scope, and with
patterns, neither are URLs longer than MAX_URL_LENGTH or whose encoding does
not settle. Matching is case-sensitive in the path; start a pattern with (?i)
to ignore case.

Python's re engine backtracks, so validate_patterns rejects patterns whose
matching time could grow fast with the URL length: nested quantifiers such as
(a+)+, a quantified group containing "|", backreferences and conditional
groups, more than MAX_OPEN_REPEATS open-ended repeats (one fewer when the
pattern does not start with "^"), and more than MAX_CHOICES combinations of
optional parts and alternatives.
"""

import json
import re
from urllib.parse import quote, unquote_to_bytes, urlsplit

try:
    from re import _parser as _sre_parse  # Python 3.11+
except ImportError:  # pragma: no cover - older interpreters
    import sre_parse as _sre_parse  # type: ignore

# Limits keep the patterns inside the 8192-character ecs:RunTask overrides
# (they travel as task environment variables) and keep matching cheap.
MAX_PATTERNS = 20
MAX_PATTERN_LENGTH = 300
# Combined size of both lists as they appear, JSON-encoded twice, in the RunTask request.
MAX_ENCODED_LENGTH = 4000
# Matching cost bounds (see the module docstring).
MAX_URL_LENGTH = 2048
MAX_DECODE_ROUNDS = 3
MAX_OPEN_REPEATS = 2
MAX_CHOICES = 16

INCLUDE_ENV = "CRAWL_INCLUDE_PATTERNS"
EXCLUDE_ENV = "CRAWL_EXCLUDE_PATTERNS"

_DEFAULT_PORTS = {"http": 80, "https": 443}
# quote() never escapes letters, digits and "_.-~".
_PATH_SAFE = "/!$&'()*+,;=:@"
_QUERY_SAFE = _PATH_SAFE + "?"
_HOST_FORBIDDEN = frozenset("/\\@?#%[] ")
_REPEATS = frozenset(("MAX_REPEAT", "MIN_REPEAT", "POSSESSIVE_REPEAT"))
_BACKREFS = frozenset(("GROUPREF", "GROUPREF_EXISTS", "GROUPREF_IGNORE", "GROUPREF_LOC_IGNORE",
                       "GROUPREF_UNI_IGNORE"))
_STARTS = frozenset(("AT_BEGINNING", "AT_BEGINNING_STRING"))


class InvalidPatterns(ValueError):
    """The include/exclude patterns are malformed. The message is safe to show to an admin."""


class _TooComplex(Exception):
    pass


def _op_name(op) -> str:
    return getattr(op, "name", str(op))


def _cost(items):
    """(open-ended repeats on the worst path, choice combinations, has "|", has a variable repeat)."""
    degree, choices, branch, variable = 0, 1, False, False
    for op, av in items:
        name = _op_name(op)
        if name in _BACKREFS:
            raise _TooComplex("backreferences and conditional groups are not allowed")
        if name in _REPEATS:
            low, high, body = av
            b_degree, b_choices, b_branch, b_variable = _cost(body)
            if b_branch:
                raise _TooComplex("a group with | alternation cannot be repeated or optional")
            if high > 1 and b_variable:
                raise _TooComplex("nested quantifiers such as (a+)+ are not allowed")
            if low == high:
                degree += b_degree
                choices *= b_choices
            elif high == 1:
                degree += b_degree
                choices *= 2 * b_choices
                variable = True
            else:
                degree += 1
                variable = True
            variable = variable or b_variable
        elif name == "BRANCH":
            costs = [_cost(alt) for alt in av[1]]
            degree += max(c[0] for c in costs)
            choices *= sum(c[1] for c in costs)
            branch = True
            variable = variable or any(c[3] for c in costs)
        else:
            for sub in _subpatterns(av):
                s_degree, s_choices, s_branch, s_variable = _cost(sub)
                degree += s_degree
                choices *= s_choices
                branch = branch or s_branch
                variable = variable or s_variable
        if choices > MAX_CHOICES:
            raise _TooComplex(f"more than {MAX_CHOICES} combinations of optional parts and | alternatives")
    return degree, choices, branch, variable


def _subpatterns(av):
    if isinstance(av, _sre_parse.SubPattern):
        yield av
    elif isinstance(av, (tuple, list)):
        for item in av:
            if isinstance(item, _sre_parse.SubPattern):
                yield item


def _check_complexity(pattern: str) -> None:
    """Raise _TooComplex when the pattern could backtrack heavily on a long URL."""
    parsed = _sre_parse.parse(pattern)
    degree = _cost(parsed)[0]
    anchored = (
        len(parsed) > 0
        and _op_name(parsed[0][0]) == "AT"
        and _op_name(parsed[0][1]) in _STARTS
        and not parsed.state.flags & re.MULTILINE
    )
    if not anchored:
        degree += 1  # re.search retries the pattern at every position
    if degree > MAX_OPEN_REPEATS:
        raise _TooComplex(
            f"more than {MAX_OPEN_REPEATS} open-ended repeats such as .* or \\d+ "
            f"({MAX_OPEN_REPEATS - 1} when the pattern does not start with ^)"
        )


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
        try:
            _check_complexity(pattern)
        except _TooComplex as e:
            raise InvalidPatterns(f"{field}[{i}] could take too long to match: {e}") from None
        except (re.error, OverflowError, RecursionError, ValueError) as e:
            raise InvalidPatterns(f"{field}[{i}] could take too long to match ({type(e).__name__})") from None
    return list(value)


def _encoded_length(include: list, exclude: list) -> int:
    return len(json.dumps(json.dumps(include))) + len(json.dumps(json.dumps(exclude)))


def _decode_fully(text):
    """The bytes of text with percent-escapes decoded until stable, or None if they never settle."""
    data = text.encode("utf-8") if isinstance(text, str) else text
    for _ in range(MAX_DECODE_ROUNDS + 1):
        decoded = unquote_to_bytes(data)
        if decoded == data:
            return data
        data = decoded
    return None


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


def _browser_form(url: str) -> str:
    # Browsers read "\" as "/" before the query of an http(s) URL.
    url = url.strip()
    cut = min([i for i in (url.find("?"), url.find("#")) if i >= 0] or [len(url)])
    return url[:cut].replace("\\", "/") + url[cut:]


def _has_userinfo(url: str) -> bool:
    for spelling in (url, _browser_form(url)):
        try:
            parts = urlsplit(spelling.strip())
        except ValueError:
            continue
        if parts.username is not None or parts.password is not None:
            return True
    return False


def _spellings(url: str):
    """(canonical, decoded) spellings of an http(s) URL, or None when it cannot be compared safely."""
    try:
        parts = urlsplit(_browser_form(url))
        port = parts.port
    except (ValueError, AttributeError):
        return None
    if parts.username is not None or parts.password is not None:
        return None
    scheme = parts.scheme.lower()
    host = _decode_fully(parts.hostname or "")
    path = _decode_fully(parts.path)
    query = _decode_fully(parts.query)
    if host is None or path is None or query is None:
        return None
    try:
        host = host.decode("utf-8").lower().rstrip(".")
    except UnicodeDecodeError:
        return None
    if not scheme or not host or any(c in _HOST_FORBIDDEN or ord(c) < 33 for c in host):
        return None
    if ":" in host:
        host = f"[{host}]"
    netloc = host if port in (None, _DEFAULT_PORTS.get(scheme)) else f"{host}:{port}"
    # latin-1 maps each byte to one character, so the path round-trips exactly.
    path = _clean_path(path.decode("latin-1").replace("\\", "/")).encode("latin-1")
    base = f"{scheme}://{netloc}"
    canonical = base + quote(path, safe=_PATH_SAFE)
    decoded = base + path.decode("utf-8", "replace")
    if query:
        canonical += "?" + quote(query, safe=_QUERY_SAFE)
        decoded += "?" + query.decode("utf-8", "replace")
    return canonical, decoded


def canonical_url(url: str):
    """The canonical spelling of an http(s) URL, or None when it cannot be parsed or has userinfo."""
    if not isinstance(url, str):
        return None
    spellings = _spellings(url)
    return spellings[0] if spellings else None


class CrawlScope:
    """Compiled include/exclude patterns. CrawlScope() allows every URL without userinfo."""

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
        if _has_userinfo(url):
            return False
        if self.unrestricted:
            return True
        if len(url) > MAX_URL_LENGTH:
            return False
        spellings = _spellings(url)
        if spellings is None:
            return False
        canonical, decoded = spellings
        if any(p.search(s) for p in self._exclude for s in {url, canonical, decoded}):
            return False
        if self._include and not any(p.search(canonical) for p in self._include):
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
