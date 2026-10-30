"""
Rotation of the application's generated keys. Secrets Manager is faked.

Run from the appSecretRotation dir:

    python -m unittest discover -s tests -v
"""

import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import index  # noqa: E402


class NotFound(Exception):
    pass


class FakeSecrets:
    """One secret with versions -> (stages, SecretString)."""

    exceptions = type("Exceptions", (), {"ResourceNotFoundException": NotFound})

    def __init__(self, current: dict, token="v2"):
        self.versions = {"v1": (["AWSCURRENT"], json.dumps(current)), token: (["AWSPENDING"], None)}
        self.counter = 0

    def describe_secret(self, SecretId):
        return {"RotationEnabled": True, "VersionIdsToStages": {v: s for v, (s, _) in self.versions.items()}}

    def get_secret_value(self, SecretId, VersionStage, VersionId=None):
        for version, (stages, value) in self.versions.items():
            if VersionStage in stages and (VersionId is None or VersionId == version) and value is not None:
                return {"SecretString": value}
        raise NotFound()

    def get_random_password(self, PasswordLength, ExcludePunctuation):
        self.counter += 1
        return {"RandomPassword": f"new{self.counter}".ljust(PasswordLength, "x")}

    def put_secret_value(self, SecretId, ClientRequestToken, SecretString, VersionStages):
        self.versions[ClientRequestToken] = (VersionStages, SecretString)

    def update_secret_version_stage(self, SecretId, VersionStage, MoveToVersionId, RemoveFromVersionId):
        for version, (stages, value) in list(self.versions.items()):
            if version == RemoveFromVersionId:
                stages = [s for s in stages if s != VersionStage]
            if version == MoveToVersionId:
                stages = [s for s in stages if s != "AWSPENDING"] + [VersionStage]
            self.versions[version] = (stages, value)

    def current(self):
        return json.loads(self.get_secret_value(SecretId="s", VersionStage="AWSCURRENT")["SecretString"])


def rotate(fake, token="v2"):
    with mock.patch.object(index, "_client", fake):
        for step in ("createSecret", "setSecret", "testSecret", "finishSecret"):
            index.handler({"SecretId": "arn:secret", "ClientRequestToken": token, "Step": step})


class RotationTests(unittest.TestCase):
    def test_jwt_secret_rotation_keeps_the_old_key_as_previous(self):
        fake = FakeSecrets({"jwtSecret": "old-jwt-secret".ljust(128, "o")})
        rotate(fake)
        current = fake.current()
        self.assertEqual(current["previousJwtSecret"], "old-jwt-secret".ljust(128, "o"))
        self.assertEqual(len(current["jwtSecret"]), 128)
        self.assertNotEqual(current["jwtSecret"], current["previousJwtSecret"])

    def test_each_secret_kind_rotates_its_own_field(self):
        for field, previous, length in (("token", "previousToken", 64), ("signingKey", "previousSigningKey", 64)):
            with self.subTest(field=field):
                fake = FakeSecrets({field: "o" * length})
                rotate(fake)
                current = fake.current()
                self.assertEqual(current[previous], "o" * length)
                self.assertEqual(len(current[field]), length)

    def test_a_second_rotation_drops_the_original_key(self):
        fake = FakeSecrets({"jwtSecret": "k1".ljust(128, "o")})
        rotate(fake, "v2")
        fake.versions["v3"] = (["AWSPENDING"], None)
        rotate(fake, "v3")
        self.assertNotIn("k1".ljust(128, "o"), fake.current().values())

    def test_retried_create_reuses_the_pending_version(self):
        fake = FakeSecrets({"token": "o" * 64})
        with mock.patch.object(index, "_client", fake):
            event = {"SecretId": "arn:secret", "ClientRequestToken": "v2", "Step": "createSecret"}
            index.handler(event)
            first = fake.versions["v2"][1]
            index.handler(event)
        self.assertEqual(fake.versions["v2"][1], first)

    def test_secret_without_a_key_field_is_refused(self):
        fake = FakeSecrets({"username": "u", "password": "p"})
        with mock.patch.object(index, "_client", fake), self.assertRaises(ValueError):
            index.handler({"SecretId": "arn:secret", "ClientRequestToken": "v2", "Step": "createSecret"})


if __name__ == "__main__":
    unittest.main()
