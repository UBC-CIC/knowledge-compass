"""
Unit tests for helpers/embeddings.py (shared embedding interface).

No AWS access: a fake bedrock-runtime client records invoke_model calls, and
the throttling test drives a real botocore client through an in-process fake
HTTP layer. Run from the textGeneration dir:

    py -3 -m unittest discover -s tests -p "test_*.py"
"""

import io
import json
import os
import sys
import threading
import time
import unittest
from unittest import mock

import botocore.awsrequest
import urllib3.response

# Make `helpers` importable when running from the textGeneration directory.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from helpers import embeddings  # noqa: E402
from helpers.embeddings import (  # noqa: E402
    DEFAULT_SPEC,
    EmbeddingDimensionError,
    EmbeddingError,
    ModelSpec,
)


class FakeBody:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class FakeClient:
    """Records invoke_model calls; `responder(body_dict) -> response dict`."""

    def __init__(self, responder, delay=None):
        self.responder = responder
        self.delay = delay
        self.calls = []
        self._lock = threading.Lock()
        self.active = 0
        self.max_active = 0

    def invoke_model(self, **kwargs):
        body = json.loads(kwargs["body"])
        with self._lock:
            self.calls.append({"kwargs": kwargs, "body": body})
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay(body))
            return {"body": FakeBody(self.responder(body))}
        finally:
            with self._lock:
                self.active -= 1


def v3_responder(dim=1024):
    return lambda body: {"embeddings": [[float(len(t))] * dim for t in body["texts"]]}


# ── Cohere v3 (default behavior, must not change) ─────────────────────────────

class CohereV3Tests(unittest.TestCase):
    def test_default_spec_matches_current_production_behavior(self):
        self.assertEqual(
            DEFAULT_SPEC,
            ModelSpec("cohere_v3", "cohere.embed-english-v3", 1024, 96, 2048, 1),
        )

    def test_document_request_body_and_envelope(self):
        client = FakeClient(v3_responder())
        out = embeddings.embed_documents(["alpha", "beta"], DEFAULT_SPEC, client=client)
        self.assertEqual(len(client.calls), 1)
        call = client.calls[0]
        self.assertEqual(
            call["body"],
            {"texts": ["alpha", "beta"], "input_type": "search_document", "truncate": "END"},
        )
        self.assertEqual(call["kwargs"]["modelId"], "cohere.embed-english-v3")
        self.assertEqual(call["kwargs"]["contentType"], "application/json")
        self.assertEqual(call["kwargs"]["accept"], "application/json")
        self.assertEqual([len(v) for v in out], [1024, 1024])
        self.assertEqual(out[0][0], 5.0)

    def test_query_request_body(self):
        client = FakeClient(v3_responder())
        vector = embeddings.embed_query("how do I plan a transition", DEFAULT_SPEC, client=client)
        self.assertEqual(
            client.calls[0]["body"],
            {
                "texts": ["how do I plan a transition"],
                "input_type": "search_query",
                "truncate": "END",
            },
        )
        self.assertEqual(len(vector), 1024)

    def test_250_texts_split_96_96_58_in_order(self):
        texts = [f"t{i}" for i in range(250)]
        client = FakeClient(lambda body: {"embeddings": [[float(t[1:])] * 1024 for t in body["texts"]]})
        out = embeddings.embed_documents(texts, DEFAULT_SPEC, client=client)
        self.assertEqual([len(c["body"]["texts"]) for c in client.calls], [96, 96, 58])
        self.assertEqual([v[0] for v in out], [float(i) for i in range(250)])

    def test_document_truncation_is_at_word_boundary_2048(self):
        text = ("word " * 600).strip()  # 2999 chars
        client = FakeClient(v3_responder())
        embeddings.embed_documents([text], DEFAULT_SPEC, client=client)
        sent = client.calls[0]["body"]["texts"][0]
        self.assertEqual(sent, text[:2048].rsplit(" ", 1)[0])
        self.assertLessEqual(len(sent), 2048)
        self.assertTrue(sent.endswith("word"))
        self.assertEqual(embeddings.embedding_input(text, DEFAULT_SPEC), sent)

    def test_short_text_is_not_modified(self):
        text = "x" * 2048
        self.assertEqual(embeddings.embedding_input(text, DEFAULT_SPEC), text)

    def test_query_truncation_is_plain_slice(self):
        query = ("word " * 600).strip()
        client = FakeClient(v3_responder())
        embeddings.embed_query(query, DEFAULT_SPEC, client=client)
        self.assertEqual(client.calls[0]["body"]["texts"], [query[:2048]])

    def test_texts_with_no_space_are_cut_to_2048(self):
        client = FakeClient(v3_responder())
        embeddings.embed_documents(["a" * 3000], DEFAULT_SPEC, client=client)
        self.assertEqual(len(client.calls[0]["body"]["texts"][0]), 2048)

    def test_query_input_type_for_batch_helper(self):
        client = FakeClient(v3_responder())
        embeddings.embed_texts(["a", "b"], DEFAULT_SPEC, "search_query", client=client)
        self.assertEqual(client.calls[0]["body"]["input_type"], "search_query")

    def test_empty_input_makes_no_call(self):
        client = FakeClient(v3_responder())
        self.assertEqual(embeddings.embed_documents([], DEFAULT_SPEC, client=client), [])
        self.assertEqual(client.calls, [])

    def test_invoke_target_override(self):
        spec = embeddings.with_invoke_target(DEFAULT_SPEC, "arn:aws:bedrock:x:1:inference-profile/p")
        client = FakeClient(v3_responder())
        embeddings.embed_documents(["a"], spec, client=client)
        self.assertEqual(client.calls[0]["kwargs"]["modelId"], "arn:aws:bedrock:x:1:inference-profile/p")

    def test_dimension_mismatch_raises(self):
        client = FakeClient(v3_responder(dim=512))
        with self.assertRaises(EmbeddingDimensionError):
            embeddings.embed_documents(["a"], DEFAULT_SPEC, client=client)
        with self.assertRaises(EmbeddingDimensionError):
            embeddings.embed_query("a", DEFAULT_SPEC, client=client)

    def test_embedding_count_mismatch_raises(self):
        client = FakeClient(lambda body: {"embeddings": [[0.0] * 1024]})
        with self.assertRaises(EmbeddingError):
            embeddings.embed_documents(["a", "b"], DEFAULT_SPEC, client=client)

    def test_batch_size_above_cohere_v3_limit_rejected(self):
        spec = ModelSpec("cohere_v3", "cohere.embed-english-v3", 1024, 97, 2048)
        with self.assertRaises(ValueError):
            embeddings.validate_spec(spec)

    def test_non_throttle_errors_are_not_swallowed(self):
        def boom(body):
            raise RuntimeError("model exploded")

        with self.assertRaises(RuntimeError):
            embeddings.embed_documents(["a"], DEFAULT_SPEC, client=FakeClient(boom))


# ── Client config and throttling ──────────────────────────────────────────────

class _Raw:
    """urllib3-style response factory for the fake HTTP layer."""

    @staticmethod
    def response(status, payload, headers=None):
        body = json.dumps(payload).encode("utf-8")
        h = {"content-type": "application/json", "content-length": str(len(body))}
        h.update(headers or {})
        raw = urllib3.response.HTTPResponse(
            body=io.BytesIO(body), headers=h, status=status, preload_content=False
        )
        return botocore.awsrequest.AWSResponse("https://example.invalid", status, h, raw)


class ClientTests(unittest.TestCase):
    ENV = {
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "AWS_DEFAULT_REGION": "us-east-1",
    }

    def setUp(self):
        patcher = mock.patch.dict(os.environ, self.ENV)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("AWS_PROFILE", None)
        embeddings._clients.clear()
        self.addCleanup(embeddings._clients.clear)

    def test_client_is_cached_per_region(self):
        a = embeddings.get_bedrock_client("us-east-1")
        self.assertIs(a, embeddings.get_bedrock_client("us-east-1"))
        self.assertIsNot(a, embeddings.get_bedrock_client("ca-central-1"))

    def test_client_uses_adaptive_retries(self):
        client = embeddings.get_bedrock_client("us-east-1")
        retries = client.meta.config.retries
        self.assertEqual(retries["mode"], "adaptive")
        # Config(max_attempts=10) means 10 retries; botocore stores 11 total attempts.
        self.assertEqual(retries["total_max_attempts"], 11)

    def test_fail_fast_client_keeps_boto3_default_retries(self):
        fast = embeddings.get_bedrock_client("us-east-1", fail_fast=True)
        self.assertIsNot(fast, embeddings.get_bedrock_client("us-east-1"))
        self.assertIs(fast, embeddings.get_bedrock_client("us-east-1", fail_fast=True))
        self.assertNotEqual(fast.meta.config.retries.get("mode"), "adaptive")
        # No explicit retry config: botocore's own defaults apply (<= 5 attempts).
        self.assertLess(fast.meta.config.retries.get("total_max_attempts", 5), 11)

    def test_query_embedding_uses_fail_fast_client(self):
        with mock.patch.object(embeddings, "get_bedrock_client") as getter:
            getter.return_value = FakeClient(v3_responder())
            embeddings.embed_query("hello", DEFAULT_SPEC, "us-east-1")
        getter.assert_called_once_with("us-east-1", fail_fast=True)

    def test_document_embedding_uses_adaptive_client(self):
        with mock.patch.object(embeddings, "get_bedrock_client") as getter:
            getter.return_value = FakeClient(v3_responder())
            embeddings.embed_documents(["hello"], DEFAULT_SPEC, "us-east-1")
        getter.assert_called_once_with("us-east-1")

    def test_malformed_responses_raise_embedding_error(self):
        with self.assertRaises(embeddings.EmbeddingError):
            embeddings.embed_documents(["a"], DEFAULT_SPEC, client=FakeClient(lambda body: {}))
        with self.assertRaises(embeddings.EmbeddingError):
            embeddings.embed_query("a", DEFAULT_SPEC, client=FakeClient(lambda body: {"x": 1}))
        with self.assertRaises(embeddings.EmbeddingError):
            embeddings.embed_documents(
                ["a"], titan_spec(), client=FakeClient(lambda body: {"nope": []})
            )

    def test_throttling_is_retried_then_succeeds(self):
        client = embeddings.get_bedrock_client("us-east-1")
        attempts = []

        def fake_send(request, **kwargs):
            attempts.append(1)
            if len(attempts) <= 2:
                return _Raw.response(
                    429,
                    {"message": "Too many requests"},
                    {"x-amzn-errortype": "ThrottlingException"},
                )
            return _Raw.response(200, {"embeddings": [[0.5] * 1024]})

        client.meta.events.register("before-send.bedrock-runtime.InvokeModel", fake_send)
        with mock.patch("time.sleep"):
            out = embeddings.embed_documents(["hello"], DEFAULT_SPEC, client=client)
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len(out[0]), 1024)

    def test_non_throttle_client_error_is_not_retried(self):
        from botocore.exceptions import ClientError

        client = embeddings.get_bedrock_client("us-east-1")
        attempts = []

        def fake_send(request, **kwargs):
            attempts.append(1)
            return _Raw.response(
                400, {"message": "bad input"}, {"x-amzn-errortype": "ValidationException"}
            )

        client.meta.events.register("before-send.bedrock-runtime.InvokeModel", fake_send)
        with mock.patch("time.sleep"):
            with self.assertRaises(ClientError):
                embeddings.embed_documents(["hello"], DEFAULT_SPEC, client=client)
        self.assertEqual(len(attempts), 1)


# ── Titan V2 ──────────────────────────────────────────────────────────────────

def titan_spec(**overrides):
    values = dict(
        provider="titan_v2",
        invoke_target="amazon.titan-embed-text-v2:0",
        dimensions=512,
        batch_size=1,
        max_chars=8000,
        concurrency=4,
    )
    values.update(overrides)
    return ModelSpec(**values)


def titan_responder(dim):
    return lambda body: {"embedding": [float(len(body["inputText"]))] * dim, "inputTextTokenCount": 1}


class TitanV2Tests(unittest.TestCase):
    def test_request_body_has_no_input_type(self):
        client = FakeClient(titan_responder(512))
        embeddings.embed_documents(["hello"], titan_spec(), client=client)
        call = client.calls[0]
        self.assertEqual(
            call["body"], {"inputText": "hello", "dimensions": 512, "normalize": True}
        )
        self.assertEqual(call["kwargs"]["modelId"], "amazon.titan-embed-text-v2:0")

    def test_query_uses_same_body_shape(self):
        client = FakeClient(titan_responder(1024))
        vector = embeddings.embed_query("hello", titan_spec(dimensions=1024), client=client)
        self.assertEqual(
            client.calls[0]["body"], {"inputText": "hello", "dimensions": 1024, "normalize": True}
        )
        self.assertEqual(len(vector), 1024)

    def test_normalize_false_is_passed_through(self):
        client = FakeClient(titan_responder(256))
        embeddings.embed_documents(
            ["a"], titan_spec(dimensions=256, normalize=False), client=client
        )
        self.assertFalse(client.calls[0]["body"]["normalize"])

    def test_one_call_per_text_and_order_preserved_with_reversed_latency(self):
        texts = ["a" * (i + 1) for i in range(5)]
        # Earlier inputs are slower so completion order is reversed.
        client = FakeClient(
            titan_responder(512), delay=lambda body: 0.05 * (6 - len(body["inputText"]))
        )
        out = embeddings.embed_documents(texts, titan_spec(concurrency=5), client=client)
        self.assertEqual(len(client.calls), 5)
        self.assertEqual([v[0] for v in out], [1.0, 2.0, 3.0, 4.0, 5.0])

    def test_concurrency_bound_is_honored(self):
        texts = [f"t{i}" for i in range(12)]
        client = FakeClient(titan_responder(512), delay=lambda body: 0.02)
        embeddings.embed_documents(texts, titan_spec(concurrency=3), client=client)
        self.assertLessEqual(client.max_active, 3)
        self.assertGreaterEqual(client.max_active, 2)

    def test_concurrency_one_is_serial(self):
        client = FakeClient(titan_responder(512), delay=lambda body: 0.01)
        embeddings.embed_documents(["a", "b", "c"], titan_spec(concurrency=1), client=client)
        self.assertEqual(client.max_active, 1)

    def test_max_chars_truncates_at_word_boundary(self):
        text = "alpha beta gamma delta"
        client = FakeClient(titan_responder(512))
        embeddings.embed_documents([text], titan_spec(max_chars=13), client=client)
        self.assertEqual(client.calls[0]["body"]["inputText"], "alpha beta")

    def test_default_max_chars_is_configurable_default(self):
        self.assertEqual(embeddings.ADAPTERS["titan_v2"].default_max_chars, 8000)

    def test_dimension_mismatch_raises(self):
        client = FakeClient(titan_responder(256))
        with self.assertRaises(EmbeddingDimensionError):
            embeddings.embed_documents(["a"], titan_spec(dimensions=512), client=client)

    def test_disallowed_dimension_raises(self):
        for dims in (384, 1536, 2048):
            with self.assertRaises(ValueError):
                embeddings.validate_spec(titan_spec(dimensions=dims))
        for dims in (256, 512, 1024):
            embeddings.validate_spec(titan_spec(dimensions=dims))

    def test_empty_input(self):
        client = FakeClient(titan_responder(512))
        self.assertEqual(embeddings.embed_documents([], titan_spec(), client=client), [])


# ── Cohere v4 ─────────────────────────────────────────────────────────────────

def v4_spec(**overrides):
    values = dict(
        provider="cohere_v4",
        invoke_target="cohere.embed-v4",
        dimensions=1024,
        batch_size=96,
        max_chars=8000,
        concurrency=1,
    )
    values.update(overrides)
    return ModelSpec(**values)


class CohereV4Tests(unittest.TestCase):
    def test_document_request_body(self):
        client = FakeClient(
            lambda body: {
                "response_type": "embeddings_by_type",
                "embeddings": {"float": [[0.1] * 1024 for _ in body["texts"]]},
            }
        )
        embeddings.embed_documents(["a", "b"], v4_spec(), client=client)
        self.assertEqual(
            client.calls[0]["body"],
            {
                "input_type": "search_document",
                "texts": ["a", "b"],
                "embedding_types": ["float"],
                "output_dimension": 1024,
                "truncate": "RIGHT",
            },
        )
        self.assertEqual(client.calls[0]["kwargs"]["modelId"], "cohere.embed-v4")

    def test_query_input_type(self):
        client = FakeClient(
            lambda body: {"embeddings": {"float": [[0.1] * 1024 for _ in body["texts"]]}}
        )
        embeddings.embed_query("q", v4_spec(), client=client)
        self.assertEqual(client.calls[0]["body"]["input_type"], "search_query")

    def test_output_dimension_is_passed(self):
        client = FakeClient(lambda body: {"embeddings": {"float": [[0.1] * 512 for _ in body["texts"]]}})
        embeddings.embed_documents(["a"], v4_spec(dimensions=512), client=client)
        self.assertEqual(client.calls[0]["body"]["output_dimension"], 512)

    def test_parses_embeddings_by_type_shape(self):
        client = FakeClient(
            lambda body: {
                "response_type": "embeddings_by_type",
                "embeddings": {"float": [[0.25] * 1024]},
            }
        )
        out = embeddings.embed_documents(["a"], v4_spec(), client=client)
        self.assertEqual(out, [[0.25] * 1024])

    def test_parses_embeddings_floats_shape(self):
        client = FakeClient(
            lambda body: {"response_type": "embeddings_floats", "embeddings": [[0.5] * 1024]}
        )
        out = embeddings.embed_documents(["a"], v4_spec(), client=client)
        self.assertEqual(out, [[0.5] * 1024])

    def test_batches_by_spec_batch_size(self):
        client = FakeClient(
            lambda body: {"embeddings": {"float": [[0.1] * 1024 for _ in body["texts"]]}}
        )
        embeddings.embed_documents([f"t{i}" for i in range(5)], v4_spec(batch_size=2), client=client)
        self.assertEqual([len(c["body"]["texts"]) for c in client.calls], [2, 2, 1])

    def test_dimension_mismatch_raises(self):
        client = FakeClient(lambda body: {"embeddings": {"float": [[0.1] * 256]}})
        with self.assertRaises(EmbeddingDimensionError):
            embeddings.embed_documents(["a"], v4_spec(), client=client)

    def test_missing_embeddings_raises(self):
        client = FakeClient(lambda body: {"embeddings": {"int8": [[1] * 1024]}})
        with self.assertRaises(EmbeddingError):
            embeddings.embed_documents(["a"], v4_spec(), client=client)

    def test_disallowed_dimension_raises(self):
        with self.assertRaises(ValueError):
            embeddings.validate_spec(v4_spec(dimensions=768))
        embeddings.validate_spec(v4_spec(dimensions=1536))


# ── Registry / spec_from_row ──────────────────────────────────────────────────

class RegistryTests(unittest.TestCase):
    def test_registry_keys(self):
        self.assertEqual(set(embeddings.ADAPTERS), {"cohere_v3", "titan_v2", "cohere_v4"})

    def test_unknown_provider_raises(self):
        with self.assertRaises(ValueError):
            embeddings.get_adapter("nope")
        with self.assertRaises(ValueError):
            embeddings.validate_spec(ModelSpec("nope", "x", 1024, 1, 1))
        with self.assertRaises(ValueError):
            embeddings.embed_documents(["a"], ModelSpec("nope", "x", 1024, 1, 1), client=FakeClient(v3_responder()))

    def test_spec_from_row_uses_adapter_defaults(self):
        spec = embeddings.spec_from_row(
            {"provider": "titan_v2", "invoke_target": "amazon.titan-embed-text-v2:0", "dimensions": 512}
        )
        self.assertEqual(
            spec, titan_spec(batch_size=1, max_chars=8000, concurrency=8, normalize=True)
        )

    def test_spec_from_row_applies_settings_overrides(self):
        spec = embeddings.spec_from_row(
            {
                "provider": "titan_v2",
                "invoke_target": "t",
                "dimensions": "1024",
                "settings": json.dumps({"max_chars": 5000, "concurrency": 2, "normalize": False}),
            }
        )
        self.assertEqual((spec.dimensions, spec.max_chars, spec.concurrency, spec.normalize), (1024, 5000, 2, False))

    def test_spec_from_row_validates(self):
        with self.assertRaises(ValueError):
            embeddings.spec_from_row({"provider": "titan_v2", "invoke_target": "t", "dimensions": 384})


if __name__ == "__main__":
    unittest.main()
