/**
 * Source search route.
 *
 *   GET /api/search?q=clawback&company=aapl&year=2025&section=cd_and_a
 *
 * Modes:
 *   - fixture mode: substring scan over loaded section text, ranked
 *     by hit count.
 *   - postgres mode: full-text search via tsvector on sections.text
 *     (Phase 8 GA — index migration lands when Postgres provisions).
 *
 * Returned hits include: company, filing, section_type, snippet,
 * char_offset (for the public surface to highlight). Capped at 30.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  fixtureMode,
  getCompany,
  listCompanies,
  listFilings,
  getFilingDetail,
} from "@/lib/data/source";

export const runtime = "nodejs";

interface SearchHit {
  company_id: string;
  company_name: string;
  filing_id: string;
  filing_year: number;
  section_type: string;
  snippet: string;
  char_offset: number;
}

const SNIPPET_RADIUS = 140;
const MAX_HITS = 30;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const companyFilter = url.searchParams.get("company") ?? "";
  const yearFilter = url.searchParams.get("year");
  // Default search scope = every section type. Callers that want the
  // historical CD&A-only search can still pass `?section=cd_and_a`.
  // Empty string is treated the same as missing (defaults to all).
  const sectionFilter = (url.searchParams.get("section") || "all").trim();

  if (q.length < 2) {
    return NextResponse.json({ items: [], total: 0 });
  }

  if (!fixtureMode()) {
    // Postgres-backed FTS path. Real tsvector lookup is gated on a
    // migration adding `section_search_idx` (Phase 8 GA). Until then
    // we fall through to the fixture path.
  }

  const items: SearchHit[] = [];
  const lower = q.toLowerCase();
  const candidates = companyFilter
    ? [await getCompany(companyFilter)].filter(
        (c): c is NonNullable<Awaited<ReturnType<typeof getCompany>>> => Boolean(c),
      )
    : await listCompanies();

  for (const company of candidates) {
    for (const filingMeta of await listFilings(company.id)) {
      if (yearFilter && String(filingMeta.filing_year) !== yearFilter) continue;
      const detail = await getFilingDetail(filingMeta.id);
      if (!detail) continue;
      for (const section of detail.sections) {
        if (sectionFilter !== "all" && section.section_type !== sectionFilter)
          continue;
        const text = section.text ?? "";
        const lowerText = text.toLowerCase();
        let from = 0;
        while (items.length < MAX_HITS) {
          const idx = lowerText.indexOf(lower, from);
          if (idx === -1) break;
          const start = Math.max(0, idx - SNIPPET_RADIUS);
          const end = Math.min(text.length, idx + q.length + SNIPPET_RADIUS);
          items.push({
            company_id: company.id,
            company_name: company.name,
            filing_id: detail.id,
            filing_year: detail.filing_year,
            section_type: section.section_type,
            snippet:
              (start > 0 ? "…" : "") +
              text.slice(start, end).replace(/\s+/g, " ").trim() +
              (end < text.length ? "…" : ""),
            char_offset: idx,
          });
          from = idx + q.length;
        }
      }
      if (items.length >= MAX_HITS) break;
    }
    if (items.length >= MAX_HITS) break;
  }

  return NextResponse.json({
    items,
    total: items.length,
    truncated: items.length >= MAX_HITS,
  });
}
