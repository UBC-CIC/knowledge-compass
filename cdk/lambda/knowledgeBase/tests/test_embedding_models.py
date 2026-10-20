"""
Unit tests for helpers/embedding_models.py. No AWS calls: the matcher is pure,
and the client wrapper is given a fake.

Run from knowledgeBase:  python -m unittest discover -s tests -p "test_embedding_models.py"
"""

import _setup  # noqa: F401  (must be first)

import unittest

from helpers import embedding_models as em

REGION = "ca-central-1"
TITAN = "amazon.titan-embed-text-v2:0"
COHERE = "cohere.embed-english-v3"
COHERE_V4 = "cohere.embed-v4:0"
PROFILE_ARN = f"arn:aws:bedrock:{REGION}:111122223333:inference-profile/us.{TITAN}"


def foundation(model_id, on_demand=True, region=REGION):
    summary = {
        "modelId": model_id,
        "modelArn": f"arn:aws:bedrock:{region}::foundation-model/{model_id}",
        "modelLifecycle": {"status": "ACTIVE"},
    }
    if on_demand:
        summary["inferenceTypesSupported"] = ["ON_DEMAND"]
    return summary


def profile(model_id, arn=None, profile_id=None, status="ACTIVE", model_region=REGION):
    return {
        "inferenceProfileId": profile_id or f"us.{model_id}",
        "inferenceProfileArn": arn or f"arn:aws:bedrock:{REGION}:111122223333:inference-profile/us.{model_id}",
        "status": status,
        "type": "SYSTEM_DEFINED",
        "models": [{"modelArn": f"arn:aws:bedrock:{model_region}::foundation-model/{model_id}"}],
    }


def by_provider(entries):
    return {entry["provider"]: entry for entry in entries}


class MatchModelsTest(unittest.TestCase):
    def test_an_on_demand_model_uses_its_model_id(self):
        entries = by_provider(em.match_models(
            [foundation(TITAN), foundation(COHERE), foundation(COHERE_V4)],
            [],
            REGION,
        ))
        titan = entries["titan_v2"]
        self.assertTrue(titan["available"])
        self.assertEqual(titan["model_id"], TITAN)
        self.assertEqual(titan["invoke_target"], TITAN)
        self.assertFalse(titan["cross_region"])
        self.assertIsNone(titan["unavailable_reason"])
        self.assertEqual(titan["dimensions"], [256, 512, 1024])
        self.assertEqual(entries["cohere_v3"]["dimensions"], [1024])
        self.assertEqual(entries["cohere_v4"]["dimensions"], [256, 512, 1024, 1536])

    def test_on_demand_wins_over_an_inference_profile(self):
        entries = by_provider(em.match_models(
            [foundation(TITAN, on_demand=True)],
            [profile(TITAN)],
            REGION,
        ))
        self.assertEqual(entries["titan_v2"]["invoke_target"], TITAN)
        self.assertFalse(entries["titan_v2"]["cross_region"])

    def test_a_model_without_on_demand_uses_the_profile_arn(self):
        entries = by_provider(em.match_models(
            [foundation(TITAN, on_demand=False)],
            [profile(TITAN, arn=PROFILE_ARN, model_region="us-east-1")],
            REGION,
        ))
        titan = entries["titan_v2"]
        self.assertTrue(titan["available"])
        self.assertEqual(titan["model_id"], TITAN)
        self.assertEqual(titan["invoke_target"], PROFILE_ARN)
        self.assertTrue(titan["cross_region"])

    def test_a_geo_prefixed_profile_id_matches_the_foundation_model(self):
        listed = profile(TITAN, profile_id=f"us.{TITAN}", model_region="us-east-1")
        listed["inferenceProfileArn"] = ""
        entries = by_provider(em.match_models(
            [foundation(TITAN, on_demand=False)],
            [listed],
            REGION,
        ))
        self.assertEqual(entries["titan_v2"]["invoke_target"], f"us.{TITAN}")
        self.assertTrue(entries["titan_v2"]["cross_region"])

    def test_a_profile_is_enough_when_the_foundation_model_is_not_listed(self):
        arn = f"arn:aws:bedrock:{REGION}:111122223333:inference-profile/us.{COHERE_V4}"
        entries = by_provider(em.match_models(
            [],
            [profile(COHERE_V4, arn=arn, profile_id=f"us.{COHERE_V4}", model_region="us-east-1")],
            REGION,
        ))
        chosen = entries["cohere_v4"]
        self.assertTrue(chosen["available"])
        self.assertEqual(chosen["model_id"], COHERE_V4)
        self.assertEqual(chosen["invoke_target"], arn)
        self.assertTrue(chosen["cross_region"])
        self.assertIsNone(chosen["unavailable_reason"])
        self.assertFalse(entries["titan_v2"]["available"])

    def test_an_unlisted_model_is_unavailable(self):
        entries = by_provider(em.match_models([foundation(COHERE)], [], REGION))
        titan = entries["titan_v2"]
        self.assertFalse(titan["available"])
        self.assertIsNone(titan["model_id"])
        self.assertIsNone(titan["invoke_target"])
        self.assertEqual(titan["unavailable_reason"], em.NOT_LISTED)
        self.assertEqual(
            [entry["provider"] for entry in em.match_models([], [], REGION)],
            list(em.CATALOG),
        )

    def test_a_listed_model_with_no_way_to_call_it_says_why(self):
        entries = by_provider(em.match_models([foundation(TITAN, on_demand=False)], [], REGION))
        self.assertFalse(entries["titan_v2"]["available"])
        self.assertEqual(entries["titan_v2"]["model_id"], TITAN)
        self.assertEqual(entries["titan_v2"]["unavailable_reason"], em.NOT_CALLABLE)

    def test_an_inactive_profile_is_ignored(self):
        entries = by_provider(em.match_models(
            [foundation(TITAN, on_demand=False)],
            [profile(TITAN, status="LEGACY")],
            REGION,
        ))
        self.assertFalse(entries["titan_v2"]["available"])

    def test_an_in_region_profile_is_preferred_over_a_cross_region_one(self):
        local_arn = f"arn:aws:bedrock:{REGION}:111122223333:application-inference-profile/abc"
        local = profile(TITAN, arn=local_arn, profile_id="abc", model_region=REGION)
        entries = by_provider(em.match_models(
            [foundation(TITAN, on_demand=False)],
            [profile(TITAN, model_region="us-east-1"), local],
            REGION,
        ))
        self.assertEqual(entries["titan_v2"]["invoke_target"], local_arn)
        self.assertFalse(entries["titan_v2"]["cross_region"])

    def test_cohere_v4_falls_through_to_the_next_known_id(self):
        entries = by_provider(em.match_models(
            [foundation("cohere.embed-v4:0", on_demand=False), foundation("cohere.embed-v4")],
            [],
            REGION,
        ))
        self.assertTrue(entries["cohere_v4"]["available"])
        self.assertEqual(entries["cohere_v4"]["model_id"], "cohere.embed-v4")
        self.assertEqual(entries["cohere_v4"]["invoke_target"], "cohere.embed-v4")

    def test_unknown_embedding_models_are_not_offered(self):
        entries = em.match_models([foundation("amazon.titan-embed-g1-text")], [], REGION)
        self.assertEqual(len(entries), len(em.CATALOG))
        self.assertTrue(all(not entry["available"] for entry in entries))

    def test_catalog_providers_match_the_adapters(self):
        from helpers import embeddings
        self.assertEqual(set(em.CATALOG), set(embeddings.ADAPTERS))


class ListEmbeddingModelsTest(unittest.TestCase):
    def test_pages_profiles_and_filters_embedding_models(self):
        calls = []

        class Client:
            def list_foundation_models(self, **kwargs):
                calls.append(("models", kwargs))
                return {"modelSummaries": [foundation(TITAN)]}

            def list_inference_profiles(self, **kwargs):
                calls.append(("profiles", kwargs))
                if "nextToken" not in kwargs:
                    return {"inferenceProfileSummaries": [], "nextToken": "page-2"}
                return {"inferenceProfileSummaries": [profile(COHERE)]}

        entries = by_provider(em.list_embedding_models(client=Client(), region=REGION))
        self.assertEqual(calls[0], ("models", {"byOutputModality": "EMBEDDING"}))
        self.assertEqual([call[0] for call in calls], ["models", "profiles", "profiles"])
        self.assertEqual(calls[2][1], {"nextToken": "page-2"})
        self.assertTrue(entries["titan_v2"]["available"])
        # The Cohere profile arrives on the second page and is enough on its own.
        self.assertTrue(entries["cohere_v3"]["available"])
        self.assertEqual(entries["cohere_v3"]["model_id"], COHERE)

    def test_a_failed_profile_list_still_returns_on_demand_models(self):
        class Client:
            def list_foundation_models(self, **kwargs):
                return {"modelSummaries": [foundation(COHERE)]}

            def list_inference_profiles(self, **kwargs):
                raise RuntimeError("access denied")

        entries = by_provider(em.list_embedding_models(client=Client(), region=REGION))
        self.assertTrue(entries["cohere_v3"]["available"])
        self.assertEqual(entries["cohere_v3"]["invoke_target"], COHERE)
        self.assertFalse(entries["titan_v2"]["available"])
