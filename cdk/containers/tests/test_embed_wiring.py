"""
Checks that the crawler and transcriber embed through the shared
common/embeddings.py with unchanged Cohere v3 request bodies.

crawlee, trafilatura, bs4 and psycopg2 are not needed for embedding and are not
installed on a developer machine, so they are stubbed in sys.modules while the
scripts are imported. No AWS access. Run from cdk/:

    py -3 -m unittest discover -s containers/tests -p "test_*.py"
"""

import importlib.util
import json
import os
import sys
import types
import unittest
from unittest import mock

_CONTAINERS = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class FakeBody:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class FakeClient:
    def __init__(self):
        self.calls = []

    def invoke_model(self, **kwargs):
        body = json.loads(kwargs["body"])
        self.calls.append((kwargs, body))
        return {"body": FakeBody({"embeddings": [[0.0] * 1024 for _ in body["texts"]]})}


def _stub(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


def _load(name, rel_path):
    stubs = {
        "psycopg2": _stub("psycopg2"),
        "crawlee": _stub("crawlee"),
        "crawlee.crawlers": _stub(
            "crawlee.crawlers", PlaywrightCrawler=object, PlaywrightCrawlingContext=object
        ),
        "trafilatura": _stub("trafilatura"),
        "bs4": _stub("bs4", BeautifulSoup=object),
    }
    path = os.path.join(_CONTAINERS, *rel_path.split("/"))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, stubs), mock.patch.dict(
        os.environ, {"AWS_DEFAULT_REGION": "us-east-1"}
    ):
        # `from common import ...` resolves against cdk/containers.
        sys.path.insert(0, _CONTAINERS)
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.remove(_CONTAINERS)
    return module


class _WiringMixin:
    module_name = ""
    rel_path = ""

    @classmethod
    def setUpClass(cls):
        cls.mod = _load(cls.module_name, cls.rel_path)

    def run_embed(self, texts, **kwargs):
        client = FakeClient()
        with mock.patch.object(self.mod.shared_embeddings, "get_bedrock_client", return_value=client):
            out = self.mod.embed_texts(texts, **kwargs)
        return out, client

    def test_document_request_body_and_truncation(self):
        long_text = ("word " * 600).strip()
        out, client = self.run_embed([long_text, "short"])
        self.assertEqual(len(out), 2)
        kwargs, body = client.calls[0]
        self.assertEqual(kwargs["modelId"], "cohere.embed-english-v3")
        self.assertEqual(kwargs["contentType"], "application/json")
        self.assertEqual(kwargs["accept"], "application/json")
        self.assertEqual(
            body,
            {
                "texts": [long_text[:2048].rsplit(" ", 1)[0], "short"],
                "input_type": "search_document",
                "truncate": "END",
            },
        )

    def test_query_input_type_is_forwarded(self):
        _, client = self.run_embed(["a"], input_type="search_query")
        self.assertEqual(client.calls[0][1]["input_type"], "search_query")

    def test_batches_of_96(self):
        _, client = self.run_embed([f"t{i}" for i in range(250)])
        self.assertEqual([len(b["texts"]) for _, b in client.calls], [96, 96, 58])

    def test_region_comes_from_db_config(self):
        client = FakeClient()
        with mock.patch.object(
            self.mod.shared_embeddings, "get_bedrock_client", return_value=client
        ) as get_client:
            self.mod.embed_texts(["a"])
        get_client.assert_called_once_with(self.mod.REGION)


class CrawlerEmbedWiringTests(_WiringMixin, unittest.TestCase):
    module_name = "kc_crawler_under_test"
    rel_path = "crawler/crawler.py"


class TranscriberEmbedWiringTests(_WiringMixin, unittest.TestCase):
    module_name = "kc_transcriber_under_test"
    rel_path = "transcriber/transcrbe.py"


if __name__ == "__main__":
    unittest.main()
