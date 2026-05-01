#!/usr/bin/env python3
"""
Phase 0 fixture freeze.

Read the live SQLite DB + stored artifacts at /srv/projects/ProxyMiner and
emit per-filing JSON fixtures into ../.fixtures/by-filing/<company_id>/<filing_id>/.

Each fixture directory contains:
  - company.json           — company metadata
  - filing.json            — filing metadata (form type, date, accession, document refs)
  - sections.json          — extracted sections (CD&A primarily)
  - executive_comp.json    — executive comp rows (re-runs extractor on stored HTML)
  - peer_groups.json       — peer groups + members
  - policy_facts.json      — array of policy facts
  - metric_facts.json      — array of metric facts
  - provenance.json        — provenance summaries per artifact
  - source.html            — symlink to the primary filing HTML

The emitted JSON is the ORACLE for the TS rewrite. Every TS extractor must
either match these outputs byte-for-byte (preferred) or document a tolerated
diff in the parity log.

Usage:
  PYTHONPATH=/srv/projects/ProxyMiner/apps/api \\
    /srv/projects/ProxyMiner/.venv/bin/python scripts/freeze_fixtures.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

# We rely on the existing Python services for executive comp extraction
# (which is read-time, not persisted). Sections / facts / peer groups are
# stored, so we just dump them straight from SQLite.
sys.path.insert(0, "/srv/projects/ProxyMiner/apps/api")
from app.services.executive_comp_extractor import (  # type: ignore[import]
    ExecutiveCompensationExtractor,
)


PM_ROOT = Path("/srv/projects/ProxyMiner")
DB_PATH = PM_ROOT / "data" / "proxyminer.db"
ARTIFACTS_ROOT = PM_ROOT / "data" / "artifacts"
OUT_ROOT = Path(__file__).resolve().parent.parent / ".fixtures" / "by-filing"


def to_jsonable(obj: Any) -> Any:
    if is_dataclass(obj):
        return {k: to_jsonable(v) for k, v in asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    return str(obj)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(to_jsonable(payload), indent=2, sort_keys=True, default=str))


def fetch_companies(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, cik, ticker, name, sector FROM companies ORDER BY id"
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_filings(conn: sqlite3.Connection, company_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, company_id, accession_number, filing_date, filing_year,
               form_type, acceptance_datetime, source_index_url,
               primary_document_url, primary_document_name, report_date
        FROM filings
        WHERE company_id = ?
        ORDER BY filing_date DESC
        """,
        (company_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_documents(conn: sqlite3.Connection, filing_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id, filing_id, document_name, document_type, description,
               is_primary, source_url, storage_path, mime_type, sha256
        FROM documents
        WHERE filing_id = ?
        """,
        (filing_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_sections(conn: sqlite3.Connection, filing_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM sections WHERE filing_id = ?",
        (filing_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_policy_facts(conn: sqlite3.Connection, filing_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM policy_facts WHERE filing_id = ?",
        (filing_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_metric_facts(conn: sqlite3.Connection, filing_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM metric_facts WHERE filing_id = ?",
        (filing_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_peer_groups(conn: sqlite3.Connection, filing_id: str) -> list[dict]:
    pg_rows = conn.execute(
        "SELECT * FROM peer_groups WHERE filing_id = ?",
        (filing_id,),
    ).fetchall()
    groups: list[dict] = []
    for pg in pg_rows:
        members = conn.execute(
            "SELECT * FROM peer_group_members WHERE peer_group_id = ?",
            (pg["id"],),
        ).fetchall()
        d = dict(pg)
        d["members"] = [dict(m) for m in members]
        groups.append(d)
    return groups


def find_primary_doc_path(documents: list[dict]) -> str | None:
    primary = next((d for d in documents if d.get("is_primary")), None)
    if primary and primary.get("storage_path"):
        return primary["storage_path"]
    return None


def main() -> None:
    if not DB_PATH.exists():
        print(f"Database not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    extractor = ExecutiveCompensationExtractor()

    companies = fetch_companies(conn)
    OUT_ROOT.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "company_count": len(companies),
        "filings": [],
        "extractor_versions": {},
    }

    for company in companies:
        cid = company["id"]
        company_dir = OUT_ROOT / cid
        company_dir.mkdir(parents=True, exist_ok=True)
        (company_dir / "company.json").write_text(
            json.dumps(to_jsonable(company), indent=2, sort_keys=True)
        )
        filings = fetch_filings(conn, cid)
        for filing in filings:
            fid = filing["id"]
            filing_dir = company_dir / fid
            filing_dir.mkdir(parents=True, exist_ok=True)

            documents = fetch_documents(conn, fid)
            sections = fetch_sections(conn, fid)
            policies = fetch_policy_facts(conn, fid)
            metrics = fetch_metric_facts(conn, fid)
            peers = fetch_peer_groups(conn, fid)

            # Re-run executive comp extraction off the primary HTML — this
            # mirrors the live read-path in apps/api so the fixture matches
            # what the current UI sees today.
            exec_rows: list[Any] = []
            primary_storage = find_primary_doc_path(documents)
            if primary_storage:
                primary_path = ARTIFACTS_ROOT / primary_storage
                if primary_path.exists():
                    html = primary_path.read_text(errors="ignore")
                    exec_rows = extractor.extract_from_html(html)

            write_json(filing_dir / "filing.json", filing)
            write_json(filing_dir / "documents.json", documents)
            write_json(filing_dir / "sections.json", sections)
            write_json(filing_dir / "executive_comp.json", exec_rows)
            write_json(filing_dir / "peer_groups.json", peers)
            write_json(filing_dir / "policy_facts.json", policies)
            write_json(filing_dir / "metric_facts.json", metrics)

            # Symlink the primary HTML so the TS extractor port can read
            # from a stable, fixture-relative path. Use a relative symlink
            # so the fixture tree is portable.
            if primary_storage:
                primary_path = ARTIFACTS_ROOT / primary_storage
                src_link = filing_dir / "source.html"
                if src_link.is_symlink() or src_link.exists():
                    src_link.unlink()
                if primary_path.exists():
                    rel = os.path.relpath(primary_path, filing_dir)
                    src_link.symlink_to(rel)

            summary["filings"].append({
                "company_id": cid,
                "filing_id": fid,
                "filing_year": filing.get("filing_year"),
                "filing_date": str(filing.get("filing_date") or ""),
                "section_count": len(sections),
                "policy_fact_count": len(policies),
                "metric_fact_count": len(metrics),
                "peer_group_count": len(peers),
                "peer_member_count": sum(len(p.get("members", [])) for p in peers),
                "executive_comp_row_count": len(exec_rows),
                "has_primary_html": primary_storage is not None
                and (ARTIFACTS_ROOT / primary_storage).exists(),
            })

            print(
                f"[{cid}/{fid}] sections={len(sections)} "
                f"exec_rows={len(exec_rows)} peers={len(peers)} "
                f"policies={len(policies)} metrics={len(metrics)}"
            )

    # Cohort summary at the root for fast inspection.
    summary["extractor_versions"]["executive_comp"] = "executive_comp_extractor.v1"
    write_json(OUT_ROOT.parent / "FROZEN.json", summary)

    print(f"\nFroze {len(summary['filings'])} filings across {summary['company_count']} companies")
    print(f"Output: {OUT_ROOT}")


if __name__ == "__main__":
    main()
