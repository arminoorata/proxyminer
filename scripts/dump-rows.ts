import { readFileSync } from "node:fs";
import { extractExecutiveCompensation } from "../src/lib/extractors/executive-comp";
const path = process.argv[2];
const rows = extractExecutiveCompensation(readFileSync(path, "utf8"));
for (const r of rows) {
  console.log(`  ${r.year} ${r.executive_name.padEnd(28)} | pos=${(r.principal_position ?? "—").slice(0, 70)} | total=${r.total ?? "—"}`);
}
console.log(`[${rows.length} rows]`);
