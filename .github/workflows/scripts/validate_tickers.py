#!/usr/bin/env python3
"""Validate + normalize the recover-cohort `tickers` dispatch input.

Reads the raw value from the $INPUT_TICKERS environment variable (passed
through `env:` in the workflow, never inline-expanded into the shell body,
to avoid the GitHub Actions script-injection sink). Prints a normalized,
comma-joined, lowercased, de-duplicated ticker list to stdout, or writes a
specific error to stderr and exits non-zero.

The pure logic lives in normalize_tickers() so it is unit-testable without
the workflow (see test_validate_tickers.py). The ticker shape mirrors the
app's TICKER_PATTERN (src/lib/services/ticker-validation.ts): a leading
letter then up to 7 of [a-z0-9.-], i.e. 1-8 chars total. That rejects shell
metacharacters, whitespace, empty elements and junk in one gate.

Run the tests:
  python3 .github/workflows/scripts/test_validate_tickers.py
"""
from __future__ import annotations

import os
import re
import sys

# Mirror src/lib/services/ticker-validation.ts TICKER_PATTERN, lowercased.
_TICKER_RE = re.compile(r"^[a-z][a-z0-9.\-]{0,7}$")
_MAX_TICKERS = 50
_MAX_RAW_LEN = 500


def normalize_tickers(raw: str) -> list[str]:
    """Return a normalized list of tickers, or raise ValueError.

    Rules:
      - comma-separated; per-element surrounding whitespace is trimmed
      - lowercased
      - each element must match ^[a-z][a-z0-9.-]{0,7}$ (rejects shell
        metacharacters, embedded whitespace, and over-long junk)
      - empty elements (stray/trailing commas, "a,,b") are rejected
      - de-duplicated, original order preserved
      - total raw length and ticker count are bounded
    """
    if raw is None:
        raise ValueError("no tickers provided")
    if len(raw) > _MAX_RAW_LEN:
        raise ValueError(
            f"tickers input too long ({len(raw)} chars > {_MAX_RAW_LEN})"
        )
    out: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        t = part.strip().lower()
        if t == "":
            raise ValueError(
                "empty ticker element — check for stray or trailing commas"
            )
        if not _TICKER_RE.match(t):
            raise ValueError(
                f"invalid ticker {part.strip()!r}: tickers must start with a "
                f"letter and use only letters, digits, dot or hyphen (max 8)"
            )
        if t not in seen:
            seen.add(t)
            out.append(t)
    if not out:
        raise ValueError("no tickers after normalization")
    if len(out) > _MAX_TICKERS:
        raise ValueError(f"too many tickers ({len(out)} > {_MAX_TICKERS})")
    return out


def main() -> int:
    raw = os.environ.get("INPUT_TICKERS", "")
    try:
        tickers = normalize_tickers(raw)
    except ValueError as e:
        print(f"invalid tickers input: {e}", file=sys.stderr)
        return 1
    print(",".join(tickers))
    return 0


if __name__ == "__main__":
    sys.exit(main())
