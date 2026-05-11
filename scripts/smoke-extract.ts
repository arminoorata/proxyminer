import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractProxySections } from "../src/lib/extractors/proxy-sections";

const root = ".fixtures/by-filing";
for (const company of readdirSync(root).sort()) {
  const companyPath = join(root, company);
  let entries: string[] = [];
  try {
    entries = readdirSync(companyPath);
  } catch {
    continue;
  }
  const filings = entries.filter((d) => /^\d/.test(d)).sort();
  for (const filing of filings) {
    const html = readFileSync(join(companyPath, filing, "source.html"), "utf8");
    const results = extractProxySections(html);
    const summary =
      results.map((r) => `${r.section_type}=${r.section.text.length}c`).join(", ") || "(none)";
    const headings = results.map((r) => `${r.section_type}:"${r.section.heading}"`).join(" | ");
    console.log(`${company.padEnd(6)} ${filing.padEnd(20)} ${summary.padEnd(80)} ${headings}`);
  }
}
