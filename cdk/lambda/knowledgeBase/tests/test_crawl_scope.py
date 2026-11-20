"""
Website include/exclude patterns (finding f-fd9e37e5): the pattern rules
(helpers/crawl_scope.py), and the crawler task is launched with the patterns
of the data source, for a first crawl and for a re-crawl alike. Staging is
covered by test_stage_website_patterns.py. DNS and ECS are faked; no network.

Run from the knowledgeBase dir:

    python -m unittest discover -s tests -p "test_crawl_scope.py" -v
"""

import json
import socket
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import crawl_scope  # noqa: E402
from helpers import process_crawler_batch as batch  # noqa: E402

DNS = {"example.org": ["93.184.216.34"]}

INCLUDE = [r"^https://example\.org/science/"]
EXCLUDE = [r"^https://example\.org/science/private/"]


def fake_getaddrinfo(host, port, type=None, *args, **kwargs):  # noqa: A002 - mirrors socket.getaddrinfo
    if host not in DNS:
        raise socket.gaierror("unknown host")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in DNS[host]]


class CrawlScopeMatchingTests(unittest.TestCase):
    def test_exclude_wins_and_include_restricts(self):
        scope = crawl_scope.CrawlScope.from_patterns(INCLUDE, EXCLUDE)
        self.assertTrue(scope.allows("https://example.org/science/biology"))
        self.assertFalse(scope.allows("https://example.org/science/private/roster"))
        self.assertFalse(scope.allows("https://example.org/arts/"))
        self.assertFalse(scope.allows(None))

    def test_no_patterns_allows_everything(self):
        scope = crawl_scope.CrawlScope.from_patterns([], [])
        self.assertTrue(scope.unrestricted)
        self.assertTrue(scope.allows("https://example.org/anything"))

    def test_exclude_cannot_be_dodged_by_spelling_the_url_differently(self):
        scope = crawl_scope.CrawlScope.from_patterns([], EXCLUDE)
        for url in (
            "https://example.org/science/private/a",
            "HTTPS://EXAMPLE.ORG/science/private/a",
            "https://example.org:443/science/private/a",
            "https://example.org./science/private/a",
            "https://example.org/science//private/a",
            "https://example.org/science/./private/a",
            "https://example.org/science/x/../private/a",
            "https://example.org/science/%70rivate/a",
            "https://example.org/science/%2e/private/a",
            "https://example.org/science/private/a#frag",
        ):
            with self.subTest(url=url):
                self.assertFalse(scope.allows(url))
        self.assertTrue(scope.allows("https://example.org/science/public/a"))

    # scan-b594378e f-29b5b14f: encoded separators, double encoding, backslashes
    # and userinfo must not dodge the patterns.
    def test_encoded_separators_and_double_encoding_cannot_dodge_exclude(self):
        scope = crawl_scope.CrawlScope.from_patterns([], EXCLUDE)
        for url in (
            "https://example.org/science/a/b/..%2F..%2Fprivate/x",
            "https://example.org/science/a/..%2fprivate/x",
            "https://example.org/science/a/%252E%252E/private/x",
            "https://example.org/science/a/%25252e%25252e/private/x",
            "https://example.org/science%2Fprivate%2Fx",
            "https://example.org/science\\private\\x",
            "https://example.org/science/a/..\\private/x",
            "https://example.org/science/a/..%5Cprivate/x",
            "https://example.org/science/a/..%255Cprivate/x",
            "https://ExAmple.ORG/science/private/x",
        ):
            with self.subTest(url=url):
                self.assertFalse(scope.allows(url))
        self.assertTrue(scope.allows("https://example.org/science/public/x"))

    def test_exclude_also_matches_the_fully_decoded_spelling(self):
        scope = crawl_scope.CrawlScope.from_patterns([], [r"/private file/"])
        self.assertFalse(scope.allows("https://example.org/private%20file/x"))
        self.assertFalse(scope.allows("https://example.org/private%2520file/x"))
        self.assertTrue(scope.allows("https://example.org/public%20file/x"))

    def test_include_matches_the_canonical_spelling_only(self):
        scope = crawl_scope.CrawlScope.from_patterns([r"^https://example\.com/docs/"], [])
        self.assertFalse(scope.allows("https://example.com/docs/../private/x"))
        self.assertFalse(scope.allows("https://example.com/docs/..%2Fprivate/x"))
        self.assertFalse(scope.allows("https://example.com/docs/%252E%252E/private/x"))
        self.assertTrue(scope.allows("https://example.com/docs/a"))
        self.assertTrue(scope.allows("https://EXAMPLE.COM/docs/a"))

    def test_userinfo_urls_are_refused(self):
        scope = crawl_scope.CrawlScope.from_patterns([r"^https://example\.com"], [])
        self.assertFalse(scope.allows("https://example.com@evil.com/x"))
        self.assertFalse(scope.allows("https://user:pw@example.com/x"))
        self.assertFalse(crawl_scope.CrawlScope().allows("https://user@example.com/x"))
        self.assertTrue(scope.allows("https://example.com/x"))

    def test_canonical_url(self):
        self.assertEqual(crawl_scope.canonical_url("https://EXAMPLE.com:443/a/b/..%2Fc"), "https://example.com/a/c")
        self.assertEqual(crawl_scope.canonical_url("https://example.com/a\\b/%7Ex%20y"), "https://example.com/a/b/~x%20y")
        self.assertIsNone(crawl_scope.canonical_url("https://user@example.com/"))

    def test_urls_whose_encoding_does_not_settle_are_refused(self):
        scope = crawl_scope.CrawlScope.from_patterns([], EXCLUDE)
        # Five levels of encoding; MAX_DECODE_ROUNDS allows three.
        deep = "https://example.org/science/a/%252525252E%252525252E/private/x"
        self.assertIsNone(crawl_scope.canonical_url(deep))
        self.assertFalse(scope.allows(deep))

    def test_overlong_urls_are_refused_when_patterns_exist(self):
        scope = crawl_scope.CrawlScope.from_patterns([], EXCLUDE)
        url = "https://example.org/science/" + "a" * crawl_scope.MAX_URL_LENGTH
        self.assertFalse(scope.allows(url))
        self.assertTrue(crawl_scope.CrawlScope().allows(url))

    # scan-b594378e f-a21a67ce: patterns that can backtrack catastrophically are rejected.
    def test_catastrophic_patterns_are_rejected(self):
        for pattern in (
            r"^(a+)+$",
            r"(a*)*",
            r"(?:a+){2,}",
            r"(a|aa)+",
            r"(?:news|events)*/x",
            r"(a)\1",
            r"(?P<n>a)(?P=n)",
            r"(a)?(?(1)b|c)",
            r".*.*.*x",
            r".*a.*b",
            r"(a|aa)(a|aa)(a|aa)(a|aa)(a|aa)(a|aa)(a|aa)x",
            r"a?a?a?a?a?a?a?a?a?a?.*x",
        ):
            for field in ("include_patterns", "exclude_patterns"):
                args = ([pattern], []) if field == "include_patterns" else ([], [pattern])
                with self.subTest(pattern=pattern, field=field), \
                        self.assertRaises(crawl_scope.InvalidPatterns) as caught:
                    crawl_scope.CrawlScope.from_patterns(*args)
                self.assertIn(f"{field}[0]", str(caught.exception))

    def test_common_patterns_are_still_accepted(self):
        patterns = [
            r"^https://example\.org/science/",
            r"^https?://(?:www\.)?example\.org/.*",
            r"/private/",
            r"\.pdf$",
            r"/docs/.*\.pdf$",
            r"(?i)/news/\d+/",
            r"^https://example\.org/[^/]+/archive/.*",
            r"/(?:news|events|blog)/",
            r"^https://example\.org/item/\d{4}/",
        ]
        crawl_scope.CrawlScope.from_patterns(patterns, patterns)

    def test_accepted_patterns_match_long_urls_in_bounded_time(self):
        import time
        worst = [r"^.*.*x", r".*x", r"^a?a?a?a?.*.*x", r"(?:a|aa)(?:a|aa)(?:a|aa).*x"]
        scope = crawl_scope.CrawlScope.from_patterns([], worst)
        url = "https://example.org/" + "a" * (crawl_scope.MAX_URL_LENGTH - 30)
        started = time.monotonic()
        scope.allows(url)
        self.assertLess(time.monotonic() - started, 2.0)

    def test_invalid_patterns_are_rejected_with_admin_readable_errors(self):
        cases = (
            ("not-a-list", [], "include_patterns must be an array"),
            ([123], [], "include_patterns[0] must be a string"),
            ([""], [], "include_patterns[0] is empty"),
            (["  "], [], "include_patterns[0] is empty"),
            ([], ["[unclosed"], "exclude_patterns[0] is not a valid regular expression"),
            ([], ["ok", "(?P<x"], "exclude_patterns[1] is not a valid regular expression"),
            (["a" * (crawl_scope.MAX_PATTERN_LENGTH + 1)], [], "include_patterns[0] is longer than"),
            (["a"] * (crawl_scope.MAX_PATTERNS + 1), [], "include_patterns has more than"),
        )
        for include, exclude, message in cases:
            with self.subTest(message=message), self.assertRaises(crawl_scope.InvalidPatterns) as caught:
                crawl_scope.CrawlScope.from_patterns(include, exclude)
            self.assertIn(message, str(caught.exception))

    def test_patterns_that_would_overflow_the_task_overrides_are_rejected(self):
        many = ["\\." * (crawl_scope.MAX_PATTERN_LENGTH // 2)] * crawl_scope.MAX_PATTERNS
        with self.assertRaises(crawl_scope.InvalidPatterns) as caught:
            crawl_scope.CrawlScope.from_patterns(many, many)
        self.assertIn("too long in total", str(caught.exception))

    def test_env_round_trip(self):
        env = dict((e["name"], e["value"]) for e in crawl_scope.to_env(INCLUDE, EXCLUDE))
        scope = crawl_scope.from_env(env)
        self.assertEqual(scope.include_patterns, INCLUDE)
        self.assertEqual(scope.exclude_patterns, EXCLUDE)
        self.assertTrue(crawl_scope.from_env({}).unrestricted)
        with self.assertRaises(crawl_scope.InvalidPatterns):
            crawl_scope.from_env({crawl_scope.EXCLUDE_ENV: "{not json"})
        with self.assertRaises(crawl_scope.InvalidPatterns):
            crawl_scope.from_env({crawl_scope.EXCLUDE_ENV: json.dumps(["[bad"])})


class _LaunchBase(unittest.TestCase):
    def setUp(self):
        self.ecs = mock.Mock()
        self.ecs.run_task.return_value = {"tasks": [{"taskArn": "arn:task"}], "failures": []}
        for patcher in (
            mock.patch.object(batch, "ECS_CLUSTER_ARN", "arn:cluster"),
            mock.patch.object(batch, "CRAWLER_TASK_DEF_ARN", "arn:taskdef"),
            mock.patch.object(batch, "INGESTION_SUBNET_IDS", ["subnet-1"]),
            mock.patch.object(batch, "INGESTION_SECURITY_GROUP_IDS", ["sg-1"]),
            mock.patch.object(batch, "ecs_client", self.ecs),
            mock.patch("socket.getaddrinfo", fake_getaddrinfo),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.connection = mock.MagicMock()
        self.cursor = self.connection.cursor.return_value.__enter__.return_value

    def launched_env(self):
        overrides = self.ecs.run_task.call_args.kwargs["overrides"]
        return {e["name"]: e["value"] for e in overrides["containerOverrides"][0]["environment"]}

    def executed_sql(self):
        return [c.args for c in self.cursor.execute.call_args_list]


class CrawlerLaunchPatternTests(_LaunchBase):
    def run_batch(self, include, exclude, name="https://example.org/science/"):
        runs = [{
            "ingestion_run_id": "run-1",
            "data_source_id": "ds-1",
            "name": name,
            "type": "website",
            "include_patterns": include,
            "exclude_patterns": exclude,
            "data_source_metadata": {},
        }]
        with mock.patch.object(batch, "_latest_queued_runs", return_value=runs):
            return batch.process_crawler_batch({}, self.connection, "sync-1")

    def test_patterns_reach_the_crawler_task(self):
        result = self.run_batch(INCLUDE, EXCLUDE)
        self.assertEqual(result["launched_count"], 1, result)
        env = self.launched_env()
        self.assertEqual(json.loads(env[crawl_scope.INCLUDE_ENV]), INCLUDE)
        self.assertEqual(json.loads(env[crawl_scope.EXCLUDE_ENV]), EXCLUDE)
        self.assertLess(len(json.dumps(self.ecs.run_task.call_args.kwargs["overrides"])), 8192)

    def test_no_patterns_send_empty_lists(self):
        self.run_batch([], [])
        env = self.launched_env()
        self.assertEqual(json.loads(env[crawl_scope.INCLUDE_ENV]), [])
        self.assertEqual(json.loads(env[crawl_scope.EXCLUDE_ENV]), [])

    def test_invalid_stored_patterns_fail_the_run_without_launching(self):
        for include, exclude, name in (
            (["[unclosed"], [], "https://example.org/science/"),
            (INCLUDE, [], "https://example.org/"),  # seed outside its own include patterns
            # Stored before complexity checks existed: fails closed, never hangs.
            ([], [r"^(a+)+$"], "https://example.org/science/"),
        ):
            with self.subTest(include=include, name=name):
                self.ecs.run_task.reset_mock()
                self.cursor.execute.reset_mock()
                result = self.run_batch(include, exclude, name=name)
                self.ecs.run_task.assert_not_called()
                self.assertEqual(result["launched_count"], 0)
                self.assertEqual(result["failures"][0]["error"], batch.REJECTED_PATTERNS_MESSAGE)
                failed = [p for sql, p in self.executed_sql() if "'failed'::ingestion_status" in sql]
                self.assertEqual(len(failed), 1)
                self.assertEqual(failed[0][0], batch.REJECTED_PATTERNS_MESSAGE)
                self.assertEqual(json.loads(failed[0][1])["rejected"], "invalid_crawl_patterns")


class RecrawlPatternTests(_LaunchBase):
    """A re-crawl (retry_ingestion_run, action manual_recrawl) is launched through the same query."""

    def test_recrawl_run_is_launched_with_the_data_source_patterns(self):
        # The row _latest_queued_runs selects for the queued re-crawl run.
        self.cursor.fetchall.return_value = [
            ("run-2", "ds-1", "https://example.org/science/", "website", INCLUDE, EXCLUDE, {}),
        ]
        result = batch.process_crawler_batch({}, self.connection, "sync-2")
        self.assertEqual(result["launched_count"], 1, result)
        select_sql = self.executed_sql()[0][0]
        self.assertIn("ds.include_patterns", select_sql)
        self.assertIn("ds.exclude_patterns", select_sql)
        env = self.launched_env()
        self.assertEqual(env["JOB_ID"], "run-2")
        self.assertEqual(json.loads(env[crawl_scope.INCLUDE_ENV]), INCLUDE)
        self.assertEqual(json.loads(env[crawl_scope.EXCLUDE_ENV]), EXCLUDE)


if __name__ == "__main__":
    unittest.main()
