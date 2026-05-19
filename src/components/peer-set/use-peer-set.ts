"use client";

/**
 * React hook wrapping the pure peer-set helpers with localStorage +
 * cross-tab sync.
 *
 * Implementation note: we use `useSyncExternalStore` instead of
 * useState+useEffect because localStorage is exactly the "external
 * mutable state" the primitive was designed for. This sidesteps the
 * `react-hooks/set-state-in-effect` rule and gives proper SSR
 * suspense behavior — `getServerSnapshot` returns an empty set, then
 * the client hydrates from real storage on mount.
 *
 * Snapshot stability: a fresh `JSON.parse` returns a new object on
 * every read, which would break useSyncExternalStore's referential
 * equality contract. We cache the last parsed snapshot keyed by raw
 * string content; identical raw → same reference.
 */
import { useCallback, useSyncExternalStore } from "react";

import {
  addEntry,
  clearSet,
  emptyPeerSet,
  hasEntry,
  parsePeerSet,
  PEER_SET_STORAGE_KEY,
  removeEntry,
  serializePeerSet,
  type PeerSetEntry,
  type PeerSetState,
} from "@/lib/peer-set/storage";

const EMPTY_SNAPSHOT = emptyPeerSet();
const PEER_SET_EVENT = "proxyminer:peerset:update";

let lastRaw: string | null = "__init__";
let lastSnapshot: PeerSetState = EMPTY_SNAPSHOT;

function getSnapshot(): PeerSetState {
  if (typeof window === "undefined") return EMPTY_SNAPSHOT;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PEER_SET_STORAGE_KEY);
  } catch {
    return EMPTY_SNAPSHOT;
  }
  if (raw === lastRaw) return lastSnapshot;
  lastRaw = raw;
  lastSnapshot = parsePeerSet(raw);
  return lastSnapshot;
}

function getServerSnapshot(): PeerSetState {
  return EMPTY_SNAPSHOT;
}

function subscribe(callback: () => void): () => void {
  // Two signals: cross-tab `storage` events, and a same-tab custom
  // event we dispatch ourselves after a mutation (storage doesn't
  // fire in the tab that wrote it).
  function onStorage(e: StorageEvent) {
    if (e.key === PEER_SET_STORAGE_KEY) callback();
  }
  function onLocal() {
    callback();
  }
  window.addEventListener("storage", onStorage);
  window.addEventListener(PEER_SET_EVENT, onLocal);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(PEER_SET_EVENT, onLocal);
  };
}

function commit(next: PeerSetState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PEER_SET_STORAGE_KEY, serializePeerSet(next));
  } catch {
    // Quota / private mode — silently skip the write. The mutation
    // event still fires so other readers in this tab see the change
    // for the lifetime of the SPA session.
  }
  window.dispatchEvent(new Event(PEER_SET_EVENT));
}

export interface UsePeerSet {
  set: PeerSetState;
  add: (id: string, opts?: { ticker?: string | null; name?: string | null; importable?: boolean }) => void;
  remove: (id: string) => void;
  clear: () => void;
  has: (id: string) => boolean;
  /** True once the hook has hydrated from localStorage. UI should
   * suppress count badges before this to avoid an SSR/CSR mismatch. */
  ready: boolean;
  /** Convenience: latest list of entries. */
  entries: PeerSetEntry[];
}

export function usePeerSet(): UsePeerSet {
  const set = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // `ready` is just "did we run a client snapshot yet". On the server
  // the snapshot is always EMPTY_SNAPSHOT; on the client, after mount,
  // useSyncExternalStore's render uses the live getSnapshot. We can
  // distinguish the two by reference identity.
  const ready = typeof window !== "undefined" && set !== EMPTY_SNAPSHOT
    ? true
    : typeof window !== "undefined";

  const add = useCallback(
    (id: string, opts?: { ticker?: string | null; name?: string | null; importable?: boolean }) => {
      commit(addEntry(getSnapshot(), id, opts));
    },
    [],
  );
  const remove = useCallback((id: string) => {
    commit(removeEntry(getSnapshot(), id));
  }, []);
  const clearAll = useCallback(() => {
    commit(clearSet(getSnapshot()));
  }, []);
  const has = useCallback((id: string) => hasEntry(set, id), [set]);

  return { set, add, remove, clear: clearAll, has, ready, entries: set.entries };
}
