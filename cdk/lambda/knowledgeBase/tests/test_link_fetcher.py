"""
Unit tests for helpers/link_fetcher.py against a scripted fake web (no network).

Run from the knowledgeBase dir:

    pytest tests
"""

import gzip
import http.client
import socket
import unittest

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers.link_fetcher import HTML, PDF, FetchError, FetchLimits, LinkFetcher  # noqa: E402

PAGE = b"<!doctype html><html><head><title>Hi</title></head><body><p>Hello world</p></body></html>"
ROBOTS_404 = (404, {}, b"")


class FakeResponse:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = http.client.HTTPMessage()
        for k, v in headers.items():
            self.headers[k] = v
        self._body = body

    def read(self, n):
        chunk, self._body = self._body[:n], self._body[n:]
        return chunk


class FakeWeb:
    """routes: {url: (status, headers, body) | Exception}; hosts: {host: [ips]}."""

    def __init__(self, routes, hosts):
        self.routes = routes
        self.hosts = hosts
        self.requests = []   # (url, ip)

    def resolver(self, host, port, type=None):  # noqa: A002
        if host not in self.hosts:
            raise socket.gaierror("unknown host")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in self.hosts[host]]

    def connection_factory(self, scheme, host, ip, port, timeout):
        web = self

        class Conn:
            def request(self, method, target, headers=None):
                default = 443 if scheme == "https" else 80
                netloc = host if port == default else f"{host}:{port}"
                self.url = f"{scheme}://{netloc}{target}"
                self.headers = headers
                web.requests.append((self.url, ip, headers))

            def getresponse(self):
                route = web.routes.get(self.url)
                if route is None:
                    return FakeResponse(404, {}, b"")
                if isinstance(route, Exception):
                    raise route
                return FakeResponse(*route)

            def close(self):
                pass

        return Conn()


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


def make_fetcher(routes, hosts=None, limits=None):
    web = FakeWeb(routes, hosts or {"example.com": ["93.184.216.34"]})
    clock = FakeClock()
    fetcher = LinkFetcher(
        limits or FetchLimits(per_domain_delay=0.0),
        resolver=web.resolver,
        connection_factory=web.connection_factory,
        clock=clock.clock,
        sleep=clock.sleep,
    )
    return fetcher, web, clock


class FetchSuccessTests(unittest.TestCase):
    def test_html_page(self):
        fetcher, web, _ = make_fetcher({
            "https://example.com/robots.txt": ROBOTS_404,
            "https://example.com/page": (200, {"Content-Type": "text/html; charset=utf-8"}, PAGE),
        })
        result = fetcher.fetch("https://Example.com/page#section")
        self.assertEqual(result.content_type, HTML)
        self.assertEqual(result.charset, "utf-8")
        self.assertEqual(result.body, PAGE)
        self.assertEqual(result.url, "https://example.com/page")
        # Connected to the vetted address, with our user agent.
        url, ip, headers = web.requests[-1]
        self.assertEqual(ip, "93.184.216.34")
        self.assertIn("KnowledgeCompassBot", headers["User-Agent"])

    def test_pdf_and_sniffed_pdf(self):
        pdf = b"%PDF-1.4 ..."
        fetcher, _, _ = make_fetcher({
            "https://example.com/robots.txt": ROBOTS_404,
            "https://example.com/a.pdf": (200, {"Content-Type": "application/pdf"}, pdf),
            "https://example.com/download": (200, {"Content-Type": "application/octet-stream"}, pdf),
        })
        self.assertEqual(fetcher.fetch("https://example.com/a.pdf").content_type, PDF)
        self.assertEqual(fetcher.fetch("https://example.com/download").content_type, PDF)

    def test_gzip_body_is_decoded(self):
        fetcher, _, _ = make_fetcher({
            "https://example.com/robots.txt": ROBOTS_404,
            "https://example.com/z": (200, {"Content-Type": "text/html", "Content-Encoding": "gzip"}, gzip.compress(PAGE)),
        })
        self.assertEqual(fetcher.fetch("https://example.com/z").body, PAGE)

    def test_follows_redirect_to_public_host(self):
        fetcher, _, _ = make_fetcher(
            {
                "https://example.com/robots.txt": ROBOTS_404,
                "https://other.org/robots.txt": ROBOTS_404,
                "https://example.com/old": (301, {"Location": "https://other.org/new"}, b""),
                "https://other.org/new": (200, {"Content-Type": "text/html"}, PAGE),
            },
            hosts={"example.com": ["93.184.216.34"], "other.org": ["93.184.216.99"]},
        )
        self.assertEqual(fetcher.fetch("https://example.com/old").url, "https://other.org/new")


class SsrfTests(unittest.TestCase):
    def test_host_resolving_to_private_ip_is_never_contacted(self):
        fetcher, web, _ = make_fetcher({}, hosts={"internal.example": ["10.0.0.12"]})
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch("http://internal.example/admin")
        self.assertTrue(ctx.exception.permanent)
        self.assertIn("blocked", ctx.exception.reason)
        self.assertEqual(web.requests, [])

    def test_ip_literal_metadata_endpoint_blocked(self):
        fetcher, web, _ = make_fetcher({})
        for url in ("http://169.254.169.254/latest/meta-data/", "http://169.254.170.2/v2/credentials",
                    "http://127.0.0.1:9001/2018-06-01/runtime/invocation/next", "http://[::1]/"):
            with self.subTest(url=url), self.assertRaises(FetchError) as ctx:
                fetcher.fetch(url)
            self.assertIn("blocked", ctx.exception.reason)
        self.assertEqual(web.requests, [])

    def test_redirect_to_private_address_blocked(self):
        fetcher, web, _ = make_fetcher(
            {
                "https://example.com/robots.txt": ROBOTS_404,
                "https://example.com/go": (302, {"Location": "http://sneaky.example/"}, b""),
            },
            hosts={"example.com": ["93.184.216.34"], "sneaky.example": ["192.168.0.10"]},
        )
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch("https://example.com/go")
        self.assertTrue(ctx.exception.permanent)
        self.assertIn("blocked", ctx.exception.reason)
        self.assertFalse(any(ip == "192.168.0.10" for _, ip, _ in web.requests))

    def test_redirect_to_ip_literal_and_non_http_blocked(self):
        for location in ("http://169.254.169.254/latest/", "file:///etc/passwd", "ftp://example.com/x"):
            fetcher, _, _ = make_fetcher({
                "https://example.com/robots.txt": ROBOTS_404,
                "https://example.com/go": (302, {"Location": location}, b""),
            })
            with self.subTest(location=location), self.assertRaises(FetchError) as ctx:
                fetcher.fetch("https://example.com/go")
            self.assertTrue(ctx.exception.permanent)

    def test_non_http_scheme_rejected(self):
        fetcher, _, _ = make_fetcher({})
        with self.assertRaises(FetchError):
            fetcher.fetch("file:///etc/passwd")


class RobotsTests(unittest.TestCase):
    def test_disallowed_path_not_fetched(self):
        fetcher, web, _ = make_fetcher({
            "https://example.com/robots.txt": (200, {"Content-Type": "text/plain"},
                                               b"User-agent: *\nDisallow: /private/\n"),
            "https://example.com/private/x": (200, {"Content-Type": "text/html"}, PAGE),
        })
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch("https://example.com/private/x")
        self.assertIn("robots.txt", ctx.exception.reason)
        self.assertTrue(ctx.exception.permanent)
        self.assertNotIn("https://example.com/private/x", [u for u, _, _ in web.requests])

    def test_agent_specific_rules(self):
        fetcher, _, _ = make_fetcher({
            "https://example.com/robots.txt": (200, {}, b"User-agent: KnowledgeCompassBot\nDisallow: /\n"),
        })
        with self.assertRaises(FetchError):
            fetcher.fetch("https://example.com/anything")

    def test_robots_fetched_once_per_origin(self):
        fetcher, web, _ = make_fetcher({
            "https://example.com/robots.txt": ROBOTS_404,
            "https://example.com/a": (200, {"Content-Type": "text/html"}, PAGE),
            "https://example.com/b": (200, {"Content-Type": "text/html"}, PAGE),
        })
        fetcher.fetch("https://example.com/a")
        fetcher.fetch("https://example.com/b")
        self.assertEqual([u for u, _, _ in web.requests].count("https://example.com/robots.txt"), 1)

    def test_robots_server_error_disallows_transiently(self):
        fetcher, _, _ = make_fetcher({"https://example.com/robots.txt": (503, {}, b"")})
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch("https://example.com/a")
        self.assertFalse(ctx.exception.permanent)

    def test_crawl_delay_is_respected(self):
        fetcher, _, clock = make_fetcher(
            {
                "https://example.com/robots.txt": (200, {}, b"User-agent: *\nCrawl-delay: 3\n"),
                "https://example.com/a": (200, {"Content-Type": "text/html"}, PAGE),
                "https://example.com/b": (200, {"Content-Type": "text/html"}, PAGE),
            },
            limits=FetchLimits(per_domain_delay=1.0),
        )
        fetcher.fetch("https://example.com/a")
        fetcher.fetch("https://example.com/b")
        # robots (1s default) -> /a waits 1s -> /b waits the 3s crawl delay.
        self.assertEqual(clock.sleeps, [1.0, 3.0])


class FailureTests(unittest.TestCase):
    def fetch_error(self, route, url="https://example.com/x", limits=None):
        fetcher, _, _ = make_fetcher({"https://example.com/robots.txt": ROBOTS_404, url: route}, limits=limits)
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch(url)
        return ctx.exception

    def test_dead_links_are_permanent(self):
        for status in (404, 410, 400):
            err = self.fetch_error((status, {}, b""))
            self.assertTrue(err.permanent)
            self.assertEqual(err.http_status, status)

    def test_auth_required_is_permanent(self):
        err = self.fetch_error((401, {}, b""))
        self.assertTrue(err.permanent)
        self.assertIn("authenticated", err.reason)

    def test_server_errors_and_timeouts_are_transient(self):
        self.assertFalse(self.fetch_error((503, {}, b"")).permanent)
        self.assertFalse(self.fetch_error((429, {}, b"")).permanent)
        self.assertFalse(self.fetch_error(socket.timeout("slow")).permanent)
        self.assertFalse(self.fetch_error(ConnectionResetError("reset")).permanent)

    def test_unsupported_content_types_skipped(self):
        err = self.fetch_error((200, {"Content-Type": "image/png"}, b"\x89PNG"))
        self.assertTrue(err.permanent)
        self.assertIn("unsupported content type", err.reason)
        err = self.fetch_error((200, {"Content-Type": "application/octet-stream"}, b"\x00\x01binary"))
        self.assertIn("unsupported content type", err.reason)

    def test_size_limits(self):
        limits = FetchLimits(per_domain_delay=0.0, max_bytes=1000)
        declared = self.fetch_error((200, {"Content-Type": "text/html", "Content-Length": "5000"}, b""), limits=limits)
        self.assertIn("larger than", declared.reason)
        streamed = self.fetch_error((200, {"Content-Type": "text/html"}, b"<html>" + b"x" * 5000), limits=limits)
        self.assertIn("larger than", streamed.reason)
        bomb = self.fetch_error(
            (200, {"Content-Type": "text/html", "Content-Encoding": "gzip"}, gzip.compress(b"x" * 100_000)),
            limits=limits,
        )
        self.assertIn("larger than", bomb.reason)

    def test_redirect_loop(self):
        fetcher, _, _ = make_fetcher({
            "https://example.com/robots.txt": ROBOTS_404,
            "https://example.com/loop": (302, {"Location": "/loop"}, b""),
        })
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch("https://example.com/loop")
        self.assertIn("redirects", ctx.exception.reason)

    def test_unresolvable_host(self):
        fetcher, _, _ = make_fetcher({}, hosts={})
        with self.assertRaises(FetchError) as ctx:
            fetcher.fetch("https://gone.example/")
        self.assertTrue(ctx.exception.permanent)


if __name__ == "__main__":
    unittest.main()
