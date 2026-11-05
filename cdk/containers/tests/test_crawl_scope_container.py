"""
Website include/exclude patterns are enforced by the crawler (finding
f-fd9e37e5): an excluded URL, or one outside the include patterns, is never
enqueued, navigated to or stored, whether it is the seed, a discovered link or
the place a redirect ended up. Playwright and DNS are faked; no network.
Run from cdk/:

    py -3 -m unittest discover -s containers/tests -p "test_crawl_scope_container.py" -v
"""

import asyncio
import importlib.util
import json
import os
import socket
import sys
import unittest
import weakref
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from test_embed_wiring import _load  # noqa: E402

_CONTAINERS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_LAMBDA_SCOPE = os.path.abspath(
    os.path.join(_CONTAINERS, "..", "lambda", "knowledgeBase", "helpers", "crawl_scope.py")
)
_CONTAINER_SCOPE = os.path.join(_CONTAINERS, "common", "crawl_scope.py")

INCLUDE = [r"^https://example\.org/science/"]
EXCLUDE = [r"^https://example\.org/science/private/"]
SCOPE_ENV = {
    "CRAWL_INCLUDE_PATTERNS": json.dumps(INCLUDE),
    "CRAWL_EXCLUDE_PATTERNS": json.dumps(EXCLUDE),
}

DNS = {"example.org": ["93.184.216.34"]}


def _infos(host, port):
    if host not in DNS:
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]]


class AsyncResolver:
    async def __call__(self, host, port, *, type=None):  # noqa: A002
        return _infos(host, port)


def sync_resolver(host, port, type=None, *args, **kwargs):  # noqa: A002
    return _infos(host, port)


class FakeRoute:
    def __init__(self, url, navigation):
        self.request = mock.Mock(url=url)
        self.request.is_navigation_request.return_value = navigation
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


class FakeRequest:
    def __init__(self, url):
        self.url = url
        self.no_retry = False


class FakeCtx:
    def __init__(self, url):
        self.page = mock.Mock(context=FakeContext())
        self.request = FakeRequest(url)


class CrawlerScopeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load("kc_crawler_scope_under_test", "crawler/crawler.py")

    def scope(self):
        return self.mod.crawl_scope.CrawlScope.from_patterns(INCLUDE, EXCLUDE)

    def checker(self):
        return self.mod.url_safety.PublicHostChecker(resolver=AsyncResolver())

    def test_discovered_links_outside_the_patterns_are_not_enqueued(self):
        scope = self.scope()
        for url in (
            "https://example.org/science/private/roster",
            "https://example.org/science/%70rivate/roster",
            "https://example.org/arts/",
        ):
            with self.subTest(url=url):
                self.assertEqual(self.mod.enqueue_filter({"url": url}, scope), "skip")
        options = {"url": "https://example.org/science/biology"}
        self.assertIs(self.mod.enqueue_filter(options, scope), options)
        # SSRF filtering still applies inside the include patterns.
        self.assertEqual(self.mod.enqueue_filter({"url": "http://127.0.0.1/science/"}, scope), "skip")

    def test_navigation_outside_the_patterns_is_refused(self):
        scope = self.scope()
        blocked = FakeCtx("https://example.org/science/private/roster")
        with self.assertRaises(self.mod.OutOfScopeURL):
            asyncio.run(self.mod.guard_navigation(blocked, self.checker(), weakref.WeakSet(), scope))
        self.assertTrue(blocked.request.no_retry)
        allowed = FakeCtx("https://example.org/science/biology")
        asyncio.run(self.mod.guard_navigation(allowed, self.checker(), weakref.WeakSet(), scope))

    def test_document_requests_outside_the_patterns_are_aborted(self):
        scope = self.scope()
        cases = (
            ("https://example.org/science/private/frame", True, ("abort", "blockedbyclient")),
            ("https://example.org/science/biology", True, "continue"),
            # Subresources of an in-scope page (scripts, images) are not page URLs.
            ("https://example.org/assets/app.js", False, "continue"),
        )
        for url, navigation, expected in cases:
            with self.subTest(url=url):
                route = FakeRoute(url, navigation)
                asyncio.run(self.mod.guard_route(route, self.checker(), scope))
                self.assertEqual(route.outcome, expected)

    def test_redirect_into_an_excluded_url_is_not_stored(self):
        scope = self.scope()
        checker = self.checker()
        accepted = asyncio.run(
            self.mod.final_url_allowed("https://example.org/science/private/roster", checker, scope))
        self.assertFalse(accepted)
        self.assertFalse(asyncio.run(self.mod.final_url_allowed("https://example.org/arts/", checker, scope)))
        self.assertFalse(asyncio.run(self.mod.final_url_allowed("http://10.0.0.1/science/", checker, scope)))
        self.assertTrue(asyncio.run(self.mod.final_url_allowed("https://example.org/science/a", checker, scope)))

    def run_main(self, env):
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(sys, "argv", ["crawler.py"]), \
                mock.patch("socket.getaddrinfo", sync_resolver), \
                mock.patch.object(self.mod, "init_active_space", return_value=None) as init_space, \
                mock.patch.object(self.mod, "crawl", new_callable=mock.Mock) as crawl, \
                mock.patch.object(self.mod.asyncio, "run", return_value=([], set())) as run, \
                mock.patch.object(self.mod, "write_to_db") as write, \
                mock.patch("builtins.open", mock.mock_open()):
            self.mocks = {"crawl": crawl, "init_space": init_space, "run": run, "write": write}
            self.mod.main()

    def assert_no_work(self):
        for name, called in self.mocks.items():
            with self.subTest(mock=name):
                called.assert_not_called()

    def test_main_passes_the_patterns_from_the_task_env_to_the_crawl(self):
        self.run_main({"SEED_URL": "https://example.org/science/", **SCOPE_ENV})
        scope = self.mocks["crawl"].call_args.kwargs["scope"]
        self.assertEqual(scope.include_patterns, INCLUDE)
        self.assertEqual(scope.exclude_patterns, EXCLUDE)

    def test_main_refuses_a_seed_outside_its_patterns_before_any_work(self):
        for seed in ("https://example.org/", "https://example.org/science/private/"):
            with self.subTest(seed=seed):
                with self.assertRaises(self.mod.CrawlScopeRejected):
                    self.run_main({"SEED_URL": seed, **SCOPE_ENV})
                self.assert_no_work()

    def test_main_refuses_malformed_patterns_before_any_work(self):
        env = {"SEED_URL": "https://example.org/science/", "CRAWL_EXCLUDE_PATTERNS": '["[unclosed"]'}
        with self.assertRaises(self.mod.CrawlScopeRejected) as caught:
            self.run_main(env)
        self.assert_no_work()
        self.assertIn("exclude_patterns[0]", str(caught.exception))


class ParityWithLambdaTests(unittest.TestCase):
    def test_container_and_lambda_copies_are_identical(self):
        with open(_CONTAINER_SCOPE, encoding="utf-8") as a, open(_LAMBDA_SCOPE, encoding="utf-8") as b:
            self.assertEqual(a.read(), b.read())


if __name__ == "__main__":
    unittest.main()
