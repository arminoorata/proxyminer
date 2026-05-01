#!/usr/bin/env python3
"""
Phase 0 hardening pass — addresses Codex-substitute review punchlist.

Implements:
  P0-1  Tag executive_comp as `python-mirror` provenance with source hash.
  P0-3  Annotate filings with peer_group_count == 0 explicitly.
  P0-4  Replace `source.html` symlink with a real copy + SHA-256 record.
  P0-5  Capture extractor file SHA-256s + bs4/lxml version pins.
  P1-3  Per-filing `provenance.json` rollup + freeze `ingest_jobs` table.
  P1-5  Freeze the SEC ticker map snapshot used by peer resolution.
  P1-6  Inventory company-specific branches in fact_extractor.py + peer_extractor.py.

Idempotent — safe to re-run.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

PM_ROOT = Path("/srv/projects/ProxyMiner")
DB_PATH = PM_ROOT / "data" / "proxyminer.db"
ARTIFACTS_ROOT = PM_ROOT / "data" / "artifacts"
SVC_ROOT = PM_ROOT / "apps" / "api" / "app" / "services"
FIXTURES = Path(__file__).resolve().parent.parent / ".fixtures"
BY_FILING = FIXTURES / "by-filing"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(p: Path) -> str:
    return sha256_bytes(p.read_bytes())


def load_python_versions() -> dict[str, str]:
    versions: dict[str, str] = {}
    try:
        sys.path.insert(0, str(PM_ROOT / "apps" / "api"))
        import bs4  # type: ignore
        import lxml  # type: ignore
        versions["bs4"] = getattr(bs4, "__version__", "unknown")
        versions["lxml"] = getattr(lxml, "__version__", "unknown")
    except Exception as exc:  # noqa: BLE001
        versions["error"] = str(exc)
    return versions


def freeze_extractor_hashes() -> dict[str, str]:
    files = [
        "extractor.py",
        "peer_extractor.py",
        "fact_extractor.py",
        "executive_comp_extractor.py",
        "sec_client.py",
        "ingest.py",
        "provenance.py",
        "coverage_report.py",
    ]
    return {f: sha256_file(SVC_ROOT / f) for f in files if (SVC_ROOT / f).exists()}


def freeze_ingest_jobs() -> list[dict]:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM ingest_jobs ORDER BY id").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def freeze_ticker_map() -> dict | None:
    """The SEC ticker map is fetched on demand by sec_client.py and not
    persisted as a separate artifact. Look for the snapshot inside the
    `submissions` JSON files we already have, which carry per-issuer CIK
    and ticker — enough to reconstruct the resolver's view.
    """
    snapshot: dict[str, Any] = {}
    for sub in ARTIFACTS_ROOT.rglob("submissions/CIK*.json"):
        try:
            payload = json.loads(sub.read_text())
        except Exception:  # noqa: BLE001
            continue
        cik = payload.get("cik")
        tickers = payload.get("tickers") or []
        name = payload.get("name")
        if cik and tickers:
            primary = tickers[0]
            snapshot[primary.upper()] = {
                "cik": str(cik).zfill(10),
                "ticker": primary.upper(),
                "name": name,
                "all_tickers": [t.upper() for t in tickers],
            }
    return snapshot if snapshot else None


def annotate_filing(filing_dir: Path) -> dict[str, Any]:
    """Promote each filing dir from raw fixture dump to a parity-ready
    fixture: copy source.html (no symlink), record SHA, build provenance
    rollup, label exec_comp as python-mirror.
    """
    notes: dict[str, Any] = {"filing_dir": str(filing_dir.relative_to(FIXTURES))}

    # P0-4: replace symlink with real copy + SHA
    src = filing_dir / "source.html"
    if src.is_symlink():
        target = src.resolve()
        if target.exists():
            data = target.read_bytes()
            src.unlink()
            src.write_bytes(data)
            notes["source_html_sha256"] = sha256_bytes(data)
            notes["source_html_bytes"] = len(data)
        else:
            notes["source_html_sha256"] = None
            notes["source_html_missing"] = True
    elif src.exists():
        data = src.read_bytes()
        notes["source_html_sha256"] = sha256_bytes(data)
        notes["source_html_bytes"] = len(data)
    else:
        notes["source_html_sha256"] = None
        notes["source_html_missing"] = True

    # P1-3: per-filing provenance rollup
    sections = json.loads((filing_dir / "sections.json").read_text())
    policies = json.loads((filing_dir / "policy_facts.json").read_text())
    metrics = json.loads((filing_dir / "metric_facts.json").read_text())
    peers = json.loads((filing_dir / "peer_groups.json").read_text())
    exec_rows = json.loads((filing_dir / "executive_comp.json").read_text())

    def review_counts(rows: list[dict]) -> dict[str, int]:
        counts = {"unreviewed": 0, "reviewed": 0, "flagged": 0, "other": 0}
        for r in rows:
            status = (r.get("review_status") or "unreviewed").lower()
            counts[status if status in counts else "other"] += 1
        return counts

    rollup = {
        "section_count": len(sections),
        "policy_fact_count": len(policies),
        "metric_fact_count": len(metrics),
        "peer_group_count": len(peers),
        "peer_member_count": sum(len(p.get("members", [])) for p in peers),
        "executive_comp_row_count": len(exec_rows),
        "review_status_by_artifact": {
            "sections": review_counts(sections),
            "policy_facts": review_counts(policies),
            "metric_facts": review_counts(metrics),
            "peer_groups": review_counts(peers),
        },
        "extractor_versions_seen": sorted(
            {
                v
                for rows in (sections, policies, metrics, peers)
                for r in rows
                if (v := r.get("extractor_version"))
            }
        ),
        # P0-1: exec_comp fixture is a python-mirror, not curated truth.
        # The TS port matching this fixture proves byte-for-byte parity
        # with Python on 2026-04-30. To prove correctness against the SEC
        # filing itself, hand-curate truth fixtures for a handful of
        # filings (see Decisions D-002).
        "executive_comp_provenance": "python-mirror",
    }
    (filing_dir / "provenance.json").write_text(
        json.dumps(rollup, indent=2, sort_keys=True)
    )
    notes["rollup"] = rollup

    # P0-3: explicit "no peer group" / "no metric facts" annotations
    issues: list[str] = []
    if rollup["peer_group_count"] == 0:
        issues.append("zero_peer_groups")
    if rollup["metric_fact_count"] == 0:
        issues.append("zero_metric_facts")
    if rollup["policy_fact_count"] == 0:
        issues.append("zero_policy_facts")
    if rollup["executive_comp_row_count"] == 0:
        issues.append("zero_exec_comp_rows")
    if rollup["section_count"] == 0:
        issues.append("zero_sections")
    notes["potential_issues"] = issues
    return notes


def inventory_company_specific_branches() -> list[dict[str, Any]]:
    """Scan extractor sources for company-name conditionals so the TS
    port has an explicit checklist (P1-6).
    """
    targets = ["fact_extractor.py", "peer_extractor.py", "executive_comp_extractor.py"]
    pattern = re.compile(
        r"(microsoft|salesforce|apple|amazon|alphabet|google|meta|netflix|nvidia|"
        r"oracle|qualcomm|adobe|broadcom|crm|aapl|msft|amzn|googl|nflx|nvda|orcl|"
        r"qcom|adbe|avgo|meta_)",
        re.IGNORECASE,
    )
    findings: list[dict[str, Any]] = []
    for fname in targets:
        path = SVC_ROOT / fname
        if not path.exists():
            continue
        for i, line in enumerate(path.read_text().splitlines(), start=1):
            if pattern.search(line):
                findings.append(
                    {
                        "file": fname,
                        "line": i,
                        "snippet": line.strip()[:180],
                    }
                )
    return findings


def main() -> None:
    summary: dict[str, Any] = {
        "frozen_at": "2026-04-30",
        "oracle": {
            "git_path": str(PM_ROOT),
            "extractor_file_sha256": freeze_extractor_hashes(),
            "python_dep_versions": load_python_versions(),
        },
        "filings": [],
        "company_specific_branches": inventory_company_specific_branches(),
        "cohort_caveats": {
            "form_types_present": ["DEF 14A"],
            "form_types_missing_for_phase4": [
                "DEF 14A/A (amendments)",
                "PRE 14A",
                "DEFA14A (supplements)",
                "10-K combined",
                "20-F / 6-K (foreign issuers)",
            ],
            "year_range": "2023-2026",
            "year_gap_for_phase4": "pre-2023 (pre-PvP rule SCT shape)",
            "sector_concentration": "100% mega-cap US tech",
            "sector_gaps_for_phase4": [
                "financials (banks, insurers)",
                "REITs",
                "biotech",
                "consumer staples",
                "small-cap",
                "controlled companies",
                "recent IPOs",
                "foreign private issuers",
            ],
            "issue": (
                "Codex P0-2 — cohort is structurally homogeneous. The TS extractor "
                "port can match the Python oracle on these 32 filings while still "
                "failing on long-tail filings. Phase 4 must add ≥3 long-tail "
                "filings (see User-Actions A-008) before declaring extractor parity."
            ),
        },
    }

    # Freeze ingest_jobs
    jobs = freeze_ingest_jobs()
    (FIXTURES / "ingest_jobs.json").write_text(
        json.dumps(jobs, indent=2, sort_keys=True, default=str)
    )
    summary["ingest_jobs_count"] = len(jobs)

    # Freeze ticker map
    ticker_map = freeze_ticker_map()
    if ticker_map is not None:
        (FIXTURES / "ticker_map.json").write_text(
            json.dumps(ticker_map, indent=2, sort_keys=True)
        )
        summary["ticker_map_size"] = len(ticker_map)
    else:
        summary["ticker_map_size"] = 0

    # Per-filing hardening
    for company_dir in sorted(BY_FILING.iterdir()):
        if not company_dir.is_dir():
            continue
        for filing_dir in sorted(company_dir.iterdir()):
            if not filing_dir.is_dir():
                continue
            notes = annotate_filing(filing_dir)
            summary["filings"].append(notes)

    (FIXTURES / "FROZEN.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True, default=str)
    )

    # Quick text summary for humans
    issue_count = sum(len(f.get("potential_issues") or []) for f in summary["filings"])
    print(f"Hardened {len(summary['filings'])} filings.")
    print(f"  ingest_jobs frozen: {summary['ingest_jobs_count']}")
    print(f"  ticker_map size: {summary['ticker_map_size']}")
    print(f"  company-specific branches found: {len(summary['company_specific_branches'])}")
    print(f"  filings flagged with potential issues: "
          f"{sum(1 for f in summary['filings'] if f.get('potential_issues'))} "
          f"({issue_count} total flags)")


if __name__ == "__main__":
    main()
