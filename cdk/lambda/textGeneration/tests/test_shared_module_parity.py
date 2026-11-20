"""
Fails if shared code drifts or is copied back into a Lambda package.

textGeneration and knowledgeBase import shared code from the kc_shared layer
(cdk/layers/shared_python/python/kc_shared), so the Lambda packages hold no
copies. The ECS containers cannot use a Lambda layer, so the crawler and
transcriber keep a byte-identical copy of embeddings.py. The first path in each
group is canonical; edit it, then copy it over the others. Line endings are
normalized before comparing so a Windows checkout does not cause false failures.
"""

import os
import unittest

_CDK = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_SHARED = "layers/shared_python/python/kc_shared"

# (canonical, mirror, mirror, ...) relative to cdk/.
PARITY_GROUPS = [
    (
        f"{_SHARED}/embeddings.py",
        "containers/common/embeddings.py",
    ),
]

# Modules that live only in the layer; a copy in a Lambda package would shadow
# nothing (imports name kc_shared) but would drift unnoticed.
LAYER_ONLY = ["cors.py", "retrieval_core.py", "eval_scoring.py", "embeddings.py", "golden_queries.json"]
LAMBDA_PACKAGES = ["lambda/textGeneration", "lambda/knowledgeBase"]

# Mirrors that are registered but not created yet. Their parity check is skipped
# (with a reason) while the file is absent; add an entry here only while a mirror
# is still to be created. Empty now that every mirror exists.
PENDING_MIRRORS = {}


def _exists(rel_path):
    return os.path.isfile(os.path.join(_CDK, *rel_path.split("/")))


def _read(rel_path):
    with open(os.path.join(_CDK, *rel_path.split("/")), "rb") as handle:
        return handle.read().replace(b"\r\n", b"\n")


class SharedModuleParityTests(unittest.TestCase):
    def test_copies_are_identical(self):
        for canonical, *mirrors in PARITY_GROUPS:
            expected = _read(canonical)
            for mirror in mirrors:
                with self.subTest(canonical=canonical, mirror=mirror):
                    if mirror in PENDING_MIRRORS and not _exists(mirror):
                        self.skipTest(PENDING_MIRRORS[mirror])
                    self.assertEqual(
                        _read(mirror),
                        expected,
                        f"{mirror} drifted from {canonical}; copy the canonical file over it",
                    )

    def test_all_paths_exist(self):
        for group in PARITY_GROUPS:
            for rel in group:
                with self.subTest(path=rel):
                    if rel in PENDING_MIRRORS and not _exists(rel):
                        self.skipTest(PENDING_MIRRORS[rel])
                    self.assertTrue(_exists(rel), rel)


    def test_lambda_packages_hold_no_copies(self):
        for package in LAMBDA_PACKAGES:
            for root, _dirs, files in os.walk(os.path.join(_CDK, *package.split("/"))):
                if "__pycache__" in root:
                    continue
                for name in files:
                    with self.subTest(package=package, file=name):
                        self.assertNotIn(
                            name,
                            LAYER_ONLY,
                            f"{os.path.join(root, name)} duplicates kc_shared; import it from the layer instead",
                        )


if __name__ == "__main__":
    unittest.main()
