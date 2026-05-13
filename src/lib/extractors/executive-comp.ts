/**
 * Executive compensation extractor — TypeScript port of
 * /srv/projects/ProxyMiner/apps/api/app/services/executive_comp_extractor.py
 *
 * Strategy mirrors the Python 1:1:
 *   1. Find headings matching "summary compensation table". For each,
 *      grab the next ≤3 <table> nodes.
 *   2. If no heading-led tables matched, fall back to scanning every
 *      <table> in the document.
 *   3. For each candidate table:
 *      a. Build a row matrix that unrolls rowspan + colspan.
 *      b. Find the data-start row (the first row containing a 4-digit
 *         year and ≥3 numeric cells).
 *      c. Aggregate headers from rows above data_start (joined by " ").
 *      d. Map standard SCT columns by regex against the headers, with
 *         a tiebreaker that scores candidate columns by how
 *         "year-like" / "numeric-like" / "name-like" their data is.
 *      e. Walk data rows. Group consecutive rows by executive name
 *         (handles split-title rows where the position is on its own
 *         row below the name). Emit one row per (executive, year)
 *         tuple.
 *   4. Score each candidate's row list. The highest-scoring set wins.
 *
 * Memory note: cheerio doesn't need decompose(); we drop the parsed
 * tree as soon as the candidate list is built.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";

import type { ExecutiveCompRow } from "@/lib/types";
import { isCeoPosition } from "@/lib/exec/ceo";

export const EXECUTIVE_COMP_EXTRACTOR_VERSION = "executive_comp_extractor.ts.v1";

// A real SCT heading is short and either fullmatches the canonical
// phrase or has at most a short fiscal-year/qualifier suffix. Body
// sentences like "These values differ from those reported in the
// Summary Compensation Table and..." don't fullmatch this and are
// rejected by `looksLikeSctHeading()`.
const SCT_HEADING_PATTERN =
  /^(?:fiscal\s+(?:year\s+)?20\d{2}\s+)?summary\s+compensation\s+table(?:\s+(?:for|of)\s+[^.]{0,80}?)?(?:\s*[-–—:]\s*[^.]{0,40})?$/i;
const SCT_HEADING_TAG_PRIORITY: Record<string, number> = {
  h1: 0, h2: 1, h3: 2, h4: 3, b: 4, strong: 4, p: 5, div: 6, span: 7, td: 8,
};
const YEAR_PATTERN = /^(?:19|20)\d{2}$/;
const NUMERIC_PATTERN = /^\d[\d,]*(?:\.\d+)?$/;
// Title-fragment vocabulary used by `looksLikePersonName` to reject
// rows whose "name" cell actually carries a position phrase (e.g.
// "Chairman and CEO" on a continuation row). Each entry is matched
// at the start of the string with a word boundary at the end of the
// matched fragment — so "Chairman" and "Chairperson" are both listed
// explicitly because `Chair\b` would not match "Chairman" (no word
// boundary between 'r' and 'm').
const TITLE_FRAGMENT_PATTERN =
  /^(?:Chair(?:man|person|woman)?|Chief|Executive|Senior|President|Vice|Principal|General Counsel|Co-?Founder|Founder|Lead|Technology|Officer|Former|Acting|Interim|Retired|EVP|SVP|CFO|CEO|COO|CTO|Director|Legal|Corporate|Retail|People|Secretary|Architect|Advisor)\b/i;

export function extractExecutiveCompensation(
  html: string,
): ExecutiveCompRow[] {
  if (!html.trim()) return [];
  const $ = cheerio.load(html);

  const candidates: { score: number; rows: ExecutiveCompRow[] }[] = [];
  const seenTables = new WeakSet<object>();

  function consider(table: import("domhandler").Element, bonus: number) {
    if (seenTables.has(table)) return;
    seenTables.add(table);
    const parsed = parseTable($, table);
    if (parsed.length === 0) return;
    candidates.push({ score: scoreRows(parsed) + bonus, rows: parsed });
  }

  // 1. Heading-led search. Find tags whose normalized text fullmatches
  //    the SCT heading shape (not body-sentence references), then walk
  //    forward for the next data table. Tables found this way get a
  //    score bonus so they outrank incidental tables elsewhere in the
  //    document with similar column structures.
  const headings = findSctHeadings($);
  for (const heading of headings) {
    const tables = nextTables($, heading, 4);
    for (const table of tables) consider(table, /* headingBonus */ 6);
  }

  // 2. Always also scan every table in the document. The old code
  //    skipped this fallback whenever heading-led found ANYTHING,
  //    which left NVDA / CRM / KEY / WMT stuck whenever the heading
  //    finder matched a body-sentence reference followed by an
  //    unrelated table. The scoring function below sorts the real SCT
  //    (high row count, has CEO, multi-year, salary + stock present)
  //    above unrelated tables.
  $("table").each((_, table) => consider(table, 0));

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].rows;
}

/**
 * Find DOM nodes that look like real SCT headings (not body-text
 * references). A heading is a tag whose normalized text fullmatches
 * `SCT_HEADING_PATTERN` and lives in a heading-priority tag.
 */
function findSctHeadings($: CheerioAPI): import("domhandler").Element[] {
  const seen = new Set<import("domhandler").Element>();
  const matches: { score: number; el: import("domhandler").Element }[] = [];
  $("h1, h2, h3, h4, b, strong, p, div, span, td").each((_, el) => {
    const text = $(el)
      .text()
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length > 140) return;
    if (!SCT_HEADING_PATTERN.test(text)) return;
    const tag = (el.tagName ?? "").toLowerCase();
    const score = SCT_HEADING_TAG_PRIORITY[tag] ?? 99;
    matches.push({ score, el });
  });
  matches.sort((a, b) => a.score - b.score);
  const out: import("domhandler").Element[] = [];
  for (const m of matches) {
    if (seen.has(m.el)) continue;
    seen.add(m.el);
    out.push(m.el);
  }
  return out;
}

// ── Table parsing ────────────────────────────────────────────────────

function parseTable(
  $: CheerioAPI,
  table: import("domhandler").Element,
): ExecutiveCompRow[] {
  const matrix = tableMatrix($, table);
  if (matrix.length === 0) return [];
  const dataStart = dataStartIndex(matrix);
  if (dataStart === null) return [];
  const headers = columnHeaders(matrix, dataStart);
  const columnMap = columnMapFor(headers, matrix, dataStart);
  if (
    columnMap.name == null ||
    columnMap.year == null ||
    columnMap.total == null
  ) {
    return [];
  }

  const rows: ExecutiveCompRow[] = [];
  let currentName: string | null = null;
  let positionFragments: string[] = [];
  let groupEntries: { row: string[]; values: ValueSet; year_text: string }[] = [];

  function flushGroup() {
    if (!currentName || groupEntries.length === 0) {
      currentName = null;
      positionFragments = [];
      groupEntries = [];
      return;
    }
    const combined = mergePositionFragments(positionFragments);
    for (const entry of groupEntries) {
      const rowText = entry.row.filter(Boolean).join(" | ");
      rows.push({
        executive_name: currentName,
        principal_position: combined,
        year: Number.parseInt(entry.year_text, 10),
        salary: entry.values.salary,
        bonus: entry.values.bonus,
        stock_awards: entry.values.stock_awards,
        option_awards: entry.values.option_awards,
        non_equity_incentive_plan_compensation: entry.values.non_equity_incentive_plan_compensation,
        all_other_compensation: entry.values.all_other_compensation,
        total: entry.values.total,
        source_excerpt: rowText.slice(0, 800),
      });
    }
    currentName = null;
    positionFragments = [];
    groupEntries = [];
  }

  for (let i = dataStart; i < matrix.length; i++) {
    const row = matrix[i];
    const yearText = cellValue(row, columnMap.year);
    if (!yearText || !YEAR_PATTERN.test(yearText)) continue;

    const values: ValueSet = {
      salary: cellValue(row, columnMap.salary),
      bonus: cellValue(row, columnMap.bonus),
      stock_awards: cellValue(row, columnMap.stock_awards),
      option_awards: cellValue(row, columnMap.option_awards),
      non_equity_incentive_plan_compensation: cellValue(
        row,
        columnMap.non_equity_incentive_plan_compensation,
      ),
      all_other_compensation: cellValue(row, columnMap.all_other_compensation),
      total: cellValue(row, columnMap.total),
    };
    if (!values.total) continue;

    const nameRaw = cellValue(row, columnMap.name);
    const split = splitNameAndPosition(nameRaw ?? "");
    const candidateName = split.name;
    const candidatePosition = split.position;
    const looksLikeName = looksLikePersonName(candidateName);

    if (looksLikeName && candidateName !== currentName) {
      flushGroup();
      currentName = candidateName;
    }
    if (looksLikeName) {
      if (candidatePosition) positionFragments.push(candidatePosition);
    } else if (nameRaw) {
      if (currentName === null || nameRaw.toLowerCase() === "total") continue;
      positionFragments.push(nameRaw);
    } else if (currentName === null) {
      continue;
    }

    groupEntries.push({ row, year_text: yearText, values });
  }

  flushGroup();
  return rows;
}

interface ValueSet {
  salary: string | null;
  bonus: string | null;
  stock_awards: string | null;
  option_awards: string | null;
  non_equity_incentive_plan_compensation: string | null;
  all_other_compensation: string | null;
  total: string | null;
}

interface ColumnMap {
  name: number | null;
  year: number | null;
  salary: number | null;
  bonus: number | null;
  stock_awards: number | null;
  option_awards: number | null;
  non_equity_incentive_plan_compensation: number | null;
  all_other_compensation: number | null;
  total: number | null;
}

// ── Matrix building ──────────────────────────────────────────────────

function tableMatrix(
  $: CheerioAPI,
  table: import("domhandler").Element,
): string[][] {
  const rowsOut: string[][] = [];
  const rowspans = new Map<number, { value: string; remaining: number }>();
  let maxColumns = 0;

  $(table)
    .find("tr")
    .each((_, tr) => {
      const cells: import("domhandler").Element[] = [];
      // recursive: false equivalent — only direct th/td children.
      for (const child of (tr as import("domhandler").Element).children ?? []) {
        if (
          child.type === "tag" &&
          (child.tagName === "th" || child.tagName === "td")
        ) {
          cells.push(child);
        }
      }
      if (cells.length === 0) return;

      const row: string[] = [];
      let colIndex = 0;

      function fillSpansUntil(nextCol: number | null = null): void {
        for (;;) {
          const carry = rowspans.get(colIndex);
          if (carry) {
            row.push(carry.value);
            if (carry.remaining <= 1) {
              rowspans.delete(colIndex);
            } else {
              rowspans.set(colIndex, {
                value: carry.value,
                remaining: carry.remaining - 1,
              });
            }
            colIndex += 1;
            continue;
          }
          if (nextCol === null) {
            // Find the next pending rowspan column ≥ colIndex
            let target: number | null = null;
            for (const k of rowspans.keys()) {
              if (k >= colIndex && (target === null || k < target)) target = k;
            }
            if (target === null) return;
            while (colIndex < target) {
              row.push("");
              colIndex += 1;
            }
            continue;
          }
          if (colIndex < nextCol) {
            row.push("");
            colIndex += 1;
            continue;
          }
          return;
        }
      }

      for (const cell of cells) {
        fillSpansUntil();
        const text = normalizeCellText(
          $(cell).text().replace(/ /g, " "),
        );
        const rowspan = parseInt(
          $(cell).attr("rowspan") ?? "1",
          10,
        ) || 1;
        const colspan = parseInt(
          $(cell).attr("colspan") ?? "1",
          10,
        ) || 1;
        const startCol = colIndex;
        for (let off = 0; off < colspan; off++) {
          row.push(text);
          if (rowspan > 1) {
            rowspans.set(startCol + off, {
              value: text,
              remaining: rowspan - 1,
            });
          }
        }
        colIndex += colspan;
      }
      fillSpansUntil();
      maxColumns = Math.max(maxColumns, row.length);
      rowsOut.push(row);
    });

  // Right-pad every row to maxColumns
  return rowsOut.map((row) => {
    if (row.length === maxColumns) return row;
    return [...row, ...Array(maxColumns - row.length).fill("")];
  });
}

function dataStartIndex(matrix: string[][]): number | null {
  for (let i = 0; i < matrix.length; i++) {
    const row = matrix[i];
    if (!row.some((cell) => YEAR_PATTERN.test(cell))) continue;
    const numericCells = row.filter((cell) => {
      if (!cell) return false;
      const stripped = cell.replace(/[\$()]/g, "");
      return NUMERIC_PATTERN.test(stripped);
    }).length;
    if (numericCells >= 3) return i;
  }
  return null;
}

function columnHeaders(matrix: string[][], dataStart: number): string[] {
  const columnCount = Math.max(...matrix.map((r) => r.length));
  const headers: string[] = [];
  for (let column = 0; column < columnCount; column++) {
    const parts: string[] = [];
    for (let r = 0; r < dataStart; r++) {
      const cell = normalizeHeaderText(matrix[r][column] ?? "");
      if (cell && !parts.includes(cell)) parts.push(cell);
    }
    headers.push(parts.join(" "));
  }
  return headers;
}

function columnMapFor(
  headers: string[],
  matrix: string[][],
  dataStart: number,
): ColumnMap {
  // Header patterns are tolerant of camelCase concatenation
  // ("FiscalYear", "NameandPrincipal") because some filings wrap
  // bold-styled headers across visual lines, collapsing the spaces
  // when cheerio joins the text nodes. `normalizeHeaderText` splits
  // common camelCase joins; the patterns below also tolerate stripped
  // whitespace inside their alternations.
  return {
    name: findColumn(
      headers,
      [/\bname\b/, /named\s*executive/, /principal\s*position/],
      matrix,
      dataStart,
      "name",
    ),
    year: findColumn(
      headers,
      [
        /\byear\b/,
        /\bfiscal\s*year\b/,
        /\byear\s*ended\b/,
        // Wrap-merged forms seen on WMT, NVDA, etc.
        /\bfiscalyear(?:ended)?\b/,
        /\byearended/,
      ],
      matrix,
      dataStart,
      "year",
    ),
    salary: findColumn(headers, [/\bsalary\b/], matrix, dataStart, "numeric"),
    bonus: findColumn(headers, [/\bbonus\b/], matrix, dataStart, "numeric"),
    stock_awards: findColumn(
      headers,
      [/\bstock\s*awards?\b/],
      matrix,
      dataStart,
      "numeric",
    ),
    option_awards: findColumn(
      headers,
      [/\boption\s*awards?\b/],
      matrix,
      dataStart,
      "numeric",
    ),
    non_equity_incentive_plan_compensation: findColumn(
      headers,
      [
        /non[\s-]?equity\s*incentive\s*plan\s*compensation/,
        // Wrap-merged form: "Non-EquityIncentive PlanCompensation"
        /non[\s-]?equityincentive\s*plancompensation/,
        /non[\s-]?equityincentive/,
      ],
      matrix,
      dataStart,
      "numeric",
    ),
    all_other_compensation: findColumn(
      headers,
      [
        /\ball\s*other\s*compensation\b/,
        /\ballother\s*compensation\b/,
        /\ball\s*othercompensation\b/,
      ],
      matrix,
      dataStart,
      "numeric",
    ),
    total: findColumn(headers, [/\btotal\b/], matrix, dataStart, "numeric"),
  };
}

function findColumn(
  headers: string[],
  patterns: RegExp[],
  matrix: string[][],
  dataStart: number,
  kind: "name" | "year" | "numeric",
): number | null {
  const candidates: number[] = [];
  for (let i = 0; i < headers.length; i++) {
    const lower = headers[i].toLowerCase();
    if (patterns.some((p) => p.test(lower))) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  let bestIdx = candidates[0];
  let bestScore = scoreCandidateColumn(matrix, dataStart, candidates[0], kind);
  for (const c of candidates.slice(1)) {
    const s = scoreCandidateColumn(matrix, dataStart, c, kind);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = c;
    }
  }
  return bestIdx;
}

function scoreCandidateColumn(
  matrix: string[][],
  dataStart: number,
  columnIndex: number,
  kind: "name" | "year" | "numeric",
): number {
  let score = 0;
  const sample = matrix.slice(dataStart, dataStart + 18);
  for (const row of sample) {
    const value = cellValue(row, columnIndex);
    if (!value) continue;
    if (kind === "year") {
      score += YEAR_PATTERN.test(value) ? 3 : 0;
    } else if (kind === "numeric") {
      score += looksNumeric(value) ? 2 : 0;
    } else if (kind === "name") {
      const candidateName = splitNameAndPosition(value).name;
      if (looksLikePersonName(candidateName)) score += 2;
      else if (value && !YEAR_PATTERN.test(value)) score += 1;
    } else {
      score += 1;
    }
  }
  return score;
}

// ── Cell + name helpers ──────────────────────────────────────────────

function normalizeCellText(value: string): string {
  let n = value.replace(/ /g, " ");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/\(\d+\)/g, "").trim();
  return n;
}

function normalizeHeaderText(value: string): string {
  let n = normalizeCellText(value);
  // BS4-equivalent regex for "Salary  ($)" → "Salary ($)" — collapse
  // wide-column-header spacing that some filers introduce.
  n = n.replace(/(\w)\s+(\(\$|\$)/g, "$1 $2");
  // Re-insert spaces at camelCase joins where bold-styled headers
  // wrapped across visual lines and cheerio's text() collapsed the
  // line break into nothing. Examples:
  //   "FiscalYear"               → "Fiscal Year"
  //   "Name andPrincipal"        → "Name and Principal"
  //   "Non-EquityIncentive"      → "Non-Equity Incentive"
  // We don't touch boundaries that are already valid acronyms by
  // requiring the right-hand character to be uppercase followed by a
  // lowercase letter — so "CEO" or "PSU" pass through untouched.
  n = n.replace(/([a-z])([A-Z][a-z])/g, "$1 $2");
  // Letter-immediately-followed-by-digit ("Jan31" → "Jan 31"). Limited
  // to letters and digits — leaves "1,500,000" alone.
  n = n.replace(/([A-Za-z])(\d)/g, "$1 $2");
  return n;
}

function looksNumeric(value: string): boolean {
  const stripped = value
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/[()]/g, "")
    .trim();
  return stripped !== "" && /^\d+(?:\.\d+)?$/.test(stripped);
}

export function looksLikePersonName(value: string | null): boolean {
  if (!value) return false;
  const stripped = value.replace(/^[\s,;]+|[\s,;]+$/g, "");
  if (!stripped || stripped.toLowerCase() === "total") return false;
  if (TITLE_FRAGMENT_PATTERN.test(stripped)) return false;
  const tokens = stripped.match(/[A-Za-z][A-Za-z.''-]*/g) ?? [];
  return tokens.length >= 2;
}

function mergePositionFragments(values: string[]): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of values) {
    const normalised = value.replace(/\s+/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "");
    if (!normalised || seen.has(normalised)) continue;
    seen.add(normalised);
    parts.push(normalised);
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * Title keywords whose appearance suggests we've crossed from
 * person-name territory into role-title territory. Used both for the
 * line-split heuristic and the camelCase pre-pass.
 */
const TITLE_KEYWORDS =
  "Chair(?:man|person|woman)?|Chief|Executive|Senior|President|Vice|Principal|General\\s+Counsel|Co-?Founder|Founder|Lead|Director|Officer|Former|Acting|Interim|Retired|EVP|SVP|CEO|CFO|COO|CTO|CLO|CMO|CRO|CIO";

/**
 * Pre-pass: in cells where the executive name and title were rendered
 * adjacently with bold-styling and the inline whitespace got stripped
 * (e.g. "Marc BenioffChair of the Board and CEO" or "Amy WeaverFormer
 * President and CFO"), insert a space at the lowercase→title-word
 * boundary so the downstream splitter can find a real `\b` match.
 *
 * Only applied when the right-hand side is one of the known title
 * keywords, so legitimate camelCase names like "McMillon" or
 * "DeRoeck" pass through unchanged.
 */
const NAME_TITLE_BOUNDARY = new RegExp(`([a-z])(${TITLE_KEYWORDS})`);

export function splitNameAndPosition(
  value: string,
): { name: string; position: string | null } {
  const lines: string[] = value
    .replace(/ \| /g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, ""))
    // Insert a space at the name/title camelCase boundary so
    // wrapped-and-collapsed cells split cleanly downstream.
    .map((l) => l.replace(NAME_TITLE_BOUNDARY, "$1 $2"))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { name: "", position: null };
  if (lines.length > 1) {
    return {
      name: lines[0],
      position: lines.slice(1).join(" ").trim() || null,
    };
  }
  const flat = lines[0];
  const titleRe = new RegExp(`\\b(?:${TITLE_KEYWORDS})\\b`);
  const match = titleRe.exec(flat);
  if (match && match.index > 4) {
    const name = flat.slice(0, match.index).replace(/^[\s,;]+|[\s,;]+$/g, "");
    const position = flat
      .slice(match.index)
      .replace(/^[\s,;]+|[\s,;]+$/g, "");
    return { name, position: position || null };
  }
  return { name: flat, position: null };
}

function cellValue(row: string[], columnIndex: number | null): string | null {
  if (columnIndex == null || columnIndex >= row.length) return null;
  const value = (row[columnIndex] ?? "").trim();
  if (!value || value === "—" || value === "-" || value === "--" || value === "N/A") {
    return null;
  }
  return value;
}

function scoreRows(rows: ExecutiveCompRow[]): number {
  let score = rows.length;
  if (rows.some((r) => isCeoPosition(r.principal_position))) score += 4;
  if (rows.some((r) => r.salary)) score += 2;
  if (rows.some((r) => r.stock_awards)) score += 2;
  score += new Set(rows.map((r) => r.year)).size;
  return score;
}

function nextTables(
  $: CheerioAPI,
  start: import("domhandler").Element,
  limit: number,
): import("domhandler").Element[] {
  const out: import("domhandler").Element[] = [];
  let cursor: import("domhandler").Node | null = start;
  while (cursor && out.length < limit) {
    cursor = cursor.next ?? cursor.parent?.next ?? null;
    if (!cursor) break;
    if (cursor.type !== "tag") continue;
    const el = cursor as import("domhandler").Element;
    if (el.tagName === "table") out.push(el);
    else {
      $(el)
        .find("table")
        .each((_, t) => {
          if (out.length < limit) out.push(t);
        });
    }
  }
  return out;
}
