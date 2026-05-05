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
    "/api/cron/refresh-pilot": ["./drizzle/**/*"],
  },
};

export default nextConfig;
