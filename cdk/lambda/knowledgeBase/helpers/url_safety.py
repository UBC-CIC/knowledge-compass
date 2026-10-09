"""
url_safety.py

URL normalization and SSRF guards for links fetched from CSV rows (see
link_fetcher.py). The knowledge base Lambda runs inside the VPC, next to RDS
Proxy and the VPC endpoints, so a CSV must never be able to make it fetch an
internal address:

- only http/https URLs, with no embedded credentials, are accepted;
- only common web ports are accepted, so a CSV row or redirect cannot make the
  Lambda probe arbitrary TCP services (SSH, SMTP, ...) on public hosts;
- every address a host resolves to must be publicly routable, otherwise the
  URL is rejected (a host resolving to both a public and a private address is
  rejected too);
- the fetcher connects to the address vetted here, not to a second DNS lookup,
  so a DNS answer cannot change between the check and the connection; every
  redirect hop is normalized and vetted again.
"""

import ipaddress
import socket
from urllib.parse import quote, urlsplit, urlunsplit

# Longest normalized URL accepted; 'csvlink://' + this still fits sources.url (varchar 2048).
MAX_URL_LENGTH = 2000

_DEFAULT_PORTS = {"http": 80, "https": 443}
# Destination ports a link may use. Every fetch and redirect hop is normalized
# here, so this bounds where the in-VPC fetcher can open connections.
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
    Canonical form used to dedupe links: lowercase scheme and host, IDNA host,
    default port dropped, empty path -> '/', fragment removed, path/query
    percent-encoded. Raises InvalidURL.
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


def normalize_citation_url(raw: str) -> str:
    """
    Normalize a public HTTP(S) citation while preserving its fragment/deep link.

    Fetch identity deliberately drops fragments because they are not sent to
    servers. Citation identity keeps them so two rows can link users to
    different sections or PDF pages of the same fetched resource.
    """
    value = (raw or "").strip()
    try:
        parts = urlsplit(value)
    except ValueError as error:
        raise InvalidURL(f"malformed URL: {error}") from error
    normalized = normalize_url(value)
    fragment = quote(parts.fragment, safe=_QUERY_SAFE)
    citation = f"{normalized}#{fragment}" if fragment else normalized
    if len(citation) > MAX_URL_LENGTH:
        raise InvalidURL(f"URL is longer than {MAX_URL_LENGTH} characters")
    return citation


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
