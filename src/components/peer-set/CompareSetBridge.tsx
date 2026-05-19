"use client";

/**
 * Two small client-side helpers that bridge the compare page with the
 * peer-set tray.
 *
 * - `<CompareFromSetHydrator />` reads `?fromSet=1` and, on mount,
 *   navigates to `/compare?companies=<set-ids>` so the analyst can
 *   land on a comparison of whatever's currently in their set without
 *   manually serializing the ids into the URL.
 *
 * - `<AddAllToSetButton companies={[...]} />` appears above the
 *   compare grid. One click adds every currently-displayed company
 *   to the working peer set.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { entriesToCompareCsv } from "@/lib/peer-set/storage";
import { usePeerSet } from "./use-peer-set";

const COMPARE_CAP = 6;

export function CompareFromSetHydrator() {
  const router = useRouter();
  const params = useSearchParams();
  const { set, ready } = usePeerSet();

  useEffect(() => {
    if (!ready) return;
    if (params?.get("fromSet") !== "1") return;
    const ids = entriesToCompareCsv(set, COMPARE_CAP);
    if (!ids) {
      // Empty set + ?fromSet=1 → bounce to the bare compare page so the
      // picker is visible.
      router.replace("/compare");
      return;
    }
    router.replace(`/compare?companies=${ids}`);
  }, [ready, set, params, router]);

  return null;
}

interface CompareCompany {
  id: string;
  name: string;
  ticker: string | null;
}

export function AddAllToSetButton({ companies }: { companies: CompareCompany[] }) {
  const { add, has, ready, set } = usePeerSet();
  if (!ready || companies.length === 0) return null;
  // Filter to companies not already in the set.
  const candidates = companies.filter((c) => !has(c.id));
  const allAlreadyIn = candidates.length === 0;

  function addAll() {
    for (const c of candidates) {
      add(c.id, { ticker: c.ticker, name: c.name });
    }
  }

  return (
    <button
      type="button"
      onClick={addAll}
      disabled={allAlreadyIn}
      title={
        allAlreadyIn
          ? "All displayed companies are already in the peer set"
          : `Add ${candidates.length} displayed compan${candidates.length === 1 ? "y" : "ies"} to the peer set`
      }
      className="rounded-md border px-3 py-1.5 text-[12px] uppercase tracking-[0.16em] hover:border-accent disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: allAlreadyIn ? "var(--line)" : "var(--accent)",
        color: allAlreadyIn ? "var(--muted)" : "var(--accent)",
      }}
    >
      {allAlreadyIn
        ? `In peer set (${set.entries.length})`
        : `+ Add all to peer set${candidates.length > 1 ? ` (${candidates.length})` : ""}`}
    </button>
  );
}
