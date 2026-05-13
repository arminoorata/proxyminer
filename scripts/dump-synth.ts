import { SYNTHETIC_FIXTURES } from "../src/lib/extractors/__fixtures__/sct-synthetic";
import { extractExecutiveCompensation } from "../src/lib/extractors/executive-comp";

const label = process.argv[2];
const f = SYNTHETIC_FIXTURES.find((x) => x.label === label);
if (!f) {
  console.error("no fixture", label);
  console.log("Available:", SYNTHETIC_FIXTURES.map(x => x.label).join(", "));
  process.exit(1);
}
const rows = extractExecutiveCompensation(f.html);
console.log(`${rows.length} rows from ${label}`);
for (const r of rows) {
  console.log(`  ${r.year} name="${r.executive_name}" pos="${r.principal_position ?? "—"}" total=${r.total ?? "—"} salary=${r.salary ?? "—"}`);
}
