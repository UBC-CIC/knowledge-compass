"""
Tests for the code-level ceilings on admin-configurable usage limits
(helpers/config.py LIMIT_CEILINGS). load_config must cap a system_settings
value above its ceiling, keep valid values, and ignore invalid ones. The DB
reads are mocked. Run from textGeneration:

    python -m unittest discover -s tests -p test_limit_ceilings.py -v
"""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))
import _setup  # noqa: E402,F401  (puts kc_shared on sys.path)

from helpers import config  # noqa: E402

# Setting key -> module global it loads into.
GLOBALS = {
    'max_messages_per_day': 'MAX_MESSAGES_PER_DAY',
    'max_characters_per_user_message': 'MAX_CHARACTERS_PER_USER_MESSAGE',
    'max_characters_per_day': 'MAX_CHARACTERS_PER_DAY',
    'max_messages_per_day_global': 'MAX_MESSAGES_PER_DAY_GLOBAL',
    'max_characters_per_ai_message': 'MAX_CHARACTERS_PER_AI_MESSAGE',
}


class LimitCeilingTest(unittest.TestCase):
    def setUp(self):
        saved = {name: getattr(config, name) for name in
                 list(GLOBALS.values()) + ['HAIKU_ARN', 'GUARDRAIL_ID', 'GUARDRAIL_VERSION',
                                           '_CONFIG_LOADED_AT', 'JOURNEY_CATALOG',
                                           'PROMPT_MODE', 'GUIDELINE_OUTLINE']}
        self.addCleanup(lambda: [setattr(config, k, v) for k, v in saved.items()])
        config.HAIKU_ARN = 'arn:test'
        config.GUARDRAIL_ID = 'g'
        config.GUARDRAIL_VERSION = '1'
        for patch in (
            mock.patch.object(config, 'fetch_journey_catalog', return_value=[]),
            mock.patch.object(config, 'fetch_guideline_config', return_value={}),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def load(self, settings):
        config._CONFIG_LOADED_AT = None
        with mock.patch.object(config, 'fetch_system_config',
                               return_value={'settings': settings, 'messages': {}}):
            config.load_config(object())

    def test_ceilings_match_the_requested_values(self):
        self.assertEqual(config.LIMIT_CEILINGS, {
            'max_messages_per_day': 100,
            'max_characters_per_user_message': 4000,
            'max_characters_per_day': 20000,
            'max_messages_per_day_global': 20000,
            'max_characters_per_ai_message': 10000,
        })

    def test_values_above_the_ceiling_are_capped(self):
        self.load({key: 10_000_000 for key in GLOBALS})
        for key, name in GLOBALS.items():
            self.assertEqual(getattr(config, name), config.LIMIT_CEILINGS[key], key)

    def test_values_at_or_below_the_ceiling_are_kept(self):
        self.load({key: config.LIMIT_CEILINGS[key] for key in GLOBALS})
        for key, name in GLOBALS.items():
            self.assertEqual(getattr(config, name), config.LIMIT_CEILINGS[key], key)
        self.load({key: 7 for key in GLOBALS})
        for key, name in GLOBALS.items():
            self.assertEqual(getattr(config, name), 7, key)

    def test_invalid_values_keep_the_current_value(self):
        for name in GLOBALS.values():
            setattr(config, name, 42)
        for bad in (None, 0, -1, '500', 2.5, True):
            self.load({key: bad for key in GLOBALS})
            for key, name in GLOBALS.items():
                self.assertEqual(getattr(config, name), 42, f'{key}={bad!r}')

    def test_defaults_are_within_the_ceilings(self):
        defaults = {'max_messages_per_day': 45, 'max_characters_per_user_message': 2000,
                    'max_characters_per_day': 10000, 'max_messages_per_day_global': 5000,
                    'max_characters_per_ai_message': 5000}
        for key, value in defaults.items():
            self.assertLessEqual(value, config.LIMIT_CEILINGS[key], key)


if __name__ == '__main__':
    unittest.main()
