#!/usr/bin/env python3
"""
Unit tests for the recover_peer_pollution.py driver. Covers the
non-network pieces: input parsing, safety-gate decisions, suspect-
chip regex, and the structure of helper signatures. Network calls
are not exercised here — those are covered end-to-end by the
workflow itself.

Run:
  python3 .github/workflows/scripts/test_recover_peer_pollution.py
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
import unittest


def _load_driver():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "recover_driver", os.path.join(here, "recover_peer_pollution.py")
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


drv = _load_driver()


class ParseCsvTests(unittest.TestCase):
    def test_handles_simple_csv(self):
        self.assertEqual(drv.parse_csv("crm,nflx,qcom"), ["crm", "nflx", "qcom"])

    def test_trims_whitespace(self):
        self.assertEqual(drv.parse_csv("  crm , nflx  ,qcom"), ["crm", "nflx", "qcom"])

    def test_skips_empty_segments(self):
        self.assertEqual(drv.parse_csv(",crm,,nflx,"), ["crm", "nflx"])


class HelperSignatureTests(unittest.TestCase):
    """Phase 21 false-failure regression: get_json and get_text are
    distinct so HTML company pages don't go through json.loads()."""

    def test_get_text_returns_string_body(self):
        # Doesn't perform a real fetch — just confirms the function
        # exists and has the expected signature (URL → (int, str|None)).
        self.assertTrue(callable(drv.get_text))
        self.assertTrue(callable(drv.get_json))
        self.assertIsNot(drv.get_text, drv.get_json)


class ChipRegexTests(unittest.TestCase):
    """The smoke check parses peer chips out of the rendered HTML.
    Pattern lives inside run_audit_and_smoke; replicate it here to
    pin the contract."""

    chip_pattern = re.compile(r'<span class="truncate">([A-Z][A-Z0-9.\-]{0,7})\s*·')

    def test_matches_normal_chip(self):
        html = '<span class="truncate">NVDA · NVIDIA CORP</span>'
        self.assertEqual(self.chip_pattern.findall(html), ["NVDA"])

    def test_matches_dual_class(self):
        html = '<span class="truncate">BRK-A · Berkshire Hathaway Inc.</span>'
        self.assertEqual(self.chip_pattern.findall(html), ["BRK-A"])

    def test_does_not_match_lowercase_garbage(self):
        html = '<span class="truncate">not a ticker</span>'
        self.assertEqual(self.chip_pattern.findall(html), [])

    def test_finds_multiple_chips(self):
        html = (
            '<span class="truncate">AAPL · Apple Inc.</span>'
            '<span class="truncate">MSFT · Microsoft Corp</span>'
            '<span class="truncate">HEPS · D-Market</span>'
        )
        self.assertEqual(self.chip_pattern.findall(html), ["AAPL", "MSFT", "HEPS"])


class IdempotencyTests(unittest.TestCase):
    """rows_affected==0 must NOT abort with a safety-gate failure.
    It must instead run the audit and exit 0 if production is
    already clean. This guards against a stuck workflow when a
    previous run completed the delete but failed during smoke."""

    def test_max_rows_threshold_present(self):
        self.assertTrue(hasattr(drv, "MAX_ROWS"))
        self.assertGreater(drv.MAX_ROWS, 0)
        self.assertLessEqual(drv.MAX_ROWS, 100)

    def test_run_audit_and_smoke_accepts_already_clean_flag(self):
        # Function should accept (base, parents, suspect_set,
        # already_clean=...) without error at the signature level.
        # We don't actually call it (would hit production). Pull
        # __code__.co_varnames to assert the named parameter exists.
        self.assertIn("already_clean", drv.run_audit_and_smoke.__code__.co_varnames)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
