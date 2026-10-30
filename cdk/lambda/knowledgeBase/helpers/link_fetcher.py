"""
link_fetcher.py

Fetches a single web page or PDF linked from a CSV row (see
process_csv_links.py). Deliberately not the website crawler: no browser, no
JavaScript, no following links beyond redirects, one document per URL.

Safety (see url_safety.py):
- http/https only; each hop's host must resolve only to public addresses and
  the connection is made to that vetted address (TLS still verifies the host
  name), so DNS rebinding cannot reach the VPC;
- redirects are followed manually (max_redirects) and each target is
  normalized, vetted and checked against robots.txt again;
- robots.txt is honoured for ROBOTS_USER_AGENT (RFC 9309: a 4xx robots.txt
  allows everything, a 5xx one disallows everything), including Crawl-delay
  up to max_crawl_delay;
- per-host concurrency and minimum delay between requests;
- body size is capped while streaming; only HTML and PDF are accepted.

Every failure raises FetchError with a human-readable reason and whether it
is permanent (dead link, blocked, unsupported) or transient (timeout, 5xx),
which decides whether previously indexed content for the link is kept.
"""

import http.client
import logging
import os
import socket
import ssl
import threading
import time
import zlib
from contextlib import contextmanager
from dataclasses import dataclass
from urllib import robotparser
from urllib.parse import urljoin, urlsplit

from helpers.url_safety import BlockedURL, InvalidURL, normalize_url, resolve_public_addresses

logger = logging.getLogger(__name__)

# FetchError reasons reach admins (csv_row_links.reason). BlockedURL messages
# name the resolved address, which would make the CSV-link path an oracle for
# what hostnames resolve to inside the VPC, so clients only get this text.
BLOCKED_REASON = "blocked: destination is not a public address"

ROBOTS_USER_AGENT = "KnowledgeCompassBot"
USER_AGENT = f"{ROBOTS_USER_AGENT}/1.0 (knowledge base link indexer)"

HTML = "text/html"
PDF = "application/pdf"
_HTML_TYPES = {"text/html", "application/xhtml+xml"}
_PDF_TYPES = {"application/pdf", "application/x-pdf"}
_SNIFF_TYPES = {"", "application/octet-stream", "binary/octet-stream"}
_REDIRECT_CODES = {301, 302, 303, 307, 308}
_READ_SIZE = 64 * 1024


@dataclass(frozen=True)
class FetchLimits:
    request_timeout: float = 15.0        # per socket operation (connect / each read)
    total_timeout: float = 45.0          # whole fetch of one URL, redirects included
    max_bytes: int = 10 * 1024 * 1024    # decoded body
    max_redirects: int = 5
    per_domain_concurrency: int = 2
    per_domain_delay: float = 1.0        # min seconds between requests to one host
    max_crawl_delay: float = 10.0        # cap on a robots.txt Crawl-delay
    max_robots_bytes: int = 512 * 1024

    @classmethod
    def from_env(cls) -> "FetchLimits":
        def num(name, default, cast):
            raw = os.environ.get(name)
            try:
                return cast(raw) if raw not in (None, "") else default
            except ValueError:
                return default

        d = cls()
        return cls(
            request_timeout=num("LINK_REQUEST_TIMEOUT_SECONDS", d.request_timeout, float),
            total_timeout=num("LINK_TOTAL_TIMEOUT_SECONDS", d.total_timeout, float),
            max_bytes=num("LINK_MAX_CONTENT_BYTES", d.max_bytes, int),
            max_redirects=num("LINK_MAX_REDIRECTS", d.max_redirects, int),
            per_domain_concurrency=max(1, num("LINK_PER_DOMAIN_CONCURRENCY", d.per_domain_concurrency, int)),
            per_domain_delay=num("LINK_PER_DOMAIN_DELAY_SECONDS", d.per_domain_delay, float),
            max_crawl_delay=num("LINK_MAX_CRAWL_DELAY_SECONDS", d.max_crawl_delay, float),
        )


class FetchError(Exception):
    def __init__(self, reason: str, *, permanent: bool, http_status: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.permanent = permanent
        self.http_status = http_status


@dataclass
class FetchResult:
    url: str                # final URL, after redirects
    http_status: int
    content_type: str       # HTML or PDF
    charset: str | None
    body: bytes


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """Connects to a pre-vetted IP while sending the original Host header."""

    def __init__(self, host, ip, port, timeout):
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self):
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """As above; TLS still verifies the certificate against the host name."""

    def __init__(self, host, ip, port, timeout, context):
        super().__init__(host, port, timeout=timeout, context=context)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _HostThrottle:
    def __init__(self, concurrency: int):
        self.slots = threading.BoundedSemaphore(concurrency)
        self.lock = threading.Lock()
        self.next_at = 0.0


def _parse_content_type(value: str) -> tuple[str, str | None]:
    media, _, params = (value or "").partition(";")
    charset = None
    for param in params.split(";"):
        key, _, val = param.strip().partition("=")
        if key.lower() == "charset" and val:
            charset = val.strip().strip('"').strip("'") or None
    return media.strip().lower(), charset


def _sniff(body: bytes) -> str | None:
    head = body[:2048].lstrip()
    if head.startswith(b"%PDF-"):
        return PDF
    lowered = head.lower()
    if lowered.startswith(b"<!doctype html") or b"<html" in lowered:
        return HTML
    return None


class LinkFetcher:
    """Thread-safe: one instance is shared by the worker's fetch threads."""

    def __init__(
        self,
        limits: FetchLimits | None = None,
        *,
        resolver=socket.getaddrinfo,
        connection_factory=None,
        clock=time.monotonic,
        sleep=time.sleep,
    ):
        self.limits = limits or FetchLimits()
        self._resolver = resolver
        self._connection_factory = connection_factory or self._open_connection
        self._clock = clock
        self._sleep = sleep
        self._ssl_context = None
        self._lock = threading.Lock()
        self._hosts: dict[str, _HostThrottle] = {}
        self._robots: dict[str, tuple] = {}
        self._robots_locks: dict[str, threading.Lock] = {}

    # ── Public ───────────────────────────────────────────────────────────────

    def fetch(self, url: str) -> FetchResult:
        deadline = self._clock() + self.limits.total_timeout
        try:
            current = normalize_url(url)
        except InvalidURL as e:
            raise FetchError(str(e), permanent=True) from e

        for _ in range(self.limits.max_redirects + 1):
            delay = self._check_robots(current, deadline)
            with self._request(current, delay, deadline) as (status, headers, response):
                if status in _REDIRECT_CODES:
                    current = self._redirect_target(current, headers)
                    continue
                if 200 <= status < 300:
                    return self._read_document(current, status, headers, response, deadline)
                raise self._status_error(status)
        raise FetchError(f"more than {self.limits.max_redirects} redirects", permanent=True)

    # ── Requests ─────────────────────────────────────────────────────────────

    def _open_connection(self, scheme: str, host: str, ip: str, port: int, timeout: float):
        if scheme == "https":
            if self._ssl_context is None:
                self._ssl_context = ssl.create_default_context()
            return _PinnedHTTPSConnection(host, ip, port, timeout, self._ssl_context)
        return _PinnedHTTPConnection(host, ip, port, timeout)

    @contextmanager
    def _request(self, url: str, delay: float, deadline: float):
        """Yields (status, headers, response) for one GET, holding a host slot."""
        parts = urlsplit(url)
        host = parts.hostname
        port = parts.port or (443 if parts.scheme == "https" else 80)
        try:
            ip = resolve_public_addresses(host, port, self._resolver)[0]
        except BlockedURL as e:
            logger.warning("Link fetch blocked: %s", e)
            raise FetchError(BLOCKED_REASON, permanent=True) from e
        except OSError as e:
            raise FetchError(f"could not resolve host {host}", permanent=True) from e

        target = parts.path + (f"?{parts.query}" if parts.query else "")
        timeout = max(1.0, min(self.limits.request_timeout, deadline - self._clock()))
        with self._host_slot(host, delay, deadline):
            connection = self._connection_factory(parts.scheme, host, ip, port, timeout)
            try:
                try:
                    connection.request(
                        "GET",
                        target,
                        headers={
                            "User-Agent": USER_AGENT,
                            "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1",
                            "Accept-Encoding": "gzip",
                            "Connection": "close",
                        },
                    )
                    response = connection.getresponse()
                except ssl.SSLCertVerificationError as e:
                    raise FetchError(f"TLS certificate check failed for {host}", permanent=True) from e
                except (socket.timeout, TimeoutError) as e:
                    raise FetchError("timed out", permanent=False) from e
                except (OSError, http.client.HTTPException) as e:
                    raise FetchError(f"connection failed: {e.__class__.__name__}", permanent=False) from e
                yield response.status, response.headers, response
            finally:
                connection.close()

    @contextmanager
    def _host_slot(self, host: str, delay: float, deadline: float):
        with self._lock:
            throttle = self._hosts.setdefault(host, _HostThrottle(self.limits.per_domain_concurrency))
        if not throttle.slots.acquire(timeout=max(0.0, deadline - self._clock())):
            raise FetchError(f"timed out waiting for a request slot on {host}", permanent=False)
        try:
            with throttle.lock:
                now = self._clock()
                wait = throttle.next_at - now
                throttle.next_at = max(now, throttle.next_at) + delay
            if wait > 0:
                if now + wait > deadline:
                    raise FetchError(f"timed out waiting to respect the crawl delay for {host}", permanent=False)
                self._sleep(wait)
            yield
        finally:
            throttle.slots.release()

    def _redirect_target(self, current: str, headers) -> str:
        location = headers.get("Location")
        if not location:
            raise FetchError("redirect without a Location header", permanent=True)
        try:
            return normalize_url(urljoin(current, location.strip()))
        except InvalidURL as e:
            raise FetchError(f"redirected to a URL that is not crawled ({e})", permanent=True) from e

    @staticmethod
    def _status_error(status: int) -> FetchError:
        if status in (401, 403, 407):
            return FetchError(f"HTTP {status}: access denied (authenticated pages are not crawled)", permanent=True, http_status=status)
        if status == 429 or status >= 500:
            return FetchError(f"HTTP {status}", permanent=False, http_status=status)
        return FetchError(f"HTTP {status}", permanent=True, http_status=status)

    # ── Bodies ───────────────────────────────────────────────────────────────

    def _read_body(self, response, headers, limit: int, deadline: float, *, truncate: bool = False) -> bytes:
        """Stream the body, raising past `limit` bytes (or cutting it there if `truncate`)."""
        declared = headers.get("Content-Length")
        if not truncate and declared and declared.strip().isdigit() and int(declared) > limit:
            raise FetchError(f"content is larger than {limit} bytes", permanent=True)
        chunks, total = [], 0
        try:
            while True:
                chunk = response.read(_READ_SIZE)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    if truncate:
                        chunks.append(chunk[: len(chunk) - (total - limit)])
                        break
                    raise FetchError(f"content is larger than {limit} bytes", permanent=True)
                chunks.append(chunk)
                if self._clock() > deadline:
                    raise FetchError("timed out while downloading", permanent=False)
        except (socket.timeout, TimeoutError) as e:
            raise FetchError("timed out while downloading", permanent=False) from e
        except (OSError, http.client.HTTPException) as e:
            raise FetchError(f"download failed: {e.__class__.__name__}", permanent=False) from e
        body = b"".join(chunks)

        encoding = (headers.get("Content-Encoding") or "").strip().lower()
        if encoding in ("", "identity"):
            return body
        if encoding in ("gzip", "x-gzip", "deflate"):
            wbits = 47 if encoding != "deflate" else 15  # 47 = auto-detect gzip/zlib header
            try:
                inflater = zlib.decompressobj(wbits)
                decoded = inflater.decompress(body, limit + 1)
            except zlib.error as e:
                raise FetchError("could not decompress content", permanent=True) from e
            if len(decoded) > limit:
                raise FetchError(f"content is larger than {limit} bytes", permanent=True)
            return decoded
        raise FetchError(f"unsupported content encoding: {encoding}", permanent=True)

    def _read_document(self, url, status, headers, response, deadline) -> FetchResult:
        media, charset = _parse_content_type(headers.get("Content-Type", ""))
        if media in _HTML_TYPES:
            kind = HTML
        elif media in _PDF_TYPES:
            kind = PDF
        elif media in _SNIFF_TYPES:
            kind = None
        else:
            raise FetchError(f"unsupported content type: {media}", permanent=True, http_status=status)

        body = self._read_body(response, headers, self.limits.max_bytes, deadline)
        kind = kind or _sniff(body)
        if kind is None:
            raise FetchError(f"unsupported content type: {media or 'unknown'}", permanent=True, http_status=status)
        return FetchResult(url=url, http_status=status, content_type=kind, charset=charset, body=body)

    # ── robots.txt ───────────────────────────────────────────────────────────

    def _check_robots(self, url: str, deadline: float) -> float:
        """Raise if robots.txt disallows `url`; return the delay to use for its host."""
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        with self._lock:
            origin_lock = self._robots_locks.setdefault(origin, threading.Lock())
        with origin_lock:
            if origin not in self._robots:
                self._robots[origin] = self._load_robots(origin, deadline)
        parser, error, crawl_delay = self._robots[origin]

        if error:
            raise error
        if parser is not None and not parser.can_fetch(ROBOTS_USER_AGENT, url):
            raise FetchError("disallowed by robots.txt", permanent=True)
        return max(self.limits.per_domain_delay, min(crawl_delay or 0.0, self.limits.max_crawl_delay))

    def _load_robots(self, origin: str, deadline: float) -> tuple:
        """(parser or None for allow-all, FetchError to raise or None, crawl delay)."""
        current = f"{origin}/robots.txt"
        try:
            for _ in range(self.limits.max_redirects + 1):
                with self._request(current, self.limits.per_domain_delay, deadline) as (status, headers, response):
                    if status in _REDIRECT_CODES:
                        current = self._redirect_target(current, headers)
                        continue
                    if 200 <= status < 300:
                        # RFC 9309: parse at least the first 500 KiB; ignore the rest.
                        raw = self._read_body(
                            response, headers, self.limits.max_robots_bytes, deadline, truncate=True
                        )
                        parser = robotparser.RobotFileParser()
                        parser.parse(raw.decode("utf-8", errors="replace").splitlines())
                        delay = parser.crawl_delay(ROBOTS_USER_AGENT)
                        return parser, None, float(delay) if delay else 0.0
                    if 400 <= status < 500 and status != 429:
                        return None, None, 0.0
                    return None, FetchError(f"robots.txt unavailable (HTTP {status}); not crawled", permanent=False, http_status=status), 0.0
            return None, None, 0.0  # redirect loop on robots.txt: treat as absent
        except FetchError as e:
            return None, e, 0.0
