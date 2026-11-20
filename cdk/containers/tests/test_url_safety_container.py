"""
SSRF guard in the crawler container: common/url_safety.py (mirror of the
Lambda helpers/url_safety.py) and the crawler's seed / request guards. DNS and
Playwright are faked; no network. Run from cdk/:

    py -3 -m unittest discover -s containers/tests -p "test_url_safety_container.py" -v
"""

import asyncio
import importlib.util
import os
import socket
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from test_embed_wiring import _load  # noqa: E402

_CONTAINERS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_LAMBDA_URL_SAFETY = os.path.abspath(
    os.path.join(_CONTAINERS, "..", "lambda", "knowledgeBase", "helpers", "url_safety.py")
)


def _load_path(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


container_safety = _load_path("kc_container_url_safety", os.path.join(_CONTAINERS, "common", "url_safety.py"))
lambda_safety = _load_path("kc_lambda_url_safety", _LAMBDA_URL_SAFETY)

DNS = {
    "example.org": ["93.184.216.34"],
    "internal.example.org": ["10.0.0.5"],
    "linklocal.example.org": ["169.254.170.2"],
    "mixed.example.org": ["93.184.216.34", "192.168.1.4"],
}


def _infos(host, port):
    if host not in DNS:
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]]


def sync_resolver(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    return _infos(host, port)


class AsyncResolver:
    def __init__(self):
        self.calls = []

    async def __call__(self, host, port, *, type=None):  # noqa: A002
        self.calls.append(host)
        return _infos(host, port)


UNSAFE = (
    "file:///etc/passwd",
    "http://169.254.170.2/v2/credentials",
    "http://127.0.0.1/",
    "http://10.2.3.4/",
    "http://user:pass@example.org/",
    "ftp://example.org/",
    "chrome://settings",
    "data:text/html,x",
    "https://internal.example.org/",
)


class ContainerUrlSafetyTests(unittest.TestCase):
    def test_check_public_url(self):
        for url in UNSAFE:
            with self.subTest(url=url), self.assertRaises(ValueError):
                container_safety.check_public_url(url, resolver=sync_resolver)
        self.assertEqual(
            container_safety.check_public_url("https://example.org", resolver=sync_resolver),
            "https://example.org/",
        )

    def test_is_crawlable_url_needs_no_dns(self):
        with mock.patch("socket.getaddrinfo", side_effect=AssertionError("no DNS")):
            for url in ("http://169.254.169.254/", "http://[::ffff:127.0.0.1]/", "file:///x",
                        "mailto:a@b.c", None):
                with self.subTest(url=url):
                    self.assertFalse(container_safety.is_crawlable_url(url))
            self.assertTrue(container_safety.is_crawlable_url("https://example.org/page"))

    def test_public_host_checker(self):
        resolver = AsyncResolver()
        checker = container_safety.PublicHostChecker(resolver=resolver)

        async def scenario():
            return {
                url: await checker.allows(url)
                for url in (
                    "https://example.org/a",
                    "https://example.org/b",
                    "https://internal.example.org/",
                    "https://linklocal.example.org/",
                    "https://mixed.example.org/",
                    "https://unknown.invalid/",
                    "http://169.254.170.2/v2/credentials",
                    "file:///etc/passwd",
                )
            }

        verdicts = asyncio.run(scenario())
        self.assertTrue(verdicts["https://example.org/a"])
        self.assertTrue(verdicts["https://example.org/b"])
        for url, allowed in verdicts.items():
            if "://example.org" not in url:
                with self.subTest(url=url):
                    self.assertFalse(allowed)
        self.assertEqual(resolver.calls.count("example.org"), 1)  # cached
        self.assertNotIn("169.254.170.2", resolver.calls)  # IP literal, no DNS
        self.assertIn("internal.example.org", checker.blocked_hosts)


class ParityWithLambdaTests(unittest.TestCase):
    def test_normalize_url_parity(self):
        for raw in (
            "https://example.org", "  HTTPS://Example.COM:443/Some Path?q=a b#frag ",
            "http://example.com:8080/x", "https://example.com:22/", "file:///etc/passwd",
            "https://bücher.example/", "http://[::1]/", "http://[::ffff:10.0.0.1]:8443/",
            "https://user:pw@example.org/", "javascript:alert(1)", "", "http://", "http://[bad/",
            "https://example.com/" + "a" * 2100, "gopher://x",
        ):
            with self.subTest(raw=raw):
                results = []
                for module in (container_safety, lambda_safety):
                    try:
                        results.append(module.normalize_url(raw))
                    except ValueError as e:
                        results.append(type(e).__name__)
                self.assertEqual(results[0], results[1])

    def test_is_public_ip_and_ports_parity(self):
        for ip in ("10.0.0.5", "127.0.0.1", "169.254.170.2", "100.64.0.1", "::1", "fe80::1",
                   "::ffff:10.0.0.1", "64:ff9b::a00:1", "93.184.216.34", "2606:4700:4700::1111"):
            with self.subTest(ip=ip):
                self.assertEqual(container_safety.is_public_ip(ip), lambda_safety.is_public_ip(ip))
        self.assertEqual(container_safety.ALLOWED_PORTS, lambda_safety.ALLOWED_PORTS)


class FakeRoute:
    def __init__(self, url):
        self.request = mock.Mock(url=url)
        self.outcome = None

    async def continue_(self):
        self.outcome = "continue"

    async def abort(self, error_code=None):
        self.outcome = ("abort", error_code)


class FakeContext:
    def __init__(self):
        self.routes = []

    async def route(self, pattern, handler):
        self.routes.append((pattern, handler))


class FakePage:
    """A page whose own route() must not be used: the guard belongs on the context."""

    def __init__(self, context):
        self.context = context

    async def route(self, pattern, handler):
        raise AssertionError("guard must be installed on the BrowserContext, not the page")


class FakeRequest:
    def __init__(self, url):
        self.url = url
        self.no_retry = False


class FakeCtx:
    def __init__(self, page, url):
        self.page = page
        self.request = FakeRequest(url)


class CrawlerGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load("kc_crawler_url_safety_under_test", "crawler/crawler.py")

    def checker(self):
        return self.mod.url_safety.PublicHostChecker(resolver=AsyncResolver())

    def test_guard_route(self):
        checker = self.checker()
        for url, expected in (
            ("http://169.254.170.2/v2/credentials", ("abort", "blockedbyclient")),
            ("https://internal.example.org/x.js", ("abort", "blockedbyclient")),
            ("https://example.org/app.js", "continue"),
        ):
            with self.subTest(url=url):
                route = FakeRoute(url)
                asyncio.run(self.mod.guard_route(route, checker))
                self.assertEqual(route.outcome, expected)

    def test_guard_navigation(self):
        import weakref

        checker = self.checker()
        guarded = weakref.WeakSet()
        context = FakeContext()
        page = FakePage(context)
        second_page = FakePage(context)  # e.g. a later page or popup in the same context

        asyncio.run(self.mod.guard_navigation(FakeCtx(page, "https://example.org/"), checker, guarded))
        asyncio.run(self.mod.guard_navigation(FakeCtx(second_page, "https://example.org/b"), checker, guarded))
        blocked = FakeCtx(page, "http://10.0.0.1/")
        with self.assertRaises(self.mod.UnsafeRequestURL):
            asyncio.run(self.mod.guard_navigation(blocked, checker, guarded))
        self.assertTrue(blocked.request.no_retry)
        self.assertEqual(len(context.routes), 1)  # installed once per BrowserContext
        self.assertEqual(context.routes[0][0], "**/*")

        # A new context (e.g. incognito page) gets its own route.
        other_context = FakeContext()
        asyncio.run(self.mod.guard_navigation(
            FakeCtx(FakePage(other_context), "https://example.org/"), checker, guarded))
        self.assertEqual(len(other_context.routes), 1)
        self.assertEqual(len(context.routes), 1)

        # The installed handler routes through guard_route, so a popup to the
        # task metadata endpoint is aborted.
        route = FakeRoute("http://169.254.170.2/v2/credentials")
        asyncio.run(context.routes[0][1](route))
        self.assertEqual(route.outcome, ("abort", "blockedbyclient"))

    def test_enqueue_filter(self):
        self.assertEqual(self.mod.enqueue_filter({"url": "file:///etc/passwd"}), "skip")
        self.assertEqual(self.mod.enqueue_filter({"url": "http://127.0.0.1/"}), "skip")
        options = {"url": "https://example.org/next"}
        self.assertIs(self.mod.enqueue_filter(options), options)

    def test_validate_seed_url(self):
        for url in ("file:///etc/passwd", "http://169.254.170.2/", "http://127.0.0.1", "http://10.1.1.1/",
                    "http://user:pass@example.org/", "gopher://x", "https://unknown.invalid/"):
            with self.subTest(url=url), self.assertRaises(self.mod.UnsafeSeedURL):
                self.mod.validate_seed_url(url, resolver=sync_resolver)
        self.assertIsNone(self.mod.validate_seed_url("https://example.org", resolver=sync_resolver))

    def test_main_refuses_unsafe_seed_before_any_work(self):
        env = {"SEED_URL": "http://169.254.170.2/v2/credentials", "WRITE_DB": "true"}
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(sys, "argv", ["crawler.py"]), \
                mock.patch.object(self.mod, "crawl") as crawl, \
                mock.patch.object(self.mod, "init_active_space") as init_space, \
                mock.patch.object(self.mod.asyncio, "run") as run, \
                mock.patch.object(self.mod, "write_to_db") as write:
            with self.assertRaises(self.mod.UnsafeSeedURL):
                self.mod.main()
        crawl.assert_not_called()
        init_space.assert_not_called()
        run.assert_not_called()
        write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
