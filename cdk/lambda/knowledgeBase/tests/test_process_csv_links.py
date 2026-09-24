"""
Unit tests for helpers/process_csv_links.py: the link-phase worker, driven by
an in-memory LinkStore and a scripted fetcher (no network, AWS or database).

Run from the knowledgeBase dir:

    pytest tests
"""

import threading
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import process_csv_links as worker  # noqa: E402
from helpers.link_fetcher import HTML, PDF, FetchError, FetchLimits, FetchResult  # noqa: E402

LOREM = " ".join(["Families can request a meeting with the school team at any time."] * 5)
HTML_PAGE = f"<html><head><title>Program A</title></head><body><main><h1>Program A</h1><p>{LOREM}</p></main></body></html>".encode()


def make_pdf(text: str) -> bytes:
    """A minimal one-page PDF whose text pypdf can extract."""
    stream = b"BT /F1 9 Tf 20 700 Td (" + text.encode("latin-1") + b") Tj ET"
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return out


def link(ds, key, number, url, status="pending", **extra):
    row = {
        "data_source_id": ds,
        "row_key": key,
        "row_number": number,
        "normalized_url": url,
        "source_url": f"csvlink://{url}" if url and status != "skipped" else None,
        "row_metadata": {"Program": key.upper()},
        "status": status,
        "reason": None,
        "http_status": None,
        "content_type": None,
        "fetched": False,
    }
    row.update(extra)
    return row


class FakeStore:
    """In-memory stand-in for process_csv_links.LinkStore."""

    def __init__(self, links, sources=None, active=True):
        self.connection = object()
        self.links = links
        self.sources = sources or {}
        self.active = active
        self.finalized = None
        self.gc_calls = 0

    def commit(self):
        pass

    def rollback(self):
        pass

    def run_is_active(self, run_id):
        return self.active

    def pending_urls(self, ds):
        seen, out = set(), []
        for row in sorted(self.links, key=lambda r: r["row_number"]):
            if row["data_source_id"] == ds and row["status"] == "pending" and row["source_url"] \
                    and row["source_url"] not in seen:
                seen.add(row["source_url"])
                out.append({"normalized_url": row["normalized_url"], "source_url": row["source_url"]})
        return out

    def session_fetch(self, source_url, session_id):
        meta = self.sources.get(source_url, {}).get("metadata", {})
        if meta.get("fetch_session") == session_id:
            return {"http_status": meta.get("http_status"), "content_type": meta.get("content_type")}
        return None

    def source_exists(self, source_url):
        return source_url in self.sources

    def upsert_link_source(self, source_url, *, name, metadata):
        self.sources[source_url] = {"id": f"src:{source_url}", "name": name, "metadata": dict(metadata)}
        return self.sources[source_url]["id"]

    def refresh_source_rows(self, source_url):
        if source_url in self.sources:
            self.sources[source_url]["metadata"]["rows"] = [
                {"row_key": r["row_key"], "columns": r["row_metadata"]}
                for r in self.links if r["source_url"] == source_url
            ]

    def mark_rows(self, source_url, status, *, data_source_id, reason=None, http_status=None,
                  content_type=None, fetched=False):
        for row in self.links:
            if row["source_url"] != source_url:
                continue
            if data_source_id is not None and (row["data_source_id"] != data_source_id or row["status"] != "pending"):
                continue
            if data_source_id is None and row["status"] == "skipped":
                continue
            row.update(status=status, reason=reason, http_status=http_status, content_type=content_type,
                       fetched=row["fetched"] or fetched)

    def delete_source(self, source_url):
        self.sources.pop(source_url, None)

    def count_pending(self, ds):
        return sum(1 for r in self.links if r["data_source_id"] == ds and r["status"] == "pending")

    def fail_pending(self, ds, reason):
        for r in self.links:
            if r["data_source_id"] == ds and r["status"] == "pending":
                r.update(status="failed", reason=reason)

    def summary(self, ds):
        counts = {"pending": 0, "success": 0, "failed": 0, "skipped": 0}
        for r in self.links:
            if r["data_source_id"] == ds:
                counts[r["status"]] += 1
        return counts

    def finalize_run(self, run_id, summary):
        self.finalized = summary

    def delete_unreferenced_sources(self):
        self.gc_calls += 1
        return 0

    def by_key(self, key):
        return next(r for r in self.links if r["row_key"] == key)


class FakeFetcher:
    def __init__(self, responses):
        self.limits = FetchLimits(total_timeout=5)
        self.responses = responses
        self.calls = []
        self._lock = threading.Lock()

    def fetch(self, url):
        with self._lock:
            self.calls.append(url)
        outcome = self.responses[url]
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def html_result(url):
    return FetchResult(url=url, http_status=200, content_type=HTML, charset="utf-8", body=HTML_PAGE)


class RecordingWriter:
    def __init__(self):
        self.calls = {}

    def __call__(self, connection, source_id, chunks):
        self.calls[source_id] = chunks
        return {"written": len(chunks), "embedded": len(chunks), "deleted": 0}


A = "https://a.example/program"
B = "https://b.example/gone"
C = "http://internal.example/admin"
D = "https://d.example/guide.pdf"
E = "https://e.example/flaky"


def run(store, fetcher, *, time_left=lambda: 600, write=None):
    return worker.run_link_phase(
        store, fetcher, data_source_id="ds1", run_id="run1", session_id="sess1",
        time_left=time_left, concurrency=4, write=write or RecordingWriter(),
    )


class MixedUrlTests(unittest.TestCase):
    def test_good_bad_duplicate_and_blocked_urls(self):
        store = FakeStore([
            link("ds1", "r1", 1, A),
            link("ds1", "r2", 2, A),                   # duplicate of r1's URL
            link("ds1", "r3", 3, B),                   # dead link
            link("ds1", "r4", 4, C),                   # resolves to a private IP
            link("ds1", "r5", 5, D),                   # PDF
            link("ds1", "r6", 6, "https://z.example/", status="skipped", reason="url_cap_exceeded"),
            link("ds1", "r7", 7, None, status="failed", reason="invalid URL: only http and https URLs are crawled"),
        ])
        fetcher = FakeFetcher({
            A: html_result(A),
            B: FetchError("HTTP 404", permanent=True, http_status=404),
            C: FetchError("blocked: internal.example resolves to a non-public address (10.0.0.12)", permanent=True),
            D: FetchResult(url=D, http_status=200, content_type=PDF, charset=None, body=make_pdf(LOREM)),
        })
        writer = RecordingWriter()

        stats = run(store, fetcher, write=writer)

        # Each distinct URL fetched exactly once; nothing raised.
        self.assertEqual(sorted(fetcher.calls), sorted([A, B, C, D]))
        self.assertEqual((stats["success"], stats["failed"]), (2, 2))

        self.assertEqual(store.by_key("r1")["status"], "success")
        self.assertEqual(store.by_key("r2")["status"], "success")
        self.assertEqual((store.by_key("r3")["status"], store.by_key("r3")["http_status"]), ("failed", 404))
        self.assertIn("blocked", store.by_key("r4")["reason"])
        self.assertEqual((store.by_key("r5")["status"], store.by_key("r5")["content_type"]), ("success", PDF))
        self.assertEqual(store.by_key("r6")["status"], "skipped")
        self.assertEqual(store.by_key("r7")["status"], "failed")

        # Indexed content: cited by its real URL, with the linking rows attached.
        source_a = store.sources[f"csvlink://{A}"]
        self.assertEqual(source_a["metadata"]["citation_url"], A)
        self.assertEqual(source_a["metadata"]["fetch_session"], "sess1")
        self.assertEqual([r["row_key"] for r in source_a["metadata"]["rows"]], ["r1", "r2"])
        self.assertEqual(source_a["name"], "Program A")
        self.assertTrue(writer.calls[source_a["id"]])
        self.assertIn("guide.pdf", store.sources[f"csvlink://{D}"]["name"])
        self.assertNotIn(f"csvlink://{B}", store.sources)
        self.assertNotIn(f"csvlink://{C}", store.sources)

    def test_permanent_failure_removes_old_content_everywhere(self):
        store = FakeStore(
            [link("ds1", "r1", 1, B), link("ds2", "other", 1, B, status="success")],
            sources={f"csvlink://{B}": {"id": "old", "name": "old", "metadata": {}}},
        )
        run(store, FakeFetcher({B: FetchError("HTTP 410", permanent=True, http_status=410)}))
        self.assertNotIn(f"csvlink://{B}", store.sources)
        self.assertEqual(store.by_key("other")["status"], "failed")

    def test_transient_failure_keeps_old_content(self):
        store = FakeStore(
            [link("ds1", "r1", 1, E), link("ds2", "other", 1, E, status="success")],
            sources={f"csvlink://{E}": {"id": "old", "name": "old", "metadata": {}}},
        )
        run(store, FakeFetcher({E: FetchError("timed out", permanent=False)}))
        self.assertIn(f"csvlink://{E}", store.sources)
        self.assertEqual(store.by_key("r1")["status"], "failed")
        self.assertIn("previously indexed content kept", store.by_key("r1")["reason"])
        self.assertEqual(store.by_key("other")["status"], "success")  # other CSV untouched

    def test_page_without_text_fails_its_rows(self):
        store = FakeStore([link("ds1", "r1", 1, A)])
        empty = FetchResult(url=A, http_status=200, content_type=HTML, charset=None, body=b"<html><body></body></html>")
        run(store, FakeFetcher({A: empty}))
        self.assertEqual(store.by_key("r1")["status"], "failed")
        self.assertIn("no extractable text", store.by_key("r1")["reason"])

    def test_indexing_error_fails_rows_only(self):
        store = FakeStore([link("ds1", "r1", 1, A), link("ds1", "r2", 2, D)])
        pdf = FetchResult(url=D, http_status=200, content_type=PDF, charset=None, body=make_pdf(LOREM))
        calls = []

        def flaky_writer(connection, source_id, chunks):
            calls.append(source_id)
            if "a.example" in source_id:
                raise RuntimeError("Bedrock throttled")

        stats = run(store, FakeFetcher({A: html_result(A), D: pdf}), write=flaky_writer)
        self.assertEqual(store.by_key("r1")["status"], "failed")
        self.assertIn("indexing failed", store.by_key("r1")["reason"])
        self.assertEqual(store.by_key("r2")["status"], "success")
        self.assertEqual((stats["success"], stats["failed"]), (1, 1))

    def test_url_fetched_by_another_csv_in_same_sync_is_reused(self):
        store = FakeStore(
            [link("ds1", "r1", 1, A)],
            sources={f"csvlink://{A}": {"id": "s", "name": "A", "metadata": {
                "fetch_session": "sess1", "http_status": 200, "content_type": HTML}}},
        )
        fetcher = FakeFetcher({})
        stats = run(store, fetcher)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(stats["reused"], 1)
        self.assertEqual(store.by_key("r1")["status"], "success")

    def test_stops_starting_urls_when_out_of_time(self):
        store = FakeStore([link("ds1", "r1", 1, A)])
        fetcher = FakeFetcher({A: html_result(A)})
        run(store, fetcher, time_left=lambda: 10)
        self.assertEqual(fetcher.calls, [])
        self.assertEqual(store.by_key("r1")["status"], "pending")

    def test_deleted_run_writes_nothing(self):
        store = FakeStore([link("ds1", "r1", 1, A)], active=False)
        writer = RecordingWriter()
        stats = run(store, FakeFetcher({A: html_result(A)}), write=writer)
        self.assertTrue(stats["aborted"])
        self.assertEqual(writer.calls, {})
        self.assertEqual(store.sources, {})


class LargeCsvTests(unittest.TestCase):
    def test_500_urls_each_fetched_once(self):
        urls = [f"https://site{i}.example/" for i in range(500)]
        links = [link("ds1", f"r{i}", i, url) for i, url in enumerate(urls)]
        links += [link("ds1", f"dup{i}", 1000 + i, urls[i]) for i in range(50)]
        links += [link("ds1", f"cap{i}", 2000 + i, f"https://more{i}.example/", status="skipped")
                  for i in range(100)]
        store = FakeStore(links)
        fetcher = FakeFetcher({url: html_result(url) for url in urls})
        run(store, fetcher)
        self.assertEqual(len(fetcher.calls), 500)
        self.assertEqual(len(set(fetcher.calls)), 500)
        self.assertEqual(store.summary("ds1"), {"pending": 0, "success": 550, "failed": 0, "skipped": 100})


class EntryPointTests(unittest.TestCase):
    EVENT = {"task": "process_csv_links", "ingestion_run_id": "run1", "data_source_id": "ds1",
             "sync_session_id": "sess1", "continuation": 0}

    def invoke(self, store, fetcher, *, remaining_ms=600_000, event=None):
        context = mock.Mock()
        context.get_remaining_time_in_millis.return_value = remaining_ms
        with mock.patch.object(worker, "LinkStore", return_value=store), \
                mock.patch.object(worker, "LinkFetcher", return_value=fetcher), \
                mock.patch.object(worker, "write_chunks", RecordingWriter()), \
                mock.patch.object(worker, "invoke_link_worker") as invoke:
            result = worker.process_csv_links(event or self.EVENT, connection=None, context=context)
        return result, invoke

    def test_completes_and_finalizes_run(self):
        store = FakeStore([link("ds1", "r1", 1, A), link("ds1", "r2", 2, B)])
        result, invoke = self.invoke(store, FakeFetcher({
            A: html_result(A), B: FetchError("HTTP 404", permanent=True, http_status=404)}))
        self.assertTrue(result["completed"])
        invoke.assert_not_called()
        self.assertEqual(store.finalized, {"pending": 0, "success": 1, "failed": 1, "skipped": 0})
        self.assertEqual(store.gc_calls, 1)

    def test_continues_when_time_runs_out(self):
        store = FakeStore([link("ds1", "r1", 1, A)])
        result, invoke = self.invoke(store, FakeFetcher({A: html_result(A)}), remaining_ms=30_000)
        self.assertTrue(result["continued"])
        invoke.assert_called_once_with(ingestion_run_id="run1", data_source_id="ds1",
                                       sync_session_id="sess1", continuation=1)
        self.assertIsNone(store.finalized)

    def test_gives_up_after_max_continuations(self):
        store = FakeStore([link("ds1", "r1", 1, A)])
        event = {**self.EVENT, "continuation": 20}
        result, invoke = self.invoke(store, FakeFetcher({A: html_result(A)}), remaining_ms=30_000, event=event)
        self.assertTrue(result["completed"])
        invoke.assert_not_called()
        self.assertEqual(store.by_key("r1")["status"], "failed")
        self.assertIn("ran out of time", store.by_key("r1")["reason"])
        self.assertEqual(store.finalized["failed"], 1)

    def test_inactive_run_is_ignored(self):
        store = FakeStore([link("ds1", "r1", 1, A)], active=False)
        fetcher = FakeFetcher({A: html_result(A)})
        result, _ = self.invoke(store, fetcher)
        self.assertTrue(result["skipped"])
        self.assertEqual(fetcher.calls, [])


if __name__ == "__main__":
    unittest.main()
