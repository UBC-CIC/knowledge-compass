"""
Unit tests for helpers/url_safety.py (URL normalization + SSRF address checks).

No AWS access or database needed. Run from the knowledgeBase dir:

    pytest tests
"""

import socket
import unittest

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers.url_safety import (  # noqa: E402
    BlockedURL,
    InvalidURL,
    is_public_ip,
    normalize_citation_url,
    normalize_url,
    resolve_public_addresses,
)


def fake_resolver(mapping):
    def resolve(host, port, type=None):  # noqa: A002 - mirrors socket.getaddrinfo
        if host not in mapping:
            raise socket.gaierror("unknown host")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in mapping[host]]
    return resolve


class NormalizeUrlTests(unittest.TestCase):
    def test_canonicalizes(self):
        self.assertEqual(
            normalize_url("  HTTPS://Example.COM:443/Some Path?q=a b#frag "),
            "https://example.com/Some%20Path?q=a%20b",
        )
        self.assertEqual(normalize_url("http://example.com"), "http://example.com/")
        self.assertEqual(normalize_url("http://example.com:8080/x"), "http://example.com:8080/x")

    def test_citation_normalization_preserves_deep_links(self):
        self.assertEqual(
            normalize_citation_url(" HTTPS://Example.COM/Guide#page=12 "),
            "https://example.com/Guide#page=12",
        )
        self.assertEqual(
            normalize_citation_url("https://example.com/supports#transition planning"),
            "https://example.com/supports#transition%20planning",
        )

    def test_same_page_written_differently_dedupes(self):
        self.assertEqual(
            normalize_url("https://EXAMPLE.com/a#top"),
            normalize_url("https://example.com:443/a"),
        )

    def test_rejects_non_http_schemes(self):
        for url in ("ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)",
                    "mailto:a@example.com", "gopher://example.com", "example.com/no-scheme"):
            with self.subTest(url=url), self.assertRaises(InvalidURL):
                normalize_url(url)

    def test_rejects_credentials_empty_and_overlong(self):
        with self.assertRaises(InvalidURL):
            normalize_url("https://user:pass@example.com/")
        with self.assertRaises(InvalidURL):
            normalize_url("   ")
        with self.assertRaises(InvalidURL):
            normalize_url("https://example.com/" + "a" * 2100)
        with self.assertRaises(InvalidURL):
            normalize_url("https://example.com:99999/")

    def test_rejects_non_web_ports(self):
        for url in ("http://example.com:22/", "https://example.com:25/", "http://example.com:6379/x",
                    "https://example.com:0/"):
            with self.subTest(url=url), self.assertRaises(InvalidURL):
                normalize_url(url)
        self.assertEqual(normalize_url("https://example.com:8443/x"), "https://example.com:8443/x")
        self.assertEqual(normalize_url("http://example.com:80/x"), "http://example.com/x")

    def test_idna_host(self):
        self.assertEqual(normalize_url("https://bücher.example/"), "https://xn--bcher-kva.example/")


class PublicIpTests(unittest.TestCase):
    def test_non_public_addresses_rejected(self):
        for ip in (
            "10.0.0.5", "172.16.3.4", "192.168.1.1",          # private
            "127.0.0.1", "::1",                                # loopback
            "169.254.169.254", "169.254.170.2", "fe80::1",     # link-local (EC2/ECS metadata)
            "100.64.0.1",                                      # carrier-grade NAT
            "0.0.0.0", "::",                                   # unspecified
            "224.0.0.1", "ff02::1",                            # multicast
            "240.0.0.1",                                       # reserved
            "fc00::1",                                         # unique local
            "::ffff:10.0.0.1", "::ffff:127.0.0.1",             # IPv4-mapped
            "64:ff9b::a00:1",                                  # NAT64 of 10.0.0.1
            "2002:a00:1::",                                    # 6to4 of 10.0.0.1
            "not-an-ip",
        ):
            with self.subTest(ip=ip):
                self.assertFalse(is_public_ip(ip))

    def test_public_addresses_allowed(self):
        for ip in ("93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"):
            with self.subTest(ip=ip):
                self.assertTrue(is_public_ip(ip))


class ResolveTests(unittest.TestCase):
    def test_all_public(self):
        resolver = fake_resolver({"example.com": ["93.184.216.34", "93.184.216.35"]})
        self.assertEqual(resolve_public_addresses("example.com", 443, resolver), ["93.184.216.34", "93.184.216.35"])

    def test_any_private_answer_blocks(self):
        resolver = fake_resolver({"rebind.example": ["93.184.216.34", "10.0.0.7"]})
        with self.assertRaises(BlockedURL):
            resolve_public_addresses("rebind.example", 443, resolver)

    def test_ip_literals_checked_without_dns(self):
        def no_dns(*a, **k):
            raise AssertionError("DNS should not be used for an IP literal")
        with self.assertRaises(BlockedURL):
            resolve_public_addresses("169.254.169.254", 80, no_dns)
        with self.assertRaises(BlockedURL):
            resolve_public_addresses("[::1]", 80, no_dns)
        self.assertEqual(resolve_public_addresses("8.8.8.8", 80, no_dns), ["8.8.8.8"])

    def test_unresolvable(self):
        with self.assertRaises(OSError):
            resolve_public_addresses("nope.invalid", 443, fake_resolver({}))


if __name__ == "__main__":
    unittest.main()
