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
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

import helpers.config as config  # noqa: E402
from helpers.journeys import DEFAULT_CATALOG, clean_steps  # noqa: E402

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


def _load_seed(name):
    """`exports.seed` of a migration, loaded with node (None without node)."""
    node = shutil.which("node")
    if not node:
        return None
    script = "process.stdout.write(JSON.stringify(require(process.argv[1]).seed))"
    out = subprocess.run([node, "-e", script, os.path.join(MIGRATIONS, name)], capture_output=True, check=True)
    return json.loads(out.stdout.decode("utf-8"))


def _load_024_seed():
    return _load_seed(os.path.basename(MIGRATION_024))


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

    @unittest.skipIf(shutil.which("node") is None, "node is required to load migration 024")
    def test_default_catalog_carries_the_pre_024_cluster_text(self):
        live = self.live_suggestion()
        seeded = {c["key"]: c["responsePattern"] for c in _load_024_seed()["clusters"]}
        for journey in DEFAULT_CATALOG.journeys:
            for c in journey.clusters:
                self.assertIn(f"SITUATION {c.key} — {c.name.upper()}\n", live)
                # The 024 seed carried the pre-024 text (028 later re-wrapped it).
                self.assertIn(_indented(seeded[c.key]), live, f"cluster {c.key} pattern")
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
        # Every strict rule admins now edit was already live before 024
        # (027 only moved the <focus> rule into code).
        rules = config.DETECTIVE_PHASE_PROMPT.split("STRICT RULES:", 1)[1]
        live_rules = self.live_detective().split("STRICT RULES:", 1)[1]
        for rule in rules.strip().split("\n- "):
            self.assertIn(rule.strip().lstrip("- "), live_rules)


@unittest.skipIf(shutil.which("node") is None, "node is required to load migration 024")
class Migration024SyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed = _load_024_seed()

    def test_base_prompts_chain_to_config(self):
        # 024 base -> 026 edit -> 027 plain text == config.py fallbacks.
        old, new = _load_seed("026_drop_cluster_priority.js")["suggestionEdit"]
        self.assertIn(old, self.seed["suggestionBase"])
        plain = _load_seed("027_plain_conversation_prompts.js")
        self.assertEqual(plain["detectiveOld"], self.seed["detectiveBase"])
        self.assertEqual(plain["suggestionOld"], self.seed["suggestionBase"].replace(old, new))
        latest = _load_seed("043_journey_document_prompts.js")
        self.assertEqual(latest["detectiveOld"], plain["detective"])
        self.assertEqual(latest["suggestionOld"], plain["suggestion"])
        self.assertEqual(latest["detective"], config.DETECTIVE_PHASE_PROMPT)
        self.assertEqual(latest["suggestion"], config.SUGGESTION_PHASE_PROMPT)
        self.assertNotIn("<", latest["detective"])
        self.assertNotIn("{", latest["suggestion"])
        self.assertNotIn("SITUATION A", config.SUGGESTION_PHASE_PROMPT)
        self.assertNotIn("Journey 1 signals", config.DETECTIVE_PHASE_PROMPT)

    def test_plain_prompts_have_no_machinery(self):
        plain = _load_seed("027_plain_conversation_prompts.js")
        for key in ("detective", "suggestion"):
            self.assertNotIn("{", plain[key], key)
            self.assertNotIn("<", plain[key], key)
            self.assertLessEqual(len(plain[key]), plain["characterLimits"][f"{key}_phase_prompt"])
        # The suggestion text keeps everything after its opening paragraph.
        self.assertTrue(plain["suggestionOld"].endswith(plain["suggestion"]))
        self.assertIn("CROSS-CUTTING RESPONSE PRINCIPLES", plain["suggestion"])

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
                    (s["journey"], s["name"], s["sortOrder"], s["matchesWhen"]),
                    (j.key, c.name, c.sort_order, c.matches_when),
                    c.key,
                )

    def test_default_steps_are_the_028_cleanup_of_the_seed(self):
        cleaned = _load_seed("028_plain_situation_steps.js")["steps"]
        seeded = {c["key"]: c["responsePattern"] for c in self.seed["clusters"]}
        for j in DEFAULT_CATALOG.journeys:
            for c in j.clusters:
                self.assertEqual(c.response_pattern, cleaned[c.key], c.key)
                # Python port and JS cleanSteps agree, and are idempotent.
                self.assertEqual(clean_steps(seeded[c.key]), cleaned[c.key], c.key)
                self.assertEqual(clean_steps(cleaned[c.key]), cleaned[c.key], c.key)

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


@unittest.skipIf(shutil.which("node") is None, "node is required to load migration 025")
class Migration025SyncTests(unittest.TestCase):
    def test_role_matches_config(self):
        seed = _load_seed("025_journey_neutral_role.js")
        self.assertEqual(seed["role"], config.ROLE)
        self.assertLessEqual(len(seed["role"]), seed["characterLimit"])
        self.assertNotIn("JOURNEY 1", seed["role"])


class Migration018GuardrailsSyncTests(unittest.TestCase):
    def test_guardrails_fallback_matches_018(self):
        # SCOPE_RULE is code-owned and added by guardrails_block_text();
        # GUARDRAILS itself must stay the 018 seed.
        self.assertEqual(config.GUARDRAILS.strip(), _migration_018_content("guardrails").strip())
        self.assertNotIn("SCOPE:", config.GUARDRAILS)


if __name__ == "__main__":
    unittest.main()
