/**
 * Display-name cleanup for executive rows.
 *
 * The SCT extractor occasionally returns an executive_name with a
 * dangling title fragment, e.g.:
 *   - "Sundar PichaiChief"      (Chief merged into the name on wrap)
 *   - "Neil M. AsheChairman"    (Chairman merged in)
 *   - "TED SARANDOSco-"         (NFLX co-CEO wrap)
 *
 * `cleanExecutiveDisplayName(name)` strips the trailing artifact so
 * the UI shows the bare person name everywhere — company page,
 * compare page, exec-pay table, diff page, and the PDF report.
 *
 * Important: the `co-` cleanup REQUIRES the trailing hyphen. Without
 * it we'd clip legitimate surnames that end in "co" (Bianco, Cisco,
 * Banco, Marco, Franco). The wrap artifact always carries the hyphen
 * because the next token after the wrap is a title word ("co-Chief
 * Executive Officer"), so the hyphen is the reliable signal.
 */

const TRAILING_TITLE_FRAGMENT =
  /\s*(?:co-|Chief|President|Senior Vice President|SVP|EVP|Chairman|Chair|Officer)\s*$/i;

export function cleanExecutiveDisplayName(name: string | null | undefined): string {
  if (!name) return "";
  return name.replace(TRAILING_TITLE_FRAGMENT, "").trim();
}
