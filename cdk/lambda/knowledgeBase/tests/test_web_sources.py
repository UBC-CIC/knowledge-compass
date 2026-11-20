"""
Unit tests for helpers/web_sources.py: the site host rule and deleting the
pages a website data source owns (owned, shared, and unowned legacy rows).
The database is faked.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_web_sources.py"
"""

import _setup  # noqa: F401  (must be first)

import unittest

from _embedding_fakes import ScriptedConnection
from helpers.web_sources import delete_website_pages, site_host, url_in_site

DS_ID = "11111111-1111-4111-8111-111111111111"
SEED = "https://example.org"

OWNED_DELETE = "USING web_source_owners o"
SHARED_COUNT = "SELECT count(*) FROM web_source_owners"
UNOWNED_SELECT = "SELECT s.id, s.url FROM sources s"
OTHER_SITES = "SELECT name FROM data_sources"
FALLBACK_DELETE = "WHERE s.id = ANY(%s::uuid[])"


def connection(owned=(), shared=0, unowned=(), other_sites=()):
    return ScriptedConnection({
        OWNED_DELETE: [(i,) for i in owned],
        SHARED_COUNT: [(shared,)],
        UNOWNED_SELECT: list(unowned),
        OTHER_SITES: [(s,) for s in other_sites],
        FALLBACK_DELETE: lambda params: [(i,) for i in params[0]],
    })


class SiteHostTests(unittest.TestCase):
    def test_normalizes_case_www_port_and_trailing_dot(self):
        self.assertEqual(site_host("https://Example.ORG/path"), "example.org")
        self.assertEqual(site_host("http://www.example.org:8080/x"), "example.org")
        self.assertEqual(site_host("https://example.org./"), "example.org")
        self.assertEqual(site_host("  https://example.org  "), "example.org")

    def test_rejects_non_http_and_garbage(self):
        for value in ("ftp://example.org/", "javascript:alert(1)", "example.org", "", None, 42,
                      "https://", "http://[::1"):
            self.assertIsNone(site_host(value), value)

    def test_url_in_site_matches_host_and_subdomains_only(self):
        self.assertTrue(url_in_site("https://example.org/a", SEED))
        self.assertTrue(url_in_site("https://www.example.org/a", SEED))
        self.assertTrue(url_in_site("https://example.org/a", "https://www.example.org/start"))
        self.assertTrue(url_in_site("https://docs.example.org/a", SEED))
        self.assertTrue(url_in_site("https://EXAMPLE.org:443/a", SEED))

    def test_look_alike_hosts_are_not_in_site(self):
        for url in ("https://example.org.evil.com/x", "https://example.org@evil.com/",
                    "https://evil.com/?u=https://example.org", "https://notexample.org/",
                    "https://evil.com/example.org", "ftp://example.org/"):
            self.assertFalse(url_in_site(url, SEED), url)
        self.assertFalse(url_in_site("https://example.org/", "not a url"))


class DeleteWebsitePagesTests(unittest.TestCase):
    def test_owned_delete_excludes_pages_another_website_owns(self):
        conn = connection(owned=["p1", "p2"])
        result = delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(result, {"deleted_page_count": 2, "retained_shared_page_count": 0})
        sql, params = conn.sql_with(OWNED_DELETE)[0]
        self.assertIn("o.data_source_id = %s::uuid", sql)
        self.assertIn("s.source_type = 'web'::source_type", sql)
        self.assertIn("NOT EXISTS ( SELECT 1 FROM web_source_owners other WHERE other.source_id = s.id "
                      "AND other.data_source_id <> %s::uuid )", sql)
        self.assertEqual(params, (DS_ID, DS_ID))

    def test_shared_pages_are_counted_as_retained(self):
        conn = connection(owned=["p1"], shared=3)
        result = delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(result, {"deleted_page_count": 1, "retained_shared_page_count": 3})
        self.assertEqual(conn.sql_with(SHARED_COUNT)[0][1], (DS_ID,))

    def test_fallback_deletes_only_unowned_rows_inside_the_site(self):
        conn = connection(unowned=[
            ("seed", SEED),
            ("in", "https://example.org/page"),
            ("sub", "https://www.example.org/x"),
            ("evil", "https://example.org.evil.com/x"),
            ("userinfo", "https://example.org@evil.com/x"),
            ("other", "https://elsewhere.org/a"),
        ])
        result = delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(result["deleted_page_count"], 3)
        sql, params = conn.sql_with(FALLBACK_DELETE)[0]
        self.assertEqual(params, (["seed", "in", "sub"],))
        self.assertIn("s.source_type = 'web'::source_type", sql)
        self.assertIn("NOT EXISTS ( SELECT 1 FROM web_source_owners o WHERE o.source_id = s.id )", sql)
        self.assertEqual(conn.sql_with(OTHER_SITES)[0][1], (DS_ID,))

    def test_fallback_keeps_rows_inside_another_live_websites_site(self):
        conn = connection(
            unowned=[("docs", "https://docs.example.org/a"), ("root", "https://example.org/b")],
            other_sites=["https://docs.example.org"],
        )
        delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(conn.sql_with(FALLBACK_DELETE)[0][1], (["root"],))

    def test_fallback_keeps_everything_when_another_site_has_the_same_host(self):
        conn = connection(
            unowned=[("a", "https://example.org/a")],
            other_sites=["https://www.example.org/section"],
        )
        result = delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(conn.sql_with(FALLBACK_DELETE), [])
        self.assertEqual(result["deleted_page_count"], 0)

    def test_no_fallback_delete_when_nothing_qualifies(self):
        conn = connection(unowned=[("evil", "https://example.org.evil.com/")])
        delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(conn.sql_with(FALLBACK_DELETE), [])

    def test_no_unowned_rows_skips_the_other_sites_lookup(self):
        conn = connection()
        delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        self.assertEqual(conn.sql_with(OTHER_SITES), [])

    def test_sql_is_parameterized_uses_no_like_and_never_commits(self):
        conn = connection(owned=["p1"], unowned=[("in", "https://example.org/x")])
        delete_website_pages(conn, data_source_id=DS_ID, seed_url=SEED)
        for sql, _ in conn.executed:
            self.assertNotIn("LIKE", sql.upper())
            self.assertNotIn("example.org", sql)
            self.assertNotIn(DS_ID, sql)
        self.assertEqual((conn.commits, conn.rollbacks), (0, 0))


if __name__ == "__main__":
    unittest.main()
