/**
 * Pure diff utilities for comparing two FilingDetail snapshots from
 * the same company across consecutive proxy filings. Deterministic
 * and side-effect free — every output cell carries enough context to
 * be displayed without the underlying objects.
 *
 * The "from" snapshot is the older filing, "to" is the newer.
 * Convention used everywhere in this module.
 */
import type {
  ExecutiveCompRow,
  FilingDetail,
  MetricFactRow,
  PeerGroupRow,
  PolicyFactRow,
} from "@/lib/types";

// ── Numeric helpers ──────────────────────────────────────────────────

export function magnitude(v: string | null | undefined): number | null {
  if (!v) return null;
  const cleaned = String(v).replaceAll(",", "").replaceAll("$", "").trim();
  // Match leading numeric portion plus an optional billion/million/trillion
  // suffix so observed values like "$416.2 billion" parse to 416.2.
  const m = /^([+-]?\d+(?:\.\d+)?)\s*(billion|million|trillion|%)?\b/i.exec(cleaned);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n;
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return (numerator / denominator) * 100;
}

// ── Peer group diff ──────────────────────────────────────────────────

export interface PeerGroupChange {
  peer_group_name: string;
  peer_group_type: string | null;
  added: { name: string; ticker: string | null }[];
  removed: { name: string; ticker: string | null }[];
  kept: number;
  fromMembers: number;
  toMembers: number;
}

function memberKey(m: { company_id_resolved: string | null; company_name_raw: string }): string {
  return (m.company_id_resolved ?? m.company_name_raw).toLowerCase();
}

function memberDisplay(m: {
  company_name_resolved: string | null;
  company_name_raw: string;
  ticker_resolved: string | null;
}): { name: string; ticker: string | null } {
  return {
    name: m.company_name_resolved ?? m.company_name_raw,
    ticker: m.ticker_resolved,
  };
}

function bestMatch(
  groups: PeerGroupRow[],
  type: string | null,
  name: string | null,
): PeerGroupRow | null {
  // Prefer matching peer_group_type, then peer_group_name fuzzy.
  if (type) {
    const t = groups.find((g) => g.peer_group_type === type);
    if (t) return t;
  }
  if (name) {
    const lower = name.toLowerCase();
    const n = groups.find((g) => (g.peer_group_name ?? "").toLowerCase() === lower);
    if (n) return n;
  }
  return null;
}

export function diffPeerGroups(
  from: PeerGroupRow[],
  to: PeerGroupRow[],
): PeerGroupChange[] {
  const out: PeerGroupChange[] = [];
  const seenFromIds = new Set<number | string>();

  for (const toGroup of to) {
    const fromGroup = bestMatch(from, toGroup.peer_group_type, toGroup.peer_group_name);
    if (fromGroup) seenFromIds.add(fromGroup.id);

    const fromKeys = new Set((fromGroup?.members ?? []).map(memberKey));
    const toKeys = new Set(toGroup.members.map(memberKey));

    const added = toGroup.members.filter((m) => !fromKeys.has(memberKey(m))).map(memberDisplay);
    const removed =
      fromGroup?.members.filter((m) => !toKeys.has(memberKey(m))).map(memberDisplay) ?? [];
    const kept = toGroup.members.filter((m) => fromKeys.has(memberKey(m))).length;

    out.push({
      peer_group_name: toGroup.peer_group_name ?? "Peer group",
      peer_group_type: toGroup.peer_group_type,
      added,
      removed,
      kept,
      fromMembers: fromGroup?.members.length ?? 0,
      toMembers: toGroup.members.length,
    });
  }

  // Groups that only existed in `from`.
  for (const fromGroup of from) {
    if (seenFromIds.has(fromGroup.id)) continue;
    out.push({
      peer_group_name: fromGroup.peer_group_name ?? "Peer group",
      peer_group_type: fromGroup.peer_group_type,
      added: [],
      removed: fromGroup.members.map(memberDisplay),
      kept: 0,
      fromMembers: fromGroup.members.length,
      toMembers: 0,
    });
  }

  return out;
}

// ── Policy + metric diff ─────────────────────────────────────────────

export interface PolicyChange {
  policy_type: string;
  fromValue: string | null;
  toValue: string | null;
  fromExcerpt: string | null;
  toExcerpt: string | null;
  status: "unchanged" | "changed" | "added" | "removed";
}

function policyByType(rows: PolicyFactRow[]): Map<string, PolicyFactRow> {
  return new Map(rows.map((r) => [r.policy_type, r]));
}

export function diffPolicies(from: PolicyFactRow[], to: PolicyFactRow[]): PolicyChange[] {
  const fromMap = policyByType(from);
  const toMap = policyByType(to);
  const types = new Set<string>([...fromMap.keys(), ...toMap.keys()]);
  const result: PolicyChange[] = [];
  for (const type of types) {
    const f = fromMap.get(type) ?? null;
    const t = toMap.get(type) ?? null;
    let status: PolicyChange["status"];
    if (!f && t) status = "added";
    else if (f && !t) status = "removed";
    else if (f && t && (f.normalized_value ?? "") !== (t.normalized_value ?? "")) status = "changed";
    else status = "unchanged";
    result.push({
      policy_type: type,
      fromValue: f?.normalized_value ?? null,
      toValue: t?.normalized_value ?? null,
      fromExcerpt: f?.source_excerpt ?? null,
      toExcerpt: t?.source_excerpt ?? null,
      status,
    });
  }
  // Sort: changed/added/removed first, alphabetical within.
  return result.sort((a, b) => {
    const aMaterial = a.status !== "unchanged";
    const bMaterial = b.status !== "unchanged";
    if (aMaterial !== bMaterial) return aMaterial ? -1 : 1;
    return a.policy_type.localeCompare(b.policy_type);
  });
}

export interface MetricChange {
  metric_name_normalized: string;
  metric_name_raw: string | null;
  fromValue: string | null;
  toValue: string | null;
  fromExcerpt: string | null;
  toExcerpt: string | null;
  numericDelta: number | null;
  status: "unchanged" | "changed" | "added" | "removed";
}

function metricByKey(rows: MetricFactRow[]): Map<string, MetricFactRow> {
  return new Map(
    rows.map((r) => [r.metric_name_normalized ?? r.metric_name_raw, r]),
  );
}

function valueDelta(fromValue: string | null, toValue: string | null): number | null {
  if (!fromValue || !toValue) return null;
  const f = magnitude(fromValue);
  const t = magnitude(toValue);
  if (f === null || t === null) return null;
  return t - f;
}

export function diffMetrics(from: MetricFactRow[], to: MetricFactRow[]): MetricChange[] {
  const fromMap = metricByKey(from);
  const toMap = metricByKey(to);
  const keys = new Set<string>([...fromMap.keys(), ...toMap.keys()]);
  const result: MetricChange[] = [];
  for (const key of keys) {
    const f = fromMap.get(key) ?? null;
    const t = toMap.get(key) ?? null;
    let status: MetricChange["status"];
    if (!f && t) status = "added";
    else if (f && !t) status = "removed";
    else if (f && t && (f.observed_value ?? "") !== (t.observed_value ?? "")) status = "changed";
    else status = "unchanged";
    result.push({
      metric_name_normalized: key,
      metric_name_raw: t?.metric_name_raw ?? f?.metric_name_raw ?? null,
      fromValue: f?.observed_value ?? null,
      toValue: t?.observed_value ?? null,
      fromExcerpt: f?.source_excerpt ?? null,
      toExcerpt: t?.source_excerpt ?? null,
      numericDelta: valueDelta(f?.observed_value ?? null, t?.observed_value ?? null),
      status,
    });
  }
  return result.sort((a, b) => {
    const aMaterial = a.status !== "unchanged";
    const bMaterial = b.status !== "unchanged";
    if (aMaterial !== bMaterial) return aMaterial ? -1 : 1;
    return a.metric_name_normalized.localeCompare(b.metric_name_normalized);
  });
}

// ── Executive compensation diff (NEO-level) ──────────────────────────

export interface ExecChange {
  executive_name: string;
  principal_position: string | null;
  fromYear: number | null;
  toYear: number | null;
  fromTotal: number | null;
  toTotal: number | null;
  totalDelta: number | null;
  totalDeltaPct: number | null;
  fromMix: PayMixSnapshot | null;
  toMix: PayMixSnapshot | null;
  isCEO: boolean;
  status: "unchanged" | "changed" | "added" | "removed";
}

export interface PayMixSnapshot {
  base: number;
  bonus: number;
  equity: number;
  other: number;
  total: number;
  basePct: number;
  bonusPct: number;
  equityPct: number;
  otherPct: number;
  atRiskPct: number;
}

function isCeo(row: ExecutiveCompRow): boolean {
  return (row.principal_position ?? "").toLowerCase().includes("chief executive officer");
}

function payMixSnapshot(row: ExecutiveCompRow): PayMixSnapshot | null {
  const base = magnitude(row.salary) ?? 0;
  const bonus =
    (magnitude(row.bonus) ?? 0) +
    (magnitude(row.non_equity_incentive_plan_compensation) ?? 0);
  const equity = (magnitude(row.stock_awards) ?? 0) + (magnitude(row.option_awards) ?? 0);
  const other = magnitude(row.all_other_compensation) ?? 0;
  const total = base + bonus + equity + other;
  if (total <= 0) return null;
  return {
    base,
    bonus,
    equity,
    other,
    total,
    basePct: pct(base, total),
    bonusPct: pct(bonus, total),
    equityPct: pct(equity, total),
    otherPct: pct(other, total),
    atRiskPct: pct(bonus + equity, total),
  };
}

function latestRow(rows: ExecutiveCompRow[], execName: string): ExecutiveCompRow | null {
  const named = rows.filter((r) => r.executive_name.trim().toLowerCase() === execName.trim().toLowerCase());
  if (named.length === 0) return null;
  return named.reduce((latest, cur) => (cur.year > latest.year ? cur : latest));
}

export function diffExecutives(
  from: ExecutiveCompRow[],
  to: ExecutiveCompRow[],
): ExecChange[] {
  // Collect the union of unique executive names (case-insensitive) and
  // pick the latest reported year for each in the respective filing.
  const fromNames = new Set(from.map((r) => r.executive_name.trim().toLowerCase()));
  const toNames = new Set(to.map((r) => r.executive_name.trim().toLowerCase()));
  const all = new Set<string>([...fromNames, ...toNames]);

  const result: ExecChange[] = [];

  for (const lower of all) {
    const fromRow = from.find((r) => r.executive_name.trim().toLowerCase() === lower) ?? null;
    const toRow = to.find((r) => r.executive_name.trim().toLowerCase() === lower) ?? null;
    const fLatest = fromRow ? latestRow(from, fromRow.executive_name) : null;
    const tLatest = toRow ? latestRow(to, toRow.executive_name) : null;

    const fromTotal = fLatest ? magnitude(fLatest.total) : null;
    const toTotal = tLatest ? magnitude(tLatest.total) : null;
    const delta = fromTotal !== null && toTotal !== null ? toTotal - fromTotal : null;
    const deltaPct =
      fromTotal !== null && fromTotal !== 0 && delta !== null ? (delta / fromTotal) * 100 : null;

    const display = (tLatest ?? fLatest)?.executive_name ?? lower;
    const position = (tLatest ?? fLatest)?.principal_position ?? null;

    let status: ExecChange["status"];
    if (!fromNames.has(lower) && toNames.has(lower)) status = "added";
    else if (fromNames.has(lower) && !toNames.has(lower)) status = "removed";
    else if (delta !== null && delta !== 0) status = "changed";
    else status = "unchanged";

    result.push({
      executive_name: display,
      principal_position: position,
      fromYear: fLatest?.year ?? null,
      toYear: tLatest?.year ?? null,
      fromTotal,
      toTotal,
      totalDelta: delta,
      totalDeltaPct: deltaPct,
      fromMix: fLatest ? payMixSnapshot(fLatest) : null,
      toMix: tLatest ? payMixSnapshot(tLatest) : null,
      isCEO: tLatest ? isCeo(tLatest) : fLatest ? isCeo(fLatest) : false,
      status,
    });
  }

  // Sort: CEO first, then by largest absolute total delta, then by name.
  return result.sort((a, b) => {
    if (a.isCEO !== b.isCEO) return a.isCEO ? -1 : 1;
    const ad = Math.abs(a.totalDelta ?? 0);
    const bd = Math.abs(b.totalDelta ?? 0);
    if (ad !== bd) return bd - ad;
    return a.executive_name.localeCompare(b.executive_name);
  });
}

// ── Top-level diff summary ───────────────────────────────────────────

export interface DiffSummary {
  peerAdded: number;
  peerRemoved: number;
  policiesChanged: number;
  policiesAdded: number;
  policiesRemoved: number;
  metricsChanged: number;
  metricsAdded: number;
  metricsRemoved: number;
  ceoTotalDelta: number | null;
  ceoTotalDeltaPct: number | null;
  newNeos: number;
  departedNeos: number;
}

export function summarizeDiff(opts: {
  peerChanges: PeerGroupChange[];
  policyChanges: PolicyChange[];
  metricChanges: MetricChange[];
  execChanges: ExecChange[];
}): DiffSummary {
  const peerAdded = opts.peerChanges.reduce((acc, p) => acc + p.added.length, 0);
  const peerRemoved = opts.peerChanges.reduce((acc, p) => acc + p.removed.length, 0);
  const policiesChanged = opts.policyChanges.filter((p) => p.status === "changed").length;
  const policiesAdded = opts.policyChanges.filter((p) => p.status === "added").length;
  const policiesRemoved = opts.policyChanges.filter((p) => p.status === "removed").length;
  const metricsChanged = opts.metricChanges.filter((m) => m.status === "changed").length;
  const metricsAdded = opts.metricChanges.filter((m) => m.status === "added").length;
  const metricsRemoved = opts.metricChanges.filter((m) => m.status === "removed").length;
  const ceo = opts.execChanges.find((e) => e.isCEO) ?? null;
  const newNeos = opts.execChanges.filter((e) => e.status === "added").length;
  const departedNeos = opts.execChanges.filter((e) => e.status === "removed").length;
  return {
    peerAdded,
    peerRemoved,
    policiesChanged,
    policiesAdded,
    policiesRemoved,
    metricsChanged,
    metricsAdded,
    metricsRemoved,
    ceoTotalDelta: ceo?.totalDelta ?? null,
    ceoTotalDeltaPct: ceo?.totalDeltaPct ?? null,
    newNeos,
    departedNeos,
  };
}

// ── CD&A section text diff ───────────────────────────────────────────

export interface SectionDiff {
  section_type: string;
  fromLength: number;
  toLength: number;
  similarityPct: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingleSet(words: string[], n: number): Set<string> {
  // Word-level shingles to compare CD&A text similarity coarsely.
  // Intent: "how much did the prose move," not "exactly which lines."
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) {
    out.add(words.slice(i, i + n).join(" "));
  }
  return out;
}

export function sectionSimilarity(a: string, b: string): number {
  const aWords = tokenize(a);
  const bWords = tokenize(b);
  if (aWords.length === 0 && bWords.length === 0) return 100;
  if (aWords.length === 0 || bWords.length === 0) return 0;

  // Adaptive shingle size: long CD&A text uses 8-grams; short test
  // input or excerpts fall back to bigrams or unigrams so the function
  // stays meaningful at any length.
  const minLen = Math.min(aWords.length, bWords.length);
  const n = minLen >= 16 ? 8 : minLen >= 6 ? 3 : 1;
  const aSh = shingleSet(aWords, n);
  const bSh = shingleSet(bWords, n);
  if (aSh.size === 0 || bSh.size === 0) return 0;
  let intersect = 0;
  for (const s of aSh) if (bSh.has(s)) intersect++;
  const union = aSh.size + bSh.size - intersect;
  return Math.round((intersect / union) * 100);
}

export function diffSections(from: FilingDetail, to: FilingDetail): SectionDiff[] {
  const out: SectionDiff[] = [];
  const types = new Set<string>([
    ...from.sections.map((s) => s.section_type),
    ...to.sections.map((s) => s.section_type),
  ]);
  for (const type of types) {
    const f = from.sections.find((s) => s.section_type === type);
    const t = to.sections.find((s) => s.section_type === type);
    out.push({
      section_type: type,
      fromLength: (f?.text ?? "").length,
      toLength: (t?.text ?? "").length,
      similarityPct: sectionSimilarity(f?.text ?? "", t?.text ?? ""),
    });
  }
  return out.sort((a, b) => a.section_type.localeCompare(b.section_type));
}
