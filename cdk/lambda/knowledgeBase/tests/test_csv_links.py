"""
Unit tests for helpers/csv_links.py: URL-column detection, row planning
(row keys, metadata, invalid URLs, the per-CSV URL cap) and the hand-off from
CSV ingestion to the link phase.

Run from the knowledgeBase dir:

    pytest tests
"""

import csv
import io
import os
import unittest
from unittest import mock

import _setup  # noqa: F401,E402  (path + env; see _setup.py)

from helpers import csv_links, stage_data_sources  # noqa: E402
from helpers.csv_links import detect_url_columns, plan_link_rows, summarize  # noqa: E402


def make_csv(header, rows) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8")


class DetectUrlColumnTests(unittest.TestCase):
    def test_detects_column_over_threshold(self):
        text = make_csv(
            ["name", "website", "notes"],
            [["A", "https://a.example/", "see https://x.example"],
             ["B", "http://b.example/page", "plain"],
             ["C", "https://c.example", ""],
             ["D", "", "plain"]],
        ).decode()
        self.assertEqual(detect_url_columns(text), ["website"])

    def test_exactly_80_percent_is_not_enough(self):
        rows = [[f"https://{i}.example/"] for i in range(4)] + [["not a url"]]
        self.assertEqual(detect_url_columns(make_csv(["link"], rows).decode()), [])
        rows = [[f"https://{i}.example/"] for i in range(9)] + [["not a url"]]
        self.assertEqual(detect_url_columns(make_csv(["link"], rows).decode()), ["link"])

    def test_non_http_schemes_do_not_count(self):
        rows = [["ftp://a.example/x"], ["mailto:a@b.example"], ["file:///x"]]
        self.assertEqual(detect_url_columns(make_csv(["link"], rows).decode()), [])


class PlanLinkRowsTests(unittest.TestCase):
    HEADER = ["id", "Program", "URL", "Province"]

    def test_rows_with_metadata_and_statuses(self):
        raw = make_csv(self.HEADER, [
            ["1", "Alpha", "https://Alpha.example/about#team", "BC"],
            ["2", "Beta", "", "AB"],
            ["3", "Gamma", "javascript:alert(1)", "ON"],
            ["4", "Delta", "https://alpha.example/about", "QC"],
        ])
        plan = plan_link_rows(raw, "url")  # header match is case-insensitive
        self.assertIsNone(plan["error"])
        self.assertEqual(plan["url_column"], "URL")
        rows = plan["rows"]
        self.assertEqual([row["row_number"] for row in rows], [1, 2, 3, 4])

        alpha, beta, gamma, delta = rows
        self.assertEqual(alpha["status"], "pending")
        self.assertEqual(alpha["normalized_url"], "https://alpha.example/about")
        self.assertEqual(alpha["source_url"], "csvlink://https://alpha.example/about")
        self.assertEqual(alpha["citation_url"], "https://alpha.example/about")
        self.assertEqual(alpha["row_metadata"], {"id": "1", "Program": "Alpha", "Province": "BC"})
        self.assertNotIn("URL", alpha["row_metadata"])

        self.assertEqual(beta["status"], "skipped")
        self.assertEqual(beta["reason"], "no fetch URL")
        self.assertEqual(beta["row_text"], "id: 2\nProgram: Beta\nProvince: AB")

        self.assertEqual(gamma["status"], "failed")
        self.assertIn("invalid URL", gamma["reason"])
        self.assertIsNone(gamma["source_url"])

        # Duplicate URL across rows: both rows link to the same canonical content.
        self.assertEqual(delta["source_url"], alpha["source_url"])
        self.assertEqual(summarize(rows), {"pending": 2, "success": 0, "failed": 1, "skipped": 1})

    def test_role_columns_build_row_text_and_override_citation(self):
        raw = make_csv(
            ["ID", "Title", "Summary", "Fetch", "Public", "Province"],
            [
                ["r1", "Family guide", "A concise description", "https://fetch.example/a",
                 "https://public.example/resource", "BC"],
                ["r2", "Row only", "Still searchable", "", "https://public.example/row", "AB"],
                ["r3", "Fallback", "Bad citation", "https://fetch.example/fallback", "javascript:bad", "ON"],
            ],
        )
        plan = plan_link_rows(
            raw,
            "fetch",
            row_id_column="id",
            title_column="title",
            description_column="summary",
            citation_column="public",
        )
        first, row_only, fallback = plan["rows"]
        self.assertEqual(first["row_key"], "id:r1")
        self.assertEqual(first["title"], "Family guide")
        self.assertEqual(first["description"], "A concise description")
        self.assertEqual(first["citation_url"], "https://public.example/resource")
        self.assertEqual(
            first["row_metadata"],
            {"Title": "Family guide", "Summary": "A concise description", "Province": "BC"},
        )
        self.assertNotIn("Fetch", first["row_text"])
        self.assertNotIn("Public", first["row_text"])
        self.assertNotIn("ID", first["row_text"])
        self.assertEqual(row_only["status"], "skipped")
        self.assertEqual(row_only["citation_url"], "https://public.example/row")
        self.assertEqual(fallback["citation_url"], "https://fetch.example/fallback")
        self.assertIn("invalid citation URL", fallback["citation_warning"])

    def test_citation_preserves_fragment_while_fetch_identity_drops_it(self):
        raw = make_csv(
            ["Title", "Fetch", "Public"],
            [["Guide", "https://fetch.example/guide#download", "https://public.example/guide#page=12"]],
        )
        row = plan_link_rows(raw, "Fetch", title_column="Title", citation_column="Public")["rows"][0]
        self.assertEqual(row["normalized_url"], "https://fetch.example/guide")
        self.assertEqual(row["citation_url"], "https://public.example/guide#page=12")

    def test_missing_url_column_is_an_error_not_a_crash(self):
        plan = plan_link_rows(make_csv(self.HEADER, [["1", "A", "https://a.example", "BC"]]), "website")
        self.assertEqual(plan["rows"], [])
        self.assertIn("not a column", plan["error"])

    def test_row_keys_follow_content_or_id_column(self):
        rows = [["1", "Alpha", "https://a.example/", "BC"], ["2", "Beta", "https://b.example/", "AB"]]
        keys = [r["row_key"] for r in plan_link_rows(make_csv(self.HEADER, rows), "URL")["rows"]]
        reordered = [r["row_key"] for r in plan_link_rows(make_csv(self.HEADER, rows[::-1]), "URL")["rows"]]
        # Hash keys are stable when rows move...
        self.assertEqual(sorted(keys), sorted(reordered))
        # ...and change when the row is edited (the old row is then removed).
        edited = [["1", "Alpha", "https://a.example/new", "BC"], rows[1]]
        edited_keys = [r["row_key"] for r in plan_link_rows(make_csv(self.HEADER, edited), "URL")["rows"]]
        self.assertNotEqual(edited_keys[0], keys[0])
        self.assertEqual(edited_keys[1], keys[1])

        # With row_id_column the key survives edits.
        by_id = [r["row_key"] for r in plan_link_rows(make_csv(self.HEADER, edited), "URL", "id")["rows"]]
        self.assertEqual(by_id, ["id:1", "id:2"])

    def test_identical_rows_stay_distinct(self):
        row = ["1", "Alpha", "https://a.example/", "BC"]
        keys = [r["row_key"] for r in plan_link_rows(make_csv(self.HEADER, [row, row, row]), "URL")["rows"]]
        self.assertEqual(len(set(keys)), 3)
        self.assertTrue(keys[1].endswith("#2") and keys[2].endswith("#3"))


class LargeCsvCapTests(unittest.TestCase):
    def test_url_cap_skips_rows_beyond_the_limit(self):
        rows = [[str(i), f"https://site{i}.example/page"] for i in range(1200)]
        # A late row repeating an accepted URL is still crawled (no extra fetch).
        rows.append(["dup", "https://site0.example/page"])
        plan = plan_link_rows(make_csv(["id", "link"], rows), "link", max_urls=500)
        statuses = summarize(plan["rows"])
        self.assertEqual(statuses, {"pending": 501, "success": 0, "failed": 0, "skipped": 700})

        pending_urls = {r["normalized_url"] for r in plan["rows"] if r["status"] == "pending"}
        self.assertEqual(len(pending_urls), 500)
        skipped = [r for r in plan["rows"] if r["status"] == "skipped"]
        self.assertTrue(all(r["reason"].startswith("url_cap_exceeded") for r in skipped))
        self.assertTrue(all(r["source_url"] is None for r in skipped))
        self.assertEqual(skipped[0]["row_number"], 501)

    def test_cap_comes_from_env_by_default(self):
        rows = [[f"https://s{i}.example/"] for i in range(10)]
        with mock.patch.dict(os.environ, {"LINK_MAX_URLS_PER_CSV": "3"}):
            plan = plan_link_rows(make_csv(["link"], rows), "link")
        self.assertEqual(summarize(plan["rows"])["pending"], 3)


class StagingRoleTests(unittest.TestCase):
    def test_all_roles_resolve_to_exact_header_spelling(self):
        info = {
            "columns": ["ID", "Title", "Description", "Fetch URL", "Public URL"],
            "suggested_url_column": "Fetch URL",
        }
        with mock.patch.object(stage_data_sources, "inspect_uploaded_csv", return_value=info):
            config = stage_data_sources._link_config(
                "csv", "bucket", "key", "fetch url", "id", "title", "description", "public url"
            )
        self.assertEqual(config["url_column"], "Fetch URL")
        self.assertEqual(config["row_id_column"], "ID")
        self.assertEqual(config["title_column"], "Title")
        self.assertEqual(config["description_column"], "Description")
        self.assertEqual(config["citation_column"], "Public URL")

    def test_resource_roles_require_url_column(self):
        with self.assertRaises(stage_data_sources.StageRejected):
            stage_data_sources._link_config(
                "csv", "bucket", "key", None, None, title_column="Title"
            )


class StartLinkPhaseTests(unittest.TestCase):
    def run_meta(self, **metadata):
        return {
            "ingestion_run_id": "run-1",
            "data_source_id": "ds-1",
            "metadata": metadata,
            "run_metadata": {"sync_session_id": "sess-1"},
        }

    def setUp(self):
        self.connection = mock.MagicMock()
        patches = {
            "clear": mock.patch.object(csv_links, "clear_link_rows", return_value=0),
            "reconcile": mock.patch.object(csv_links, "reconcile_link_rows", return_value=0),
            "run_meta": mock.patch.object(csv_links, "_set_run_link_metadata"),
            "fail_pending": mock.patch.object(csv_links, "_fail_pending_rows"),
            "fail_unindexed": mock.patch.object(csv_links, "_fail_unindexed_rows"),
            "invoke": mock.patch.object(csv_links, "invoke_link_worker"),
            "fn": mock.patch.object(csv_links, "LAMBDA_FUNCTION_NAME", "kb-fn"),
        }
        self.m = {name: p.start() for name, p in patches.items()}
        for p in patches.values():
            self.addCleanup(p.stop)

    def test_without_url_column_nothing_is_crawled(self):
        result = csv_links.start_link_phase(
            self.connection, run=self.run_meta(), raw_bytes=make_csv(["a"], [["https://x.example"]]),
            chunks_upserted=3, chunks_deleted=0,
        )
        self.assertEqual(result, {"deferred": False, "metadata": {}})
        self.m["reconcile"].assert_not_called()
        self.m["invoke"].assert_not_called()
        # Links left over from an earlier upload that had url_column are removed.
        self.m["clear"].assert_called_once_with(self.connection, "ds-1")

    def test_with_links_hands_off_to_worker(self):
        raw = make_csv(["name", "link"], [["A", "https://a.example/"], ["B", "bad url"]])
        result = csv_links.start_link_phase(
            self.connection, run=self.run_meta(url_column="link"), raw_bytes=raw, chunks_upserted=3, chunks_deleted=1,
        )
        self.assertTrue(result["deferred"])
        planned = self.m["reconcile"].call_args.args[2]
        self.assertEqual([r["status"] for r in planned], ["pending", "failed"])
        self.m["run_meta"].assert_called_once()
        self.assertEqual(self.m["run_meta"].call_args.kwargs["metadata"]["link_phase"], "running")
        self.m["invoke"].assert_called_once_with(
            ingestion_run_id="run-1", data_source_id="ds-1", sync_session_id="sess-1", continuation=0,
            actor=None,
        )

    def test_rows_without_fetchable_urls_still_hand_off_for_indexing(self):
        raw = make_csv(["title", "link"], [["Searchable row", "not-a-url"], ["No URL", ""]])
        result = csv_links.start_link_phase(
            self.connection,
            run=self.run_meta(url_column="link", title_column="title"),
            raw_bytes=raw,
            chunks_upserted=1,
            chunks_deleted=0,
        )
        self.assertTrue(result["deferred"])
        planned = self.m["reconcile"].call_args.args[2]
        self.assertEqual([row["status"] for row in planned], ["failed", "skipped"])
        self.m["invoke"].assert_called_once()

    def test_invoke_failure_does_not_fail_csv(self):
        self.m["invoke"].side_effect = RuntimeError("throttled")
        raw = make_csv(["link"], [["https://a.example/"]])
        result = csv_links.start_link_phase(
            self.connection, run=self.run_meta(url_column="link"), raw_bytes=raw, chunks_upserted=1, chunks_deleted=0,
        )
        self.assertFalse(result["deferred"])
        self.assertIn("could not be started", result["metadata"]["link_error"])
        self.m["fail_pending"].assert_called_once()
        self.m["fail_unindexed"].assert_called_once()

    def test_url_column_missing_from_csv(self):
        raw = make_csv(["name"], [["A"]])
        result = csv_links.start_link_phase(
            self.connection, run=self.run_meta(url_column="link"), raw_bytes=raw, chunks_upserted=1, chunks_deleted=0,
        )
        self.assertFalse(result["deferred"])
        self.assertIn("not a column", result["metadata"]["link_error"])


if __name__ == "__main__":
    unittest.main()
