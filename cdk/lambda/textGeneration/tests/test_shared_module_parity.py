"""
Fails if a shared module drifts between its separately packaged copies.

textGeneration, knowledgeBase and the ECS containers are packaged separately,
so shared code is kept as byte-identical copies. The first path in each group
is canonical; edit it, then copy it over the others. Line endings are
normalized before comparing so a Windows checkout does not cause false failures.
"""

import os
import unittest

_CDK = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

# (canonical, mirror, mirror, ...) relative to cdk/.
PARITY_GROUPS = [
    (
        "containers/common/embeddings.py",
        "lambda/textGeneration/helpers/embeddings.py",
        "lambda/knowledgeBase/helpers/embeddings.py",
    ),
    (
        "lambda/textGeneration/helpers/retrieval_core.py",
        "lambda/knowledgeBase/helpers/retrieval_core.py",
    ),
    (
        "lambda/textGeneration/helpers/eval_scoring.py",
        "lambda/knowledgeBase/helpers/eval_scoring.py",
    ),
    # Synthetic golden set (no personal data); the validate_space task reads the KB copy.
    (
        "lambda/textGeneration/tests/eval/golden_queries.json",
        "lambda/knowledgeBase/helpers/golden_queries.json",
    ),
]

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


if __name__ == "__main__":
    unittest.main()
