"""The pinned requirements.txt and the vendored *.dist-info folders agree."""
import re
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)")


def _normalize(name):
    return re.sub(r"[-_.]+", "_", name).lower()


def _pins():
    pins = set()
    for line in (PACKAGE_DIR / "requirements.txt").read_text(encoding="utf-8").splitlines():
        match = PIN.match(line)
        if match:
            pins.add((_normalize(match.group(1)), match.group(2)))
    return pins


def _vendored():
    vendored = set()
    for path in PACKAGE_DIR.glob("*.dist-info"):
        name, version = path.name[: -len(".dist-info")].rsplit("-", 1)
        vendored.add((_normalize(name), version))
    return vendored


class VendoredRequirementsTests(unittest.TestCase):
    def test_requirements_are_hashed(self):
        text = (PACKAGE_DIR / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("--hash=sha256:", text)

    def test_every_pin_is_vendored(self):
        pins = _pins()
        self.assertTrue(pins)
        self.assertEqual(set(), pins - _vendored())

    def test_every_vendored_package_is_pinned(self):
        self.assertEqual(set(), _vendored() - _pins())


if __name__ == "__main__":
    unittest.main()
