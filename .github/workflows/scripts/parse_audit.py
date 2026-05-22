#!/usr/bin/env python3
"""Parse audit-peer-panels.mjs stdout and print polluted tickers (CSV).

Used by .github/workflows/recover-cohort.yml. Reads the audit log from
/tmp/audit-initial.log (path is hardcoded — this script is single-purpose
and only invoked from that workflow).

Audit rows look like:

    aapl   | FULLY-POLLUTED       |    20 |       3 | YES  [TBTC,RGCCF]
    msft   | CLEAN                |    18 |       0 | no

We pick the rows where column 4 (reingest) starts with YES and emit
their tickers, lowercased and comma-joined.
"""
import re
import sys

TICKER_RE = re.compile(r"[a-z0-9.\-]{1,8}")
LOG_PATH = "/tmp/audit-initial.log"


def main() -> int:
    tickers: list[str] = []
    try:
        with open(LOG_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        print("", end="")
        return 0

    for line in lines:
        if line.startswith("Ticker") or line.startswith("---") or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        # Expected shape: ticker | verdict | total | suspect | reingest...
        if len(parts) < 5:
            continue
        reingest_cell = parts[4].split()[0] if parts[4] else ""
        if reingest_cell.upper() != "YES":
            continue
        ticker = parts[0].strip().lower()
        if TICKER_RE.fullmatch(ticker):
            tickers.append(ticker)

    sys.stdout.write(",".join(tickers))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
