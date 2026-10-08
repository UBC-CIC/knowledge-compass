"""
Guards the knowledgeBase copy of helpers/embeddings.py (packaged separately from
textGeneration) and the document-batch wiring that depends on it. Byte parity
with the canonical file is enforced in textGeneration/tests/test_shared_module_parity.py.
"""

import json
import sys
import types
import unittest
from unittest import mock

import _setup  # noqa: F401  (must run before importing helpers)

# python-docx needs the Lambda's vendored linux lxml; embedding never touches
# DOCX, so a stub keeps this test runnable on any machine (same approach as
# test_guideline_document.py).
try:  # pragma: no cover - depends on the local interpreter
    import docx  # noqa: F401
except Exception:  # noqa: BLE001
    _docx = types.ModuleType("docx")
    _docx.Document = object
    sys.modules["docx"] = _docx

from helpers import embeddings  # noqa: E402
from helpers import process_document_batch as batch  # noqa: E402


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


class EmbeddingsMirrorTests(unittest.TestCase):
    def test_cohere_v3_request_body(self):
        client = FakeClient()
        embeddings.embed_documents(["alpha", "beta"], embeddings.DEFAULT_SPEC, client=client)
        kwargs, body = client.calls[0]
        self.assertEqual(kwargs["modelId"], "cohere.embed-english-v3")
        self.assertEqual(
            body, {"texts": ["alpha", "beta"], "input_type": "search_document", "truncate": "END"}
        )

    def test_batches_of_96(self):
        client = FakeClient()
        embeddings.embed_documents([f"t{i}" for i in range(250)], embeddings.DEFAULT_SPEC, client=client)
        self.assertEqual([len(b["texts"]) for _, b in client.calls], [96, 96, 58])


class ProcessDocumentBatchWiringTests(unittest.TestCase):
    def test_embed_texts_uses_shared_module_with_default_spec(self):
        client = FakeClient()
        text = ("word " * 600).strip()
        with mock.patch.object(embeddings, "get_bedrock_client", return_value=client) as get_client:
            out = batch._embed_texts([text, "short"])
        get_client.assert_called_once_with(batch.REGION)
        self.assertEqual(len(out), 2)
        kwargs, body = client.calls[0]
        self.assertEqual(kwargs["modelId"], "cohere.embed-english-v3")
        self.assertEqual(body["input_type"], "search_document")
        self.assertEqual(body["truncate"], "END")
        self.assertEqual(body["texts"], [text[:2048].rsplit(" ", 1)[0], "short"])

    def test_embedding_input_matches_previous_reuse_key(self):
        text = ("word " * 600).strip()
        self.assertEqual(batch._embedding_input(text), text[:2048].rsplit(" ", 1)[0])
        self.assertEqual(batch._embedding_input("short"), "short")

    def test_module_constants_unchanged(self):
        self.assertEqual(batch.EMBED_MODEL_ID, "cohere.embed-english-v3")
        self.assertEqual(batch.EMBED_BATCH_SIZE, 96)


if __name__ == "__main__":
    unittest.main()
