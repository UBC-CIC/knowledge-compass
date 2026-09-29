"""
Checks that the prompt fallbacks in helpers/config.py match what the database
holds after migrations 018 + 022, so the DB (runtime source of truth) and the
code fallbacks do not drift.

It reads the migration source files directly; no database is needed. Run from
the textGeneration dir:

    python -m unittest discover -s tests -v
"""

import os
import re
import sys
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

import helpers.config as config  # noqa: E402

MIGRATIONS = os.path.abspath(os.path.join(HERE, "..", "..", "db_setup", "migrations"))


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


class PromptSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = _migration_022_constants()

    def _apply(self, text, *pairs):
        for old_key, new_key in pairs:
            old, new = self.c[old_key], self.c[new_key]
            self.assertIn(old, text, f"{old_key} passage not found")
            text = text.replace(old, new)
        return text

    def test_detective_prompt_matches_config(self):
        migrated = self._apply(
            _migration_018_content("detective_phase_prompt"),
            ("DETECTIVE_STATUS_OLD", "DETECTIVE_STATUS_NEW"),
            ("DETECTIVE_EARLY_CLARITY_OLD", "DETECTIVE_EARLY_CLARITY_NEW"),
            ("DETECTIVE_RULES_OLD", "DETECTIVE_RULES_NEW"),
        )
        self.assertEqual(migrated, config.DETECTIVE_PHASE_PROMPT)
        self.assertNotIn("{may_suggest}", migrated)
        self.assertNotIn("EARLY CLARITY", migrated)

    def test_suggestion_prompt_matches_config(self):
        migrated = self._apply(
            _migration_018_content("suggestion_phase_prompt"),
            ("SUGGESTION_INTRO_OLD", "SUGGESTION_INTRO_NEW"),
        )
        self.assertEqual(migrated, config.SUGGESTION_PHASE_PROMPT)
        self.assertLessEqual(len(migrated), 25000)  # character_limit set by migration 022

    def test_partial_output_format_matches_config(self):
        self.assertEqual(self.c["OUTPUT_FORMAT_PARTIAL"], config.OUTPUT_FORMAT_PARTIAL)
        self.assertLessEqual(len(config.OUTPUT_FORMAT_PARTIAL), 3500)

    def test_edits_are_reversible(self):
        original = _migration_018_content("detective_phase_prompt")
        migrated = self._apply(
            original,
            ("DETECTIVE_STATUS_OLD", "DETECTIVE_STATUS_NEW"),
            ("DETECTIVE_EARLY_CLARITY_OLD", "DETECTIVE_EARLY_CLARITY_NEW"),
            ("DETECTIVE_RULES_OLD", "DETECTIVE_RULES_NEW"),
        )
        reverted = self._apply(
            migrated,
            ("DETECTIVE_RULES_NEW", "DETECTIVE_RULES_OLD"),
            ("DETECTIVE_EARLY_CLARITY_NEW", "DETECTIVE_EARLY_CLARITY_OLD"),
            ("DETECTIVE_STATUS_NEW", "DETECTIVE_STATUS_OLD"),
        )
        self.assertEqual(reverted, original)


if __name__ == "__main__":
    unittest.main()
