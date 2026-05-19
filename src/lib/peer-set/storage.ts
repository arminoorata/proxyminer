/**
 * Client-side "working peer set" — the analyst's scratchpad while
 * benchmarking companies for a comp committee discussion.
 *
 * Stored in localStorage so it survives page reloads + navigation
 * across the app. No auth, no DB — just one tab's working state.
 * We'll graduate to a server-side model when accounts land.
 *
 * Storage format is versioned so a future shape change can migrate
 * cleanly. Anything unparseable is treated as empty + cleared.
 *
 * Pure helpers (add/remove/normalize/serialize/parse) live here so
 * they're trivially unit-testable; the React hook in `use-peer-set.ts`
 * wraps them with state.
 */

export interface PeerSetEntry {
  /** The lowercase ticker — matches the DB id convention. */
  id: string;
  /** Display ticker (e.g. "AAPL", "BRK-A"). */
  ticker: string | null;
  /** Display name (e.g. "Apple Inc."). */
  name: string | null;
  /** Marks the entry as not-yet-in-the-DB so the UI can offer an
   *  import affordance. Updated to false after a successful ingest. */
  importable: boolean;
  /** ISO 8601 timestamp. Drives "recently added" ordering. */
  added_at: string;
}

export interface PeerSetState {
  version: 1;
  entries: PeerSetEntry[];
}

export const PEER_SET_STORAGE_KEY = "proxyminer:peerset:v1";
export const PEER_SET_MAX_ENTRIES = 25;

export function emptyPeerSet(): PeerSetState {
  return { version: 1, entries: [] };
}

/** Returns the entry index for an id, or -1. */
export function indexOfEntry(set: PeerSetState, id: string): number {
  const lower = id.toLowerCase();
  return set.entries.findIndex((e) => e.id === lower);
}

export function hasEntry(set: PeerSetState, id: string): boolean {
  return indexOfEntry(set, id) !== -1;
}

interface AddOptions {
  ticker?: string | null;
  name?: string | null;
  importable?: boolean;
}

/** Pure add. If the id is already present, updates display fields but
 * does NOT push the entry to the front (preserves stable order so the
 * tray isn't visually noisy on repeated clicks). Caps at
 * PEER_SET_MAX_ENTRIES — silently drops excess. */
export function addEntry(
  set: PeerSetState,
  id: string,
  opts: AddOptions = {},
): PeerSetState {
  const lower = id.toLowerCase();
  if (!lower) return set;
  const existing = indexOfEntry(set, lower);
  if (existing !== -1) {
    const next = set.entries.slice();
    next[existing] = {
      ...next[existing],
      ticker: opts.ticker ?? next[existing].ticker,
      name: opts.name ?? next[existing].name,
      importable:
        // Once we know it's in the DB, never re-mark it as importable.
        opts.importable === false ? false : next[existing].importable,
    };
    return { ...set, entries: next };
  }
  if (set.entries.length >= PEER_SET_MAX_ENTRIES) return set;
  return {
    ...set,
    entries: [
      ...set.entries,
      {
        id: lower,
        ticker: opts.ticker ?? null,
        name: opts.name ?? null,
        importable: opts.importable ?? false,
        added_at: new Date().toISOString(),
      },
    ],
  };
}

export function removeEntry(set: PeerSetState, id: string): PeerSetState {
  const lower = id.toLowerCase();
  return {
    ...set,
    entries: set.entries.filter((e) => e.id !== lower),
  };
}

export function clearSet(set: PeerSetState): PeerSetState {
  return { ...set, entries: [] };
}

/** Bulk-mark previously-importable entries as in-DB. Called after an
 * ingest completes so the tray flips from "+" to a checkmark.  */
export function markImported(
  set: PeerSetState,
  importedIds: ReadonlySet<string>,
): PeerSetState {
  if (set.entries.every((e) => !e.importable)) return set;
  return {
    ...set,
    entries: set.entries.map((e) =>
      importedIds.has(e.id) ? { ...e, importable: false } : e,
    ),
  };
}

/** Stable comma-joined ids in insertion order, for URL routing
 * (compare page). Lowercased. */
export function entriesToCompareCsv(set: PeerSetState, max = 6): string {
  return set.entries
    .slice(0, max)
    .map((e) => e.id)
    .join(",");
}

export function entriesToAllIds(set: PeerSetState): string[] {
  return set.entries.map((e) => e.id);
}

/** Parses a raw string from localStorage. Returns an empty set on
 * any error — never throws. */
export function parsePeerSet(raw: string | null | undefined): PeerSetState {
  if (!raw) return emptyPeerSet();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return emptyPeerSet();
    const p = parsed as Partial<PeerSetState>;
    if (p.version !== 1 || !Array.isArray(p.entries)) return emptyPeerSet();
    const entries: PeerSetEntry[] = [];
    for (const e of p.entries) {
      if (!e || typeof e !== "object") continue;
      const rec = e as unknown as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id.toLowerCase() : "";
      if (!id) continue;
      // Dedupe — silently drop any duplicates that snuck in (e.g.
      // from a manual edit). First occurrence wins.
      if (entries.some((x) => x.id === id)) continue;
      entries.push({
        id,
        ticker: typeof rec.ticker === "string" ? rec.ticker : null,
        name: typeof rec.name === "string" ? rec.name : null,
        importable: rec.importable === true,
        added_at:
          typeof rec.added_at === "string"
            ? rec.added_at
            : new Date().toISOString(),
      });
    }
    return {
      version: 1,
      entries: entries.slice(0, PEER_SET_MAX_ENTRIES),
    };
  } catch {
    return emptyPeerSet();
  }
}

export function serializePeerSet(set: PeerSetState): string {
  return JSON.stringify(set);
}
