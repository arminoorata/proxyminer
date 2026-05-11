import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractCdAndA } from "../src/lib/extractors/cd-and-a";
import { extractProxySections } from "../src/lib/extractors/proxy-sections";
import { extractFactsFromSections } from "../src/lib/extractors/facts";

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
    const cda = extractCdAndA(html);
    const proxy = extractProxySections(html);
    const inputs = [
      ...(cda ? [{ section_type: "cd_and_a", text: cda.text }] : []),
      ...proxy.map((p) => ({ section_type: p.section_type, text: p.section.text })),
    ];
    const facts = extractFactsFromSections(filing, inputs);
    const payRatio = facts.metrics.find((m) => m.metric_name_normalized === "ceo_pay_ratio");
    const median = facts.metrics.find((m) => m.metric_name_normalized === "median_employee_compensation");
    const sayOnPay = facts.metrics.find((m) => m.metric_name_normalized === "say_on_pay");
    const committee = facts.policies.find((p) => p.policy_type === "compensation_committee");

    const pr = payRatio
      ? `${payRatio.observed_value} (${payRatio.extraction_method?.split(":")[1] ?? "cda"})`
      : "—";
    const md = median
      ? `${median.observed_value} (${median.extraction_method?.split(":")[1] ?? "cda"})`
      : "—";
    const sp = sayOnPay
      ? `${sayOnPay.observed_value} (${sayOnPay.extraction_method?.split(":")[1] ?? "cda"})`
      : "—";
    const cc = committee
      ? `${committee.normalized_value} (${committee.extraction_method?.split(":")[1] ?? "cda"})`
      : "—";
    console.log(
      `${company.padEnd(6)} ${filing.padEnd(20)} pay=${pr.padEnd(22)} med=${md.padEnd(22)} sop=${sp.padEnd(15)} cc=${cc}`,
    );
  }
}
