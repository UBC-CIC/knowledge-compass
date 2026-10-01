"""
Checks that the prompt fallbacks in helpers/config.py and helpers/journeys.py
match what the database holds after migrations 018 + 022 + 024, so the DB
(runtime source of truth) and the code fallbacks do not drift.

Migrations 018/022 are read as source text; migration 024's seed is loaded
with node (skipped if node is not installed). No database is needed. Run from
the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

import helpers.config as config  # noqa: E402
from helpers.journeys import DEFAULT_CATALOG  # noqa: E402

MIGRATIONS = os.path.abspath(os.path.join(HERE, "..", "..", "db_setup", "migrations"))
MIGRATION_024 = os.path.join(MIGRATIONS, "024_journey_cluster_prompts.js")


def _read(name):
    with open(os.path.join(MIGRATIONS, name), encoding="utf-8") as f:
        return f.read().replace("\r\n", "\n")


def _migration_018_content(message_type):
    up = _read("018_journey_aware_prompts.js").split("exports.down", 1)[0]
    # Tempered group: the content may not span a $msg$ delimiter.
    pattern = (
        r"SET content = \$msg\$((?:(?!\$msg\$).)*)\$msg\$,\s*character_limit = \d+,\s*"
        rf"created_at = now\(\)\s*WHERE type = '{message_type}'"
    )
    match = re.search(pattern, up, re.DOTALL)
    if not match:
        raise AssertionError(f"could not find {message_type} in migration 018")
    return match.group(1)


def _migration_022_constants():
    source = _read("022_dynamic_routing.js")
    return dict(re.findall(r"const (\w+) = `(.*?)`;", source, re.DOTALL))


def _load_024_seed():
    node = shutil.which("node")
    if not node:
        return None
    script = "process.stdout.write(JSON.stringify(require(process.argv[1]).seed))"
    out = subprocess.run([node, "-e", script, MIGRATION_024], capture_output=True, check=True)
    return json.loads(out.stdout.decode("utf-8"))


def _indented(text, prefix="  "):
    return textwrap.indent(text, prefix)


class Pre024PromptTests(unittest.TestCase):
    """Migration 022's edits still apply cleanly to the 018 content."""

    @classmethod
    def setUpClass(cls):
        cls.c = _migration_022_constants()

    def _apply(self, text, *pairs):
        for old_key, new_key in pairs:
            old, new = self.c[old_key], self.c[new_key]
            self.assertIn(old, text, f"{old_key} passage not found")
            text = text.replace(old, new)
        return text

    def live_detective(self):
        return self._apply(
            _migration_018_content("detective_phase_prompt"),
            ("DETECTIVE_STATUS_OLD", "DETECTIVE_STATUS_NEW"),
            ("DETECTIVE_EARLY_CLARITY_OLD", "DETECTIVE_EARLY_CLARITY_NEW"),
            ("DETECTIVE_RULES_OLD", "DETECTIVE_RULES_NEW"),
        )

    def live_suggestion(self):
        return self._apply(
            _migration_018_content("suggestion_phase_prompt"),
            ("SUGGESTION_INTRO_OLD", "SUGGESTION_INTRO_NEW"),
        )

    def test_edits_are_reversible(self):
        original = _migration_018_content("detective_phase_prompt")
        reverted = self._apply(
            self.live_detective(),
            ("DETECTIVE_RULES_NEW", "DETECTIVE_RULES_OLD"),
            ("DETECTIVE_EARLY_CLARITY_NEW", "DETECTIVE_EARLY_CLARITY_OLD"),
            ("DETECTIVE_STATUS_NEW", "DETECTIVE_STATUS_OLD"),
        )
        self.assertEqual(reverted, original)

    def test_default_catalog_carries_the_pre_024_cluster_text(self):
        live = self.live_suggestion()
        for journey in DEFAULT_CATALOG.journeys:
            for c in journey.clusters:
                self.assertIn(f"SITUATION {c.key} — {c.name.upper()}\n", live)
                self.assertIn(_indented(c.response_pattern), live, f"cluster {c.key} pattern")
                first_line = c.matches_when.splitlines()[0]
                self.assertIn(f"Matches when: {first_line}", live, f"cluster {c.key} matches_when")

    def test_default_catalog_carries_the_pre_024_detective_text(self):
        live = self.live_detective()
        for journey in DEFAULT_CATALOG.journeys:
            self.assertIn(_indented(journey.detection_signals), live, journey.key)
            self.assertIn(_indented(journey.detective_questions), live, journey.key)

    def test_base_prompts_keep_the_shared_pre_024_text(self):
        live_suggestion = self.live_suggestion()
        principles = config.SUGGESTION_PHASE_PROMPT.split("=" * 67, 1)[1]
        self.assertIn(principles, live_suggestion)
        rules = config.DETECTIVE_PHASE_PROMPT.split("STRICT RULES:", 1)[1]
        self.assertTrue(self.live_detective().endswith(rules))


@unittest.skipIf(shutil.which("node") is None, "node is required to load migration 024")
class Migration024SyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed = _load_024_seed()

    def test_base_prompts_match_config(self):
        self.assertEqual(self.seed["detectiveBase"], config.DETECTIVE_PHASE_PROMPT)
        self.assertEqual(self.seed["suggestionBase"], config.SUGGESTION_PHASE_PROMPT)
        self.assertNotIn("SITUATION A", config.SUGGESTION_PHASE_PROMPT)
        self.assertNotIn("Journey 1 signals", config.DETECTIVE_PHASE_PROMPT)

    def test_seed_matches_default_catalog(self):
        journeys = {j["key"]: j for j in self.seed["journeys"]}
        clusters = {c["key"]: c for c in self.seed["clusters"]}
        self.assertEqual(list(journeys), [j.key for j in DEFAULT_CATALOG.journeys])
        self.assertEqual(sorted(clusters), sorted(DEFAULT_CATALOG.cluster_keys))
        for j in DEFAULT_CATALOG.journeys:
            s = journeys[j.key]
            self.assertEqual(
                (s["name"], s["sortOrder"], s["description"], s["detectionSignals"],
                 s["detectiveQuestions"], s["guidance"]),
                (j.name, j.sort_order, j.description, j.detection_signals,
                 j.detective_questions, j.guidance),
                j.key,
            )
            for c in j.clusters:
                s = clusters[c.key]
                self.assertEqual(
                    (s["journey"], s["name"], s["priority"], s["sortOrder"],
                     s["matchesWhen"], s["responsePattern"]),
                    (j.key, c.name, c.priority, c.sort_order, c.matches_when, c.response_pattern),
                    c.key,
                )

    def test_seed_fits_character_limits(self):
        limits = self.seed["characterLimits"]
        for j in self.seed["journeys"]:
            self.assertLessEqual(len(j["detectiveQuestions"]), limits["detective_questions"])
            self.assertLessEqual(len(j["guidance"]), limits["guidance"])
        for c in self.seed["clusters"]:
            self.assertLessEqual(len(c["responsePattern"]), limits["response_pattern"])
        self.assertLessEqual(len(config.DETECTIVE_PHASE_PROMPT), 4000)

    def test_output_format_edits_match_config(self):
        formats = {
            "output_format_detective": config.OUTPUT_FORMAT_DETECTIVE,
            "output_format_suggestion": config.OUTPUT_FORMAT_SUGGESTION,
            "output_format_partial": config.OUTPUT_FORMAT_PARTIAL,
        }
        for _, message_type, old, new in self.seed["outputFormatEdits"]:
            self.assertIn(new, formats[message_type], message_type)
            self.assertNotIn(old, formats[message_type], message_type)
        # The partial format is otherwise exactly migration 022's seed.
        partial_022 = _migration_022_constants()["OUTPUT_FORMAT_PARTIAL"]
        edit = next(e for e in self.seed["outputFormatEdits"] if e[1] == "output_format_partial")
        self.assertEqual(partial_022.replace(edit[2], edit[3]), config.OUTPUT_FORMAT_PARTIAL)


if __name__ == "__main__":
    unittest.main()
