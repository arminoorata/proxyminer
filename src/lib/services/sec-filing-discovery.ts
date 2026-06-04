/**
 * SEC filing discovery — newest-first target-form filings across the
 * submissions JSON's `filings.recent` block AND, only when needed, the
 * paginated `filings.files` archive.
 *
 * Background: SEC's `data.sec.gov/submissions/CIK*.json` keeps only the most
 * recent ~1000 filings in `filings.recent`; older filings live in additional
 * JSON files listed under `filings.files` (e.g. `CIK…-submissions-001.json`).
 * The original ingest read `recent` only, so a proxy that had aged out of
 * `recent` (Meta's 2024 DEF 14A) was unreachable at any `limit`.
 *
 * This helper fills the gap with the SMALLEST possible behavior change:
 *   - If `recent` already yields >= `limit` target-form filings, it returns
 *     exactly those (native newest-first order) and NEVER fetches an archive
 *     file — identical to the old behavior.
 *   - Only when `recent` is short does it lazily fetch archive index files
 *     (newest archive first), stopping as soon as `limit` is reached or a
 *     bounded number of archive files have been read.
 *
 * Pure + injectable: the caller passes `fetchArchive`, so this is unit-tested
 * with synthetic payloads and never touches the live SEC network here.
 */

export interface SecSubmissionsBlock {
  accessionNumber: string[];
  form: string[];
  filingDate: string[];
  primaryDocument: string[];
}

export interface SecArchiveFileRef {
  name: string;
  filingCount?: number;
  filingFrom?: string;
  filingTo?: string;
}

export interface DiscoveredFiling {
  accession: string;
  form: string;
  filingDate: string;
  primaryDocument: string;
}

// Bound how many archive index files we will pull in one discovery pass.
// One archive file (~1000 filings) covers years of history for a typical
// filer, so this is a generous ceiling that still caps SEC fetches.
export const DEFAULT_MAX_ARCHIVE_FILES = 4;

function collectTargetForms(
  block: SecSubmissionsBlock | undefined,
  targetForms: Set<string>,
  out: DiscoveredFiling[],
  limit?: number,
): void {
  if (!block || !Array.isArray(block.accessionNumber)) return;
  const n = block.accessionNumber.length;
  for (let i = 0; i < n; i++) {
    if (limit !== undefined && out.length >= limit) return;
    const form = block.form?.[i] ?? "";
    if (!targetForms.has(form)) continue;
    out.push({
      accession: block.accessionNumber[i] ?? "",
      form,
      filingDate: block.filingDate?.[i] ?? "",
      primaryDocument: block.primaryDocument?.[i] ?? "",
    });
  }
}

/**
 * Return up to `limit` target-form filings, newest first.
 *
 * Ordering note: global newest-first (by filingDate) is guaranteed only on
 * the archive-fallback path. The recent-only early return intentionally
 * inherits `filings.recent`'s native acceptance order to stay byte-identical
 * to the prior recent-only loop; if `recent` is not strictly date-descending
 * (a late/amended filing), the two paths can order the same filings
 * differently. This is benign for ingest (each filing is persisted
 * independently). A future caller needing strict global ordering on both
 * paths should sort `recentMatches` before the early-return slice.
 *
 * @param recent       The `filings.recent` block (already newest-first).
 * @param archiveFiles The `filings.files` array (may be empty/undefined).
 * @param limit        Max filings to return (newest first).
 * @param targetForms  Form types to keep (e.g. {"DEF 14A"}).
 * @param fetchArchive Loads an archive block by its `name` (injected).
 */
export async function discoverTargetFilings(args: {
  recent: SecSubmissionsBlock;
  archiveFiles?: SecArchiveFileRef[];
  limit: number;
  targetForms: Set<string>;
  fetchArchive: (name: string) => Promise<SecSubmissionsBlock>;
  maxArchiveFiles?: number;
}): Promise<DiscoveredFiling[]> {
  const {
    recent,
    archiveFiles = [],
    limit,
    targetForms,
    fetchArchive,
    maxArchiveFiles = DEFAULT_MAX_ARCHIVE_FILES,
  } = args;

  if (limit <= 0) return [];

  // 1. Recent block, newest-first. Stop at `limit` so the satisfied case is
  //    byte-identical to the old recent-only loop.
  const recentMatches: DiscoveredFiling[] = [];
  collectTargetForms(recent, targetForms, recentMatches, limit);
  if (recentMatches.length >= limit) {
    return recentMatches.slice(0, limit);
  }

  // 2. Archive fallback — only reached when `recent` is short. Pull archive
  //    index files newest-first, lazily, capped, tolerating failures.
  const all: DiscoveredFiling[] = [...recentMatches];
  const sortedFiles = [...archiveFiles].sort(
    (a, b) =>
      (b.filingTo ?? "").localeCompare(a.filingTo ?? "") ||
      (b.filingFrom ?? "").localeCompare(a.filingFrom ?? ""),
  );
  let fetched = 0;
  for (const file of sortedFiles) {
    if (all.length >= limit) break;
    if (fetched >= maxArchiveFiles) break;
    if (!file?.name) continue;
    fetched++;
    try {
      const block = await fetchArchive(file.name);
      collectTargetForms(block, targetForms, all);
    } catch {
      // A missing or malformed archive file must not abort discovery; the
      // newest reachable filings still come back.
    }
  }

  // 3. Dedupe by accession (first wins), sort newest-first with a stable
  //    accession tiebreak, take `limit`.
  const byAccession = new Map<string, DiscoveredFiling>();
  for (const f of all) {
    if (f.accession && !byAccession.has(f.accession)) {
      byAccession.set(f.accession, f);
    }
  }
  return [...byAccession.values()]
    .sort(
      (a, b) =>
        b.filingDate.localeCompare(a.filingDate) ||
        b.accession.localeCompare(a.accession),
    )
    .slice(0, limit);
}
