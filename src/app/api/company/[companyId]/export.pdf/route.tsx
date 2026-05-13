/**
 * Per-company PDF export.
 *
 *   GET /api/company/{id}/export.pdf
 *
 * Streams a multi-page analyst pack: headline facts, executive
 * compensation table, pay mix, source citations. Generated server-side
 * with @react-pdf/renderer so the report mirrors exactly what the
 * /company/[id] page surfaces — same facts, same provenance, same
 * source excerpts.
 *
 * Public endpoint (no auth) because the underlying data is public:
 * the company page is itself unauthenticated. If we later add private
 * companies/peers, gate this route on the same predicate.
 */
import { renderToBuffer } from "@react-pdf/renderer";
import { NextRequest, NextResponse } from "next/server";

import {
  getCompany,
  getFilingDetail,
  getLatestFiling,
  listFilings,
} from "@/lib/data/source";
import { CompanyReport } from "@/lib/pdf/company-report";
import { assemblePeerSnapshot } from "@/lib/pdf/peer-snapshot";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ companyId: string }> },
) {
  const { companyId } = await params;
  const company = await getCompany(companyId);
  if (!company) {
    return NextResponse.json({ error: "company not found" }, { status: 404 });
  }
  const latest = await getLatestFiling(companyId);
  if (!latest) {
    return NextResponse.json(
      { error: "no filings ingested for this company yet" },
      { status: 404 },
    );
  }
  const filings = await listFilings(companyId);
  const priorFilingId = filings[1]?.id ?? null;
  const prior = priorFilingId ? await getFilingDetail(priorFilingId) : null;

  // Peer snapshot: up to 4 auto-selected peers from the focal
  // filing's disclosed compensation peer group, each fetched at their
  // own latest filing so the PDF shows current peer comp data even
  // though the focal filing was filed earlier.
  const peers = await assemblePeerSnapshot(companyId, latest, {
    getCompany,
    getLatestFiling,
  });

  const buf = await renderToBuffer(
    <CompanyReport
      company={company}
      latest={latest}
      prior={prior}
      peers={peers}
      generatedAt={new Date()}
    />,
  );

  const fileName = `proxyminer-${company.id}-${latest.filing_year}.pdf`;
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${fileName}"`,
      // Short cache: the underlying data is updated weekly via cron;
      // letting Vercel cache for 5 minutes still avoids re-rendering
      // for repeated downloads while staying responsive to ingest.
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}
