/**
 * Diagnose why the SCT extractor misses CEO total for a given filing.
 * Prints which heading-led tables it found, the matrix for each, and
 * the column mapping it inferred. Useful when iterating on parser
 * improvements.
 *
 *   npx tsx scripts/diag-sct.ts <path-to-source.html>
 */
import { readFileSync } from "node:fs";
import * as cheerio from "cheerio";
import { extractExecutiveCompensation } from "../src/lib/extractors/executive-comp";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx scripts/diag-sct.ts <source.html>");
  process.exit(2);
}
const html = readFileSync(file, "utf8");
const rows = extractExecutiveCompensation(html);
console.log("=== final rows ===");
for (const r of rows) {
  const who = `${r.executive_name} (${r.principal_position ?? "—"})`;
  console.log(`  ${r.year} ${who} total=${r.total ?? "—"} salary=${r.salary ?? "—"}`);
}
console.log(`\n[${rows.length} rows]`);

console.log("\n=== heading-led tables (raw) ===");
const $ = cheerio.load(html);
const sumPattern = /\bsummary compensation table\b/i;
let n = 0;
$("*").contents().each((_, node) => {
  if (n >= 8) return;
  if (node.type !== "text") return;
  const t = node.data ?? "";
  if (!sumPattern.test(t)) return;
  const parent = node.parent;
  if (!parent || parent.type !== "tag") return;
  // walk forward
  let cursor: import("domhandler").Node | null = parent;
  let tableFound = 0;
  while (cursor && tableFound < 2) {
    cursor = cursor.next ?? cursor.parent?.next ?? null;
    if (!cursor) break;
    if (cursor.type !== "tag") continue;
    const el = cursor as import("domhandler").Element;
    let tables: import("domhandler").Element[] = [];
    if (el.tagName === "table") tables = [el];
    else tables = $(el).find("table").toArray() as import("domhandler").Element[];
    for (const table of tables) {
      if (tableFound >= 2) break;
      n += 1;
      tableFound += 1;
      const matrix: string[][] = [];
      $(table).find("tr").each((_, tr) => {
        const row: string[] = [];
        for (const c of (tr as import("domhandler").Element).children ?? []) {
          if (c.type !== "tag") continue;
          if (c.tagName !== "th" && c.tagName !== "td") continue;
          row.push($(c).text().replace(/ /g, " ").replace(/\s+/g, " ").trim());
        }
        if (row.length) matrix.push(row);
      });
      console.log(`\n--- table #${n} (heading: "${t.trim().slice(0, 80)}") ---`);
      for (let i = 0; i < Math.min(matrix.length, 10); i++) {
        console.log(`  [${i}] ${matrix[i].slice(0, 10).map((v) => v.slice(0, 30)).join(" │ ")}`);
      }
      if (matrix.length > 10) console.log(`  … ${matrix.length - 10} more rows`);
    }
  }
});
