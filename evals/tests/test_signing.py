import json
import unittest
from unittest import mock

from evals.harness import signing

USER = "2f0d8c1a-3e2e-4c5d-9c86-1f0a4f1c0d11"


class SigningTest(unittest.TestCase):
    def test_matches_js_verifier_test_vector(self):
        # Same vector as cdk/lambda/handlers/tests/evalTag.test.js.
        self.assertEqual(
            signing.sign("k" * 48, USER, "run_1", "guideline", 1900000000),
            "92d282dcea2752c83ef6873359c98561a7136b0963661791ef94ecf70810379d",
        )

    def test_make_tag(self):
        tag = signing.make_tag("k" * 48, USER, "run_1", "standard", lifetime_seconds=3600, now=1000)
        self.assertEqual(tag["exp"], 4600)
        self.assertEqual(tag["sig"], signing.sign("k" * 48, USER, "run_1", "standard", 4600))
        self.assertEqual(set(tag), {"run_id", "mode", "exp", "sig"})

    def test_lifetime_stays_under_server_cap(self):
        tag = signing.make_tag("k" * 48, USER, "r", "standard", lifetime_seconds=10 ** 9, now=0)
        self.assertLess(tag["exp"], signing.MAX_TAG_LIFETIME_SECONDS)

    def test_rejects_bad_inputs(self):
        with self.assertRaises(ValueError):
            signing.make_tag("k" * 48, USER, "bad id", "standard")
        with self.assertRaises(ValueError):
            signing.make_tag("k" * 48, USER, "r", "admin")


class KeyProviderTest(unittest.TestCase):
    def test_fetches_once_and_hides_key(self):
        client = mock.Mock()
        client.get_secret_value.return_value = {"SecretString": json.dumps({"signingKey": "x" * 64})}
        provider = signing.SigningKeyProvider("KC/eval/signing-secret", "ca-central-1", secrets_client=client)
        self.assertEqual(provider.key(), "x" * 64)
        self.assertEqual(provider.key(), "x" * 64)
        client.get_secret_value.assert_called_once_with(SecretId="KC/eval/signing-secret")
        self.assertNotIn("x" * 10, repr(provider))

    def test_unusable_secret(self):
        client = mock.Mock()
        client.get_secret_value.return_value = {"SecretString": json.dumps({"signingKey": "short"})}
        with self.assertRaises(RuntimeError):
            signing.SigningKeyProvider("s", "r", secrets_client=client).key()


if __name__ == "__main__":
    unittest.main()
