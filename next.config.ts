import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cheerio + parse5 are pulled in by the deterministic extractors and
  // are not safe in the Edge runtime. Default the relevant routes to
  // Node where required (we'll enforce per-route via `runtime = "nodejs"`).
};

export default nextConfig;
