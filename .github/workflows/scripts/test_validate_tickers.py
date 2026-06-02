#!/usr/bin/env python3
"""Unit tests for validate_tickers.py (the recover-cohort tickers gate).

Run:
  python3 .github/workflows/scripts/test_validate_tickers.py
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import sys
import unittest


def _load_validator():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "validate_tickers", os.path.join(here, "validate_tickers.py")
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vt = _load_validator()


class NormalizeTickersTests(unittest.TestCase):
    def test_simple_csv(self):
        self.assertEqual(vt.normalize_tickers("crm,nflx,qcom"), ["crm", "nflx", "qcom"])

    def test_lowercases_and_trims(self):
        self.assertEqual(vt.normalize_tickers(" META , NfLx "), ["meta", "nflx"])

    def test_single_ticker(self):
        self.assertEqual(vt.normalize_tickers("meta"), ["meta"])

    def test_dedupes_preserving_order(self):
        self.assertEqual(vt.normalize_tickers("meta,meta,nflx,meta"), ["meta", "nflx"])

    def test_allows_dot_and_hyphen_dual_class(self):
        self.assertEqual(vt.normalize_tickers("brk.b,brk-b"), ["brk.b", "brk-b"])

    def test_allows_alphanumeric(self):
        self.assertEqual(vt.normalize_tickers("goog1"), ["goog1"])

    def test_rejects_empty_elements(self):
        for raw in ["meta,", ",meta", "meta,,nflx", " , ", ","]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    vt.normalize_tickers(raw)

    def test_rejects_shell_metacharacters(self):
        for raw in [
            "meta;rm -rf /",
            "meta`whoami`",
            "meta$(id)",
            "meta|nc evil 1",
            "meta&",
            "meta>out",
            "meta nflx",  # space-separated, not comma
            "$(curl evil)",
            "meta\nnflx",
        ]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    vt.normalize_tickers(raw)

    def test_rejects_leading_non_letter(self):
        for raw in ["1meta", ".meta", "-meta", "0"]:
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    vt.normalize_tickers(raw)

    def test_rejects_too_long_ticker(self):
        # App TICKER_PATTERN caps at 8 chars; 9+ is junk.
        with self.assertRaises(ValueError):
            vt.normalize_tickers("abcdefghi")

    def test_accepts_max_length_ticker(self):
        self.assertEqual(vt.normalize_tickers("abcdefgh"), ["abcdefgh"])  # 8 chars

    def test_rejects_huge_raw_input(self):
        with self.assertRaises(ValueError):
            vt.normalize_tickers("a," * 1000)

    def test_rejects_too_many_tickers(self):
        many = ",".join("a%d" % i for i in range(60))  # 60 unique valid tickers
        with self.assertRaises(ValueError):
            vt.normalize_tickers(many)


class MainTests(unittest.TestCase):
    def _run_main(self, raw):
        os.environ["INPUT_TICKERS"] = raw
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = vt.main()
        return rc, out.getvalue().strip()

    def test_main_emits_normalized(self):
        rc, out = self._run_main("META, nflx , META")
        self.assertEqual(rc, 0)
        self.assertEqual(out, "meta,nflx")

    def test_main_rejects_injection(self):
        rc, out = self._run_main("meta;rm -rf /")
        self.assertEqual(rc, 1)
        self.assertEqual(out, "")  # nothing written to stdout on failure


if __name__ == "__main__":
    unittest.main()
