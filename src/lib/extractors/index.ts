/**
 * Extractor entry points (stubs through Phase 1).
 *
 * Phase 4 fills these in, ported from /srv/projects/ProxyMiner/apps/api/app/services
 * and validated against the Phase-0 fixtures via src/lib/parity/comparator.ts.
 */
export const EXTRACTOR_VERSIONS = {
  cd_and_a: "cda_extractor.ts.v1",
  executive_comp: "executive_comp_extractor.ts.v1",
  peer_groups: "peer_extractor.ts.v1",
  policy_facts: "fact_extractor.ts.v1",
  metric_facts: "fact_extractor.ts.v1",
} as const;
