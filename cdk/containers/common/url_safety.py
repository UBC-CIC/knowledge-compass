"""
url_safety.py (container copy)

SSRF guard for the crawler container. MIRRORS
cdk/lambda/knowledgeBase/helpers/url_safety.py: the container image cannot
import Lambda helpers, so normalize_url / is_public_ip /
resolve_public_addresses / check_public_url are copied here and must be kept
in sync (cdk/containers/tests/test_url_safety_container.py checks parity).
Stdlib only.

- only http/https URLs, with no embedded credentials and on common web ports;
- every address a host resolves to must be publicly routable (a host
  resolving to both a public and a private address is rejected), which blocks
  the VPC, loopback, and the link-local ECS/EC2 metadata endpoints
  (169.254.170.2, 169.254.169.254).

Limits (best-effort, defense in depth):
- Chromium does its own DNS lookup after this check, and PublicHostChecker
  caches verdicts for the run, so a DNS-rebinding host can still reach an
  internal address between check and connect. The ingestion security group
  limits public egress to 443.
- Playwright does not route the redirect hops of a navigation; the crawler
  re-checks the final page URL before storing anything.
- WebSocket connections are not guarded.
"""

import asyncio
import ipaddress
import socket
from urllib.parse import quote, urlsplit, urlunsplit

# ── Mirrored from the Lambda helpers/url_safety.py (keep in sync) ─────────────

# Longest normalized URL accepted; 'csvlink://' + this still fits sources.url (varchar 2048).
MAX_URL_LENGTH = 2000

_DEFAULT_PORTS = {"http": 80, "https": 443}
# Destination ports a link may use.
ALLOWED_PORTS = frozenset({80, 443, 8080, 8443})
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
# Characters left as-is when percent-encoding a path / query (RFC 3986 reserved + unreserved + '%').
_PATH_SAFE = "/%:@!$&'()*+,;=-._~"
_QUERY_SAFE = _PATH_SAFE + "?"


class InvalidURL(ValueError):
    """The value is not an http(s) URL we are willing to fetch."""


class BlockedURL(ValueError):
    """The URL points at (or resolves to) a non-public address."""


def normalize_url(raw: str) -> str:
    """
    Canonical form: lowercase scheme and host, IDNA host, default port dropped,
    empty path -> '/', fragment removed, path/query percent-encoded. Raises InvalidURL.
    """
    value = (raw or "").strip()
    if not value:
        raise InvalidURL("empty URL")
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as e:
        raise InvalidURL(f"malformed URL: {e}") from e

    scheme = parts.scheme.lower()
    if scheme not in _DEFAULT_PORTS:
        raise InvalidURL("only http and https URLs are crawled")
    if parts.username is not None or parts.password is not None:
        raise InvalidURL("URLs with embedded credentials are not crawled")
    if port is not None and port not in ALLOWED_PORTS:
        raise InvalidURL(f"port {port} is not crawled (allowed: {', '.join(map(str, sorted(ALLOWED_PORTS)))})")

    host = parts.hostname
    if not host:
        raise InvalidURL("URL has no host")
    if _ip_or_none(host) is not None:
        host = f"[{host}]" if ":" in host else host
    else:
        try:
            host = host.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError as e:
            raise InvalidURL("invalid host name") from e
        if not host:
            raise InvalidURL("URL has no host")

    netloc = host if port in (None, _DEFAULT_PORTS[scheme]) else f"{host}:{port}"
    path = quote(parts.path or "/", safe=_PATH_SAFE)
    query = quote(parts.query, safe=_QUERY_SAFE)
    url = urlunsplit((scheme, netloc, path, query, ""))
    if len(url) > MAX_URL_LENGTH:
        raise InvalidURL(f"URL is longer than {MAX_URL_LENGTH} characters")
    return url


def _ip_or_none(value: str):
    try:
        return ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return None


def is_public_ip(value: str) -> bool:
    """True only for globally routable unicast addresses."""
    ip = _ip_or_none(value)
    if ip is None:
        return False
    if ip.version == 6:
        # Addresses that embed an IPv4 address are judged by that address.
        if ip.ipv4_mapped is not None:
            return is_public_ip(str(ip.ipv4_mapped))
        if ip.sixtofour is not None:
            return is_public_ip(str(ip.sixtofour))
        if ip.teredo is not None:
            return all(is_public_ip(str(embedded)) for embedded in ip.teredo)
        if ip in _NAT64:
            return is_public_ip(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
    return bool(
        ip.is_global
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_multicast
        and not ip.is_reserved
        and not ip.is_unspecified
    )


def resolve_public_addresses(host: str, port: int, resolver=socket.getaddrinfo) -> list[str]:
    """
    Every address `host` resolves to, all of which must be public. Raises
    BlockedURL if any is not, or OSError (socket.gaierror) if it doesn't resolve.
    """
    literal = _ip_or_none(host.strip("[]"))
    if literal is not None:
        addresses = [str(literal)]
    else:
        infos = resolver(host, port, type=socket.SOCK_STREAM)
        addresses = list(dict.fromkeys(info[4][0].split("%", 1)[0] for info in infos))
    if not addresses:
        raise socket.gaierror(f"{host} did not resolve to any address")
    blocked = [a for a in addresses if not is_public_ip(a)]
    if blocked:
        raise BlockedURL(f"{host} resolves to a non-public address ({blocked[0]})")
    return addresses


def check_public_url(raw: str, *, resolver=None) -> str:
    """
    normalize_url(raw), then require every address its host resolves to be
    public. Returns the normalized URL. Raises InvalidURL, BlockedURL, or
    OSError (socket.gaierror) when the host does not resolve. BlockedURL
    messages contain the resolved address: never print them.
    """
    if not isinstance(raw, str):
        raise InvalidURL("URL must be a string")
    url = normalize_url(raw)
    parts = urlsplit(url)
    port = parts.port or _DEFAULT_PORTS[parts.scheme]
    resolve_public_addresses(parts.hostname, port, resolver or socket.getaddrinfo)
    return url


# ── Container-only helpers ────────────────────────────────────────────────────

def _host_and_port(url: str):
    parts = urlsplit(url)
    return parts.hostname, parts.port or _DEFAULT_PORTS[parts.scheme]


def is_crawlable_url(url: str) -> bool:
    """
    Cheap, DNS-free filter for links about to be enqueued: an http(s) URL we
    would fetch whose host, if an IP literal, is public. Host names are
    checked against DNS later, when the browser requests them.
    """
    try:
        host, _ = _host_and_port(normalize_url(url))
    except (InvalidURL, TypeError, AttributeError):
        return False
    if _ip_or_none(host) is not None:
        return is_public_ip(host)
    return True


class PublicHostChecker:
    """
    Async per-request check used by the crawler's Playwright route handler and
    pre-navigation hook. Verdicts are cached per (host, port) for the run (see
    the DNS-rebinding note in the module docstring).
    """

    def __init__(self, resolver=None, max_entries: int = 4096):
        # resolver: async (host, port, *, type) -> getaddrinfo-style infos.
        self._resolver = resolver
        self._max_entries = max_entries
        self._cache: dict = {}
        self.blocked_hosts: set = set()
        # Hosts the caller has already logged as blocked (log each once).
        self.logged_hosts: set = set()

    async def _resolve(self, host, port):
        resolver = self._resolver or asyncio.get_running_loop().getaddrinfo
        return await resolver(host, port, type=socket.SOCK_STREAM)

    async def allows(self, url: str) -> bool:
        try:
            host, port = _host_and_port(normalize_url(url))
        except (InvalidURL, TypeError, AttributeError):
            return False
        if _ip_or_none(host.strip("[]")) is not None:
            allowed = is_public_ip(host.strip("[]"))
        elif (host, port) in self._cache:
            return self._cache[(host, port)]
        else:
            try:
                infos = await self._resolve(host, port)
                resolve_public_addresses(host, port, lambda *a, **k: infos)
                allowed = True
            except (BlockedURL, OSError):
                allowed = False
            except Exception:  # noqa: BLE001 - fail closed on anything unexpected
                allowed = False
            if len(self._cache) < self._max_entries:
                self._cache[(host, port)] = allowed
        if not allowed:
            self.blocked_hosts.add(host)
        return allowed
