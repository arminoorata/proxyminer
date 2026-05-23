#!/usr/bin/env python3
"""
DB-only peer-pollution recovery driver.

Used by .github/workflows/recover-peer-pollution.yml. POSTs to
/api/admin/recover/peer-pollution in three phases:

  1. Dry-run: validates that the affected rows match the expected
     parent/suspect set and that the scope is bounded.
  2. Confirmed delete: only after the dry-run passes every safety
     check.
  3. Verification: runs the cohort audit + a few smoke checks on
     production to confirm the cleanup landed.

Exits non-zero if any phase fails. All token I/O is via env var
ADMIN_TOKEN; the token is never echoed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

ROUTE = "/api/admin/recover/peer-pollution"
MAX_ROWS = 25


def post_json(url: str, body: dict[str, Any], token: str, timeout: int = 60) -> tuple[int, dict[str, Any] | None]:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "proxyminer-recover-peer-pollution/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body_text = e.read().decode("utf-8")
            return e.code, json.loads(body_text)
        except Exception:
            return e.code, None


def get_json(url: str, timeout: int = 30) -> tuple[int, dict[str, Any] | None]:
    """GET a JSON endpoint. Returns (status, parsed-body-or-None)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  GET {url} failed: {e}", file=sys.stderr)
        return 0, None


def get_text(url: str, timeout: int = 30) -> tuple[int, str | None]:
    """GET an HTML/text endpoint. Returns (status, raw-body-or-None).

    Use this for company pages and any other endpoint that returns
    text/html instead of JSON. The previous implementation tried to
    json.loads() the company HTML and falsely reported a smoke
    failure even when the page rendered fine.
    """
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"User-Agent": "proxyminer-recover-peer-pollution/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception:
            return e.code, None
    except Exception as exc:
        print(f"  GET {url} failed: {exc}", file=sys.stderr)
        return 0, None


def parse_csv(s: str) -> list[str]:
    return [x.strip() for x in s.split(",") if x.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--parents", required=True)
    parser.add_argument("--suspects", required=True)
    args = parser.parse_args()

    token = os.environ.get("ADMIN_TOKEN", "")
    if not token:
        print("ADMIN_TOKEN env var not set (workflow should set this from secrets).", file=sys.stderr)
        return 2

    base = args.base_url.rstrip("/")
    parents = [p.lower() for p in parse_csv(args.parents)]
    suspects = [s.upper() for s in parse_csv(args.suspects)]

    if not parents or not suspects:
        print("ERROR: parents and suspects must each contain at least one entry", file=sys.stderr)
        return 2

    parent_set = set(parents)
    suspect_set = set(suspects)

    print(f"Recover plan: parents={parents}  suspects={suspects}")
    print(f"Target: {base}{ROUTE}")

    # ── Phase 1: dry-run ────────────────────────────────────────────
    print("\n── dry-run ──")
    code, body = post_json(
        f"{base}{ROUTE}",
        {"parents": parents, "suspects": suspects, "confirm": False},
        token,
    )
    if code != 200 or not isinstance(body, dict) or body.get("error"):
        print(f"ERROR: dry-run HTTP {code} body={body}", file=sys.stderr)
        return 3
    if not body.get("dry_run"):
        print(f"ERROR: expected dry_run=true, got {body.get('dry_run')}", file=sys.stderr)
        return 3

    scope = body.get("scope", {})
    rows = body.get("rows", [])
    rows_affected = scope.get("rows_affected", 0)
    parents_resolved = set(scope.get("parents_resolved", []))
    suspects_in_scope = set(scope.get("suspects", []))

    print(f"  rows_affected: {rows_affected}")
    print(f"  parents_resolved: {sorted(parents_resolved)}")
    print(f"  suspects_in_scope: {sorted(suspects_in_scope)}")
    for s in scope.get("summary", []):
        print(
            f"    {s['parent']:6s}  members={s['member_count']:>2}  "
            f"filings={s['distinct_filings']:>2}  suspects={s['distinct_suspects']}"
        )

    # ── Idempotent short-circuit ────────────────────────────────────
    # If the dry-run reports zero matching rows, the DB is already
    # clean for this (parents, suspects) pair. A previous workflow
    # run may have completed the delete and failed later during
    # smoke checks (e.g. the original HTML/JSON bug). Rerunning
    # should observe the clean state and pass, not get stuck forever
    # on "rows_affected is 0".
    if rows_affected == 0:
        print("\nDry-run reports rows_affected=0 — nothing to delete.")
        return run_audit_and_smoke(base, parents, suspect_set, already_clean=True)

    # ── Safety gates ─────────────────────────────────────────────────
    failures: list[str] = []
    if not parents_resolved <= parent_set:
        failures.append(
            f"parents_resolved {parents_resolved - parent_set} outside requested parents"
        )
    if not suspects_in_scope <= suspect_set:
        failures.append(
            f"suspects_in_scope {suspects_in_scope - suspect_set} outside requested suspects"
        )
    for r in rows:
        if r.get("company_id") not in parent_set:
            failures.append(f"row company_id={r.get('company_id')} not in {sorted(parent_set)}")
            break
        if r.get("ticker_resolved") not in suspect_set:
            failures.append(
                f"row ticker_resolved={r.get('ticker_resolved')} not in {sorted(suspect_set)}"
            )
            break
    if rows_affected > MAX_ROWS:
        failures.append(f"rows_affected={rows_affected} exceeds safety cap {MAX_ROWS}")

    if failures:
        print("\nSAFETY GATE FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(
            "\nAborting. Inspect the dry-run output, narrow inputs, or expand "
            "the workflow safety thresholds in recover_peer_pollution.py.",
            file=sys.stderr,
        )
        return 4

    # ── Phase 2: confirmed delete ───────────────────────────────────
    print("\n── confirmed delete ──")
    code, body = post_json(
        f"{base}{ROUTE}",
        {"parents": parents, "suspects": suspects, "confirm": True},
        token,
    )
    if code != 200 or not isinstance(body, dict) or body.get("error"):
        print(f"ERROR: delete HTTP {code} body={body}", file=sys.stderr)
        return 5

    deleted = body.get("deleted", 0)
    print(f"  deleted: {deleted} rows")
    for s in body.get("scope", {}).get("summary", []):
        print(f"    {s['parent']:6s} -{s['member_count']}")

    if deleted != rows_affected:
        print(
            f"  WARN: confirmed delete reported {deleted} rows but dry-run said "
            f"{rows_affected}. Continuing to audit.",
            file=sys.stderr,
        )

    # ── Phase 3: verification ───────────────────────────────────────
    return run_audit_and_smoke(base, parents, suspect_set, already_clean=False)


def run_audit_and_smoke(
    base: str,
    parents: list[str],
    suspect_set: set[str],
    *,
    already_clean: bool,
) -> int:
    """Run the cohort audit + per-company HTML smoke + nvidia search.

    Called both by the main flow (after a confirmed delete) and by
    the idempotent short-circuit when the dry-run reports nothing
    to delete. `already_clean=True` annotates the log line so the
    operator can tell which path executed.
    """
    # Brief settle so caches expire (the cohort audit hits live
    # company pages, which have a short cache-control header).
    time.sleep(3)

    label = "no-op verification" if already_clean else "post-cleanup audit"
    print(f"\n── {label} ──")
    audit = subprocess.run(
        ["node", "scripts/audit-peer-panels.mjs"],
        capture_output=True,
        text=True,
        env={**os.environ, "PROXYMINER_BASE_URL": base},
    )
    print(audit.stdout)
    if audit.stderr:
        print(audit.stderr, file=sys.stderr)
    if audit.returncode != 0:
        # audit script exits non-zero on any pollution
        print(
            "ERROR: production audit still reports pollution. Inspect output above.",
            file=sys.stderr,
        )
        return 6

    # ── Smoke: company HTML pages + nvidia search JSON ──────────────
    print("\n── smoke ──")
    ok = True

    # Suspect-chip regex: TICKER · NAME inside <span class="truncate">.
    # Used to assert the deleted suspect tickers really are gone from
    # every parent's rendered peer panel. Empty suspect_set just
    # skips that assertion.
    chip_pattern = re.compile(r'<span class="truncate">([A-Z][A-Z0-9.\-]{0,7})\s*·')

    for ticker in parents:
        code, html = get_text(f"{base}/company/{ticker}", timeout=20)
        if code != 200 or not html:
            print(f"  /company/{ticker} HTTP {code}  FAIL", file=sys.stderr)
            ok = False
            continue

        chips_found = set(chip_pattern.findall(html)) if html else set()
        leftover = chips_found & suspect_set
        if leftover:
            print(
                f"  /company/{ticker} HTTP 200 but still has suspect chips: "
                f"{sorted(leftover)}  FAIL",
                file=sys.stderr,
            )
            ok = False
        else:
            # Peer Group marker is a useful confirmation that the
            # panel still renders for the parent — but not all
            # parents in the cohort have a panel (e.g. AMZN doesn't
            # disclose), so don't HARD fail on its absence.
            has_panel = "Peer Group" in html
            print(
                f"  /company/{ticker} HTTP 200  chips_seen={len(chips_found)}  "
                f"suspect_leftover=0  peer_panel={'yes' if has_panel else 'no'}"
            )

    code, search = get_json(f"{base}/api/search/ticker?q=nvidia&limit=3")
    if code != 200 or not search or not search.get("items"):
        print(f"  /api/search/ticker?q=nvidia FAIL (HTTP {code})", file=sys.stderr)
        ok = False
    else:
        items = search.get("items", [])
        top = items[0]["ticker"] if items else None
        print(
            f"  /api/search/ticker?q=nvidia  source={search.get('source')}  top={top}"
        )
        if top != "NVDA":
            print(f"  ERROR: expected NVDA, got {top}", file=sys.stderr)
            ok = False

    if not ok:
        return 7

    msg = "Already clean." if already_clean else "Production audit is clean."
    print(f"\nRecovery complete. {msg}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
