import unittest

from evals import catalog


class CatalogTest(unittest.TestCase):
    def test_repo_catalog_matches_seeded_keys(self):
        cat = catalog.catalog_from_repo()
        keys = {j["key"]: [c["key"] for c in j["clusters"]] for j in cat}
        self.assertEqual(sorted(keys), ["J1", "J2"])
        self.assertIn("A", keys["J1"])
        self.assertIn("K", keys["J2"])

    def test_admin_tree_drops_archived(self):
        tree = {"journeys": [
            {"key": "J1", "name": "One", "clusters": [{"key": "A", "name": "a"}, {"key": "Z", "name": "z", "is_archived": True}]},
            {"key": "J9", "name": "Old", "is_archived": True, "clusters": []},
        ]}
        cat = catalog.catalog_from_admin_tree(tree)
        self.assertEqual([j["key"] for j in cat], ["J1"])
        self.assertEqual([c["key"] for c in cat[0]["clusters"]], ["A"])

    def test_journey_for_number(self):
        cat = [{"key": "J1", "name": "Involuntary partial day attendance", "clusters": []},
               {"key": "TR", "name": "Transitions and future planning", "clusters": []}]
        self.assertEqual(catalog.journey_for_number(cat, 1)["key"], "J1")
        self.assertEqual(catalog.journey_for_number(cat, 2, "Transitions to Public School")["key"], "TR")
        self.assertEqual(catalog.journey_for_number(cat, 3, "Unrelated words"), {})


if __name__ == "__main__":
    unittest.main()
