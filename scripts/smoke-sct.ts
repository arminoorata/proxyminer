import { readFileSync, existsSync } from "node:fs";
import { extractExecutiveCompensation } from "../src/lib/extractors/executive-comp";
import { isCeoPosition } from "../src/lib/exec/ceo";

const cases: { label: string; path: string }[] = [
  // Pilot cohort — frozen fixtures
  { label: "aapl 2026",  path: ".fixtures/by-filing/aapl/000130817926000008/source.html" },
  { label: "msft 2025",  path: ".fixtures/by-filing/msft/000119312525245150/source.html" },
  { label: "googl 2025", path: ".fixtures/by-filing/googl/000130817925000511/source.html" },
  { label: "meta 2025",  path: ".fixtures/by-filing/meta/000132680125000040/source.html" },
  { label: "amzn 2025",  path: ".fixtures/by-filing/amzn/000110465925033442/source.html" },
  { label: "nvda 2025",  path: ".fixtures/by-filing/nvda/000104581025000095/source.html" },
  { label: "orcl 2025",  path: ".fixtures/by-filing/orcl/000119312525220801/source.html" },
  { label: "crm 2025",   path: ".fixtures/by-filing/crm/000110852425000009/source.html" },
  { label: "nflx 2025",  path: ".fixtures/by-filing/nflx/000119312525084425/source.html" },
  { label: "qcom 2026",  path: ".fixtures/by-filing/qcom/000110465926005781/source.html" },
  { label: "adbe 2026",  path: ".fixtures/by-filing/adbe/000079634326000043/source.html" },
  { label: "avgo 2026",  path: ".fixtures/by-filing/avgo/000119312526085691/source.html" },
  // Long-tail — fetched locally
  { label: "ayi local",  path: "/tmp/ayi.html" },
  { label: "wmt local",  path: "/tmp/wmt.html" },
  { label: "key local",  path: "/tmp/key.html" },
];

for (const c of cases) {
  if (!existsSync(c.path)) { console.log(`SKIP ${c.label} (no file)`); continue; }
  const html = readFileSync(c.path, "utf8");
  const rows = extractExecutiveCompensation(html);
  if (rows.length === 0) { console.log(`${c.label.padEnd(12)}  0 rows`); continue; }
  const latestYear = Math.max(...rows.map((r) => r.year));
  const ceo = rows.find((r) => r.year === latestYear && isCeoPosition(r.principal_position));
  const allYears = [...new Set(rows.map((r) => r.year))].sort();
  const allCeoPositions = [...new Set(rows.map((r) => r.principal_position ?? ""))].slice(0, 3);
  console.log(
    `${c.label.padEnd(12)}  ${rows.length} rows / years=${allYears.join(",")}  ` +
    `CEO@${latestYear}=${ceo ? ceo.total ?? "—" : "NOT-FOUND"}  ` +
    `(name=${ceo?.executive_name ?? "—"} pos=${ceo?.principal_position ?? "—"})`
  );
}
