"""
Tests for the weekly model-lifecycle check (lifecycleCheck/main.py). Bedrock, SNS, SSM and
the database are faked; nothing here talks to AWS.

Run from lifecycleCheck:  py -3 -m unittest discover -s tests -p "test_*.py"
"""

import datetime
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import main as lc  # noqa: E402

TODAY = datetime.date(2026, 6, 1)
REGION = "ca-central-1"
TITAN = "amazon.titan-embed-text-v2:0"
COHERE = "cohere.embed-english-v3"
HAIKU = "anthropic.claude-3-haiku-20240307-v1:0"


def days_from_today(n):
    return TODAY + datetime.timedelta(days=n)


def summary(model_id, status="ACTIVE", **extra):
    return {"modelId": model_id, "modelLifecycle": {"status": status}, **extra}


def listing(*summaries):
    return {s["modelId"]: s for s in summaries}


class FakeCursor:
    def __init__(self, rows, log):
        self.rows, self.log = rows, log

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.log.append(" ".join(sql.split()))

    def fetchall(self):
        return list(self.rows)


class FakeConnection:
    def __init__(self, rows):
        self.rows, self.sql, self.closed = rows, [], False

    def cursor(self):
        return FakeCursor(self.rows, self.sql)

    def close(self):
        self.closed = True


class Env:
    """Patches every outside call of the handler."""

    def __init__(self, test, spaces=(), generation=None, listings=None, db_error=None, topic="arn:aws:sns:ca-central-1:111122223333:topic"):
        self.rows = [(s["name"], s["model_id"], s["invoke_target"], s.get("eol_date")) for s in spaces]
        self.connection = FakeConnection(self.rows)
        self.listings = listings or {}
        self.list_calls = []
        self.sns = mock.Mock()
        ssm = mock.Mock()
        ssm.get_parameters.return_value = {
            "Parameters": [{"Name": k, "Value": v} for k, v in (generation or {}).items()]
        }
        self.ssm = ssm

        def bedrock(region):
            client = mock.Mock()

            def list_foundation_models():
                self.list_calls.append(region)
                value = self.listings.get(region)
                if isinstance(value, Exception):
                    raise value
                return {"modelSummaries": list((value or {}).values())}

            client.list_foundation_models.side_effect = list_foundation_models
            return client

        patches = [
            mock.patch.object(lc, "_connect_to_db", side_effect=db_error) if db_error else mock.patch.object(lc, "_connect_to_db", return_value=self.connection),
            mock.patch.object(lc, "_bedrock_client", side_effect=bedrock),
            mock.patch.object(lc, "_sns_client", return_value=self.sns),
            mock.patch.object(lc, "_ssm_client", return_value=ssm),
            mock.patch.object(lc, "_today", return_value=TODAY),
            mock.patch.dict(os.environ, {"REGION": REGION, "SNS_TOPIC_ARN": topic, "SM_DB_CREDENTIALS": "kc/db", "RDS_PROXY_ENDPOINT": "proxy"}, clear=False),
        ]
        for patch in patches:
            patch.start()
            test.addCleanup(patch.stop)

    def run(self):
        return lc.handler({}, None)

    @property
    def published(self):
        return self.sns.publish.call_args_list

    def message(self):
        return self.sns.publish.call_args.kwargs["Message"]


def space(name="titan-v2-1024", model_id=TITAN, invoke_target=TITAN, eol_date=None):
    return {"name": name, "model_id": model_id, "invoke_target": invoke_target, "eol_date": eol_date}


class ParseReferenceTests(unittest.TestCase):
    def test_bare_ids_use_the_default_region(self):
        self.assertEqual(lc.parse_model_reference(TITAN, REGION), (REGION, TITAN))

    def test_foundation_model_arns_carry_their_region(self):
        arn = f"arn:aws:bedrock:us-east-1::foundation-model/{COHERE}"
        self.assertEqual(lc.parse_model_reference(arn, REGION), ("us-east-1", COHERE))

    def test_inference_profile_arns_carry_their_region_and_lose_the_geography_prefix(self):
        arn = "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-3-haiku-20240307-v1:0"
        self.assertEqual(lc.parse_model_reference(arn, REGION), ("us-east-1", HAIKU))

    def test_profile_style_bare_ids_are_normalised_and_provider_ids_are_not(self):
        self.assertEqual(lc.parse_model_reference("eu.anthropic.claude-3-haiku-20240307-v1:0", REGION), (REGION, HAIKU))
        self.assertEqual(lc.parse_model_reference("cohere.embed-english-v3", REGION), (REGION, COHERE))

    def test_unresolvable_references_return_none(self):
        for value in (
            "",
            "   ",
            "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abc123",
            "arn:aws:s3:::bucket",
            "arn:aws:bedrock",
        ):
            self.assertIsNone(lc.parse_model_reference(value, REGION), value)


class CollectTests(unittest.TestCase):
    def test_distinct_models_are_merged_and_the_earliest_registry_date_wins(self):
        models, unresolved = lc.collect_models(
            [
                space("a", eol_date=days_from_today(200)),
                space("b", eol_date=days_from_today(50)),
                space("c", model_id=COHERE, invoke_target=COHERE),
            ],
            {"/KC/LLM/HaikuArn": HAIKU},
            REGION,
        )
        self.assertEqual(unresolved, [])
        self.assertEqual(set(models), {(REGION, HAIKU), (REGION, COHERE), (REGION, TITAN)})
        titan = models[(REGION, TITAN)]
        self.assertEqual(titan.used_by, ["embedding space a", "embedding space b"])
        self.assertEqual(titan.registry_eol, days_from_today(50))

    def test_the_region_comes_from_the_invoke_target_but_the_id_from_the_registry(self):
        profile = "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.titan-embed-text-v2:0"
        models, _ = lc.collect_models([space(invoke_target=profile)], {}, REGION)
        self.assertEqual(list(models), [("us-east-1", TITAN)])

    def test_unresolvable_generation_references_are_reported_not_dropped_silently(self):
        _, unresolved = lc.collect_models([], {"/KC/LLM/X": "arn:aws:bedrock:us-east-1:1:application-inference-profile/z"}, REGION)
        self.assertEqual(unresolved, ["generation model /KC/LLM/X"])


class EvaluateTests(unittest.TestCase):
    def one(self, summary_entry, registry_eol=None, region=REGION):
        models = {(region, TITAN): lc.ModelInUse(TITAN, region, ["embedding space x"], registry_eol)}
        return lc.evaluate(models, {region: listing(summary_entry) if summary_entry else {}}, TODAY)

    def test_an_active_model_produces_no_alert(self):
        self.assertEqual(self.one(summary(TITAN)), [])

    def test_a_legacy_model_alerts(self):
        findings = self.one(summary(TITAN, "LEGACY"))
        self.assertEqual(len(findings), 1)
        self.assertIn("LEGACY", findings[0]["reason"])
        self.assertEqual((findings[0]["model_id"], findings[0]["region"]), (TITAN, REGION))

    def test_a_missing_model_alerts(self):
        findings = self.one(None)
        self.assertEqual(len(findings), 1)
        self.assertIn("missing", findings[0]["reason"])

    def test_registry_eol_89_days_alerts_and_91_days_does_not(self):
        self.assertEqual(len(self.one(summary(TITAN), days_from_today(89))), 1)
        self.assertEqual(self.one(summary(TITAN), days_from_today(91)), [])

    def test_warn_days_boundary(self):
        self.assertEqual(lc.WARN_DAYS, 90)
        self.assertEqual(self.one(summary(TITAN), days_from_today(90)), [])      # exactly 90 days: not yet
        self.assertEqual(len(self.one(summary(TITAN), days_from_today(89))), 1)  # one day inside the window
        finding = self.one(summary(TITAN), days_from_today(0))[0]                # today
        self.assertEqual(finding["days_left"], 0)

    def test_a_past_end_of_life_alerts(self):
        findings = self.one(summary(TITAN), days_from_today(-3))
        self.assertEqual(len(findings), 1)
        self.assertIn("3 days ago", findings[0]["reason"])
        self.assertEqual(findings[0]["days_left"], -3)

    def test_a_null_registry_date_is_not_an_alert_by_itself(self):
        self.assertEqual(self.one(summary(TITAN), None), [])

    def test_a_date_in_the_bedrock_response_is_found_without_assuming_its_field_name(self):
        soon = days_from_today(30).isoformat() + "T00:00:00Z"
        for entry in (
            summary(TITAN, extra={"endOfLifeTime": soon}),
            {"modelId": TITAN, "modelLifecycle": {"status": "ACTIVE", "endOfLifeTime": soon}},
            {"modelId": TITAN, "modelLifecycle": {"status": "ACTIVE", "end_of_life_date": soon}},
        ):
            findings = self.one(entry, None)
            self.assertEqual(len(findings), 1, entry)
            self.assertEqual(findings[0]["days_left"], 30)

    def test_the_earlier_of_the_registry_and_bedrock_dates_is_used(self):
        entry = {"modelId": TITAN, "modelLifecycle": {"status": "ACTIVE", "endOfLifeTime": days_from_today(20).isoformat()}}
        self.assertEqual(self.one(entry, days_from_today(60))[0]["days_left"], 20)
        self.assertEqual(self.one(entry, days_from_today(5))[0]["days_left"], 5)

    def test_without_a_date_in_the_response_the_registry_date_is_used(self):
        self.assertEqual(self.one(summary(TITAN), days_from_today(10))[0]["days_left"], 10)

    def test_a_region_that_could_not_be_checked_is_reported_as_check_failed(self):
        models = {(REGION, TITAN): lc.ModelInUse(TITAN, REGION, ["x"])}
        findings = lc.evaluate(models, {REGION: None}, TODAY)
        self.assertEqual(len(findings), 1)
        self.assertIn("check failed", findings[0]["reason"])

    def test_listing_ids_with_extra_suffix_fields_still_match(self):
        entry = summary(TITAN + ":8k")
        models = {(REGION, TITAN): lc.ModelInUse(TITAN, REGION, ["x"])}
        self.assertEqual(lc.evaluate(models, {REGION: listing(entry)}, TODAY), [])


class HandlerTests(unittest.TestCase):
    def test_everything_active_publishes_nothing(self):
        env = Env(self, spaces=[space()], generation={"/KC/LLM/HaikuArn": HAIKU},
                  listings={REGION: listing(summary(TITAN), summary(HAIKU))})
        result = env.run()
        self.assertEqual(result, {"models": 2, "findings": 0, "published": False})
        env.sns.publish.assert_not_called()

    def test_one_message_per_run_with_model_region_reason_and_days(self):
        env = Env(
            self,
            spaces=[space(eol_date=days_from_today(40)), space("cohere-v3-1024", COHERE, COHERE)],
            generation={"/KC/LLM/HaikuArn": HAIKU},
            listings={REGION: listing(summary(TITAN), summary(COHERE, "LEGACY"))},   # HAIKU missing
        )
        result = env.run()
        self.assertTrue(result["published"])
        self.assertEqual(len(env.published), 1)
        message = env.message()
        self.assertIn(f"{TITAN} | {REGION}", message)
        self.assertIn("days left: 40", message)
        self.assertIn(f"{COHERE} | {REGION} | lifecycle status is LEGACY", message)
        self.assertIn(f"{HAIKU} | {REGION} | missing", message)
        self.assertEqual(env.sns.publish.call_args.kwargs["TopicArn"], "arn:aws:sns:ca-central-1:111122223333:topic")
        self.assertLessEqual(len(env.sns.publish.call_args.kwargs["Subject"]), 100)

    def test_purged_spaces_are_excluded_by_the_query(self):
        env = Env(self, spaces=[space()], listings={REGION: listing(summary(TITAN))})
        env.run()
        sql = env.connection.sql[0]
        self.assertIn("FROM embedding_spaces", sql)
        self.assertIn("status <> 'purged'", sql)
        self.assertTrue(env.connection.closed)

    def test_each_region_is_listed_once(self):
        profile = "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.titan-embed-text-v2:0"
        env = Env(
            self,
            spaces=[space("a"), space("b"), space("c", invoke_target=profile), space("d", COHERE, COHERE)],
            generation={"/KC/LLM/HaikuArn": HAIKU},
            listings={
                REGION: listing(summary(TITAN), summary(COHERE), summary(HAIKU)),
                "us-east-1": listing(summary(TITAN)),
            },
        )
        env.run()
        self.assertEqual(sorted(env.list_calls), [REGION, "us-east-1"])

    def test_a_failing_region_still_alerts_for_the_others_and_records_the_failure(self):
        profile = "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.amazon.titan-embed-text-v2:0"
        env = Env(
            self,
            spaces=[space("legacy-one", COHERE, COHERE), space("far", invoke_target=profile)],
            listings={REGION: listing(summary(COHERE, "LEGACY")), "us-east-1": RuntimeError("AccessDenied")},
        )
        result = env.run()
        self.assertTrue(result["published"])
        message = env.message()
        self.assertIn(f"{COHERE} | {REGION} | lifecycle status is LEGACY", message)
        self.assertIn(f"{TITAN} | us-east-1 | check failed", message)
        self.assertNotIn("AccessDenied", message)

    def test_a_database_outage_does_not_hide_the_generation_models(self):
        env = Env(self, db_error=RuntimeError("password authentication failed for user kc_app"),
                  generation={"/KC/LLM/HaikuArn": HAIKU}, listings={REGION: listing(summary(HAIKU, "LEGACY"))})
        with self.assertLogs(level="ERROR") as logs:
            result = env.run()
        self.assertTrue(result["published"])
        message = env.message()
        self.assertIn("registry could not be read", message)
        self.assertIn(f"{HAIKU} | {REGION} | lifecycle status is LEGACY", message)
        self.assertNotIn("password", message)
        self.assertNotIn("password", "\n".join(logs.output))   # error class name only

    def test_the_alert_carries_no_secrets_or_connection_details(self):
        env = Env(self, spaces=[space(eol_date=days_from_today(10))], listings={REGION: listing(summary(TITAN))})
        env.run()
        text = env.message() + env.sns.publish.call_args.kwargs["Subject"]
        for forbidden in ("kc/db", "proxy", "password", "secret", "SM_DB_CREDENTIALS", "RDS_PROXY_ENDPOINT"):
            self.assertNotIn(forbidden, text)

    def test_a_missing_topic_is_an_error_not_a_silent_skip(self):
        env = Env(self, spaces=[space(eol_date=days_from_today(10))], listings={REGION: listing(summary(TITAN))}, topic="")
        with self.assertLogs(level="ERROR"), self.assertRaises(RuntimeError):
            env.run()

    def test_generation_parameters_come_from_configuration(self):
        env = Env(self, generation={"/KC/LLM/HaikuArn": HAIKU}, listings={REGION: listing(summary(HAIKU))})
        env.run()
        names = env.ssm.get_parameters.call_args.kwargs["Names"]
        self.assertEqual(names, ["/KC/LLM/HaikuArn"])


class DbTlsTests(unittest.TestCase):
    def test_connect_uses_verify_full_with_a_real_ca_bundle(self):
        psycopg2 = mock.Mock()
        secrets = mock.Mock()
        secrets.get_secret_value.return_value = {
            "SecretString": json.dumps({"dbname": "d", "username": "u", "password": "p", "port": 5432})
        }
        with mock.patch.dict(sys.modules, {"psycopg2": psycopg2}), \
                mock.patch.object(lc, "_secrets_client", return_value=secrets), \
                mock.patch.dict(os.environ, {"SM_DB_CREDENTIALS": "s", "RDS_PROXY_ENDPOINT": "proxy.example"}):
            lc._connect_to_db()
        kwargs = psycopg2.connect.call_args.kwargs
        self.assertEqual(kwargs["sslmode"], "verify-full")
        self.assertTrue(os.path.isfile(kwargs["sslrootcert"]))


if __name__ == "__main__":
    unittest.main()
