import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cheerio + parse5 are pulled in by the deterministic extractors and
  // are not safe in the Edge runtime. Default the relevant routes to
  // Node where required (we'll enforce per-route via `runtime = "nodejs"`).
  //
  // Drizzle migration journal must be in the function bundle so the
  // /api/admin/migrate route can apply schema migrations at runtime.
  // Same for the .fixtures tree, which the read paths fall back to in
  // fixture mode.
  outputFileTracingIncludes: {
    "/api/admin/migrate": ["./drizzle/**/*"],
    "/api/admin/seed-from-fixtures": [
      "./.fixtures/by-filing/**/company.json",
      "./.fixtures/by-filing/**/filing.json",
      "./.fixtures/by-filing/**/sections.json",
      "./.fixtures/by-filing/**/policy_facts.json",
      "./.fixtures/by-filing/**/metric_facts.json",
      "./.fixtures/by-filing/**/peer_groups.json",
      "./.fixtures/by-filing/**/executive_comp.json",
    ],
    "/api/cron/refresh-pilot": [
      "./drizzle/**/*",
      "./.fixtures/ticker_map.json",
    ],
  },
};

export default nextConfig;
