"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useStudio } from "@/stores/use-studio";

/** Poll in-flight server jobs while any render is pending. Replaces the old mock renderer. */
export function useRenderTick() {
  const pollJobs = useStudio((s) => s.pollJobs);
  // Raw jobs, not derived projects: boolean stays stable between progress
  // ticks, so this hook never re-subscribes the interval on every poll.
  const hasPending = useStudio((s) =>
    s.jobs.some((j) => j.status === "queued" || j.status === "running"),
  );
  useEffect(() => {
    if (!hasPending) return;
    // pollJobs itself skips hidden tabs + in-flight requests; the
    // visibility listener re-syncs immediately on return instead of waiting
    // out the remainder of the interval.
    const tick = () => {
      if (!document.hidden) void pollJobs();
    };
    const t = setInterval(tick, 3000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [hasPending, pollJobs]);
}

/** Hydrate zustand from localStorage once (client-only, avoids SSR mismatch). */
export function useHydrateStudio() {
  const hydrate = useStudio((s) => s.hydrate);
  const hydrated = useStudio((s) => s.hydrated);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  return hydrated;
}

function parseParams<T extends Record<string, string>>(raw: URLSearchParams, defaults: T): T {
  const out = { ...defaults };
  for (const k of Object.keys(defaults) as (keyof T)[]) {
    const v = raw.get(k as string);
    if (v != null) (out as Record<string, string>)[k as string] = v;
  }
  return out;
}

/**
 * URL query state hook — the single source of truth for filters/dialogs.
 * Keeps deep-linkable URLs (?status=&video=&youtube=&picker=…) without prop drilling.
 *
 * Callers pass inline literals, so `defaults` identity changes every render.
 * The key set is static per call site — pin the first object in state so
 * state/set/clear stay referentially stable instead of invalidating on
 * every render.
 */
export function useQueryState<T extends Record<string, string>>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [defs] = useState(defaults);
  const state = useMemo(() => parseParams(search, defs), [search, defs]);

  const set = useCallback(
    (patch: Partial<T>) => {
      const d = defs as Record<string, string>;
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "" || v === d[k]) next.delete(k);
        else next.set(k, String(v));
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search, defs],
  );

  const clear = useCallback(() => {
    const next = new URLSearchParams(search.toString());
    for (const k of Object.keys(defs)) next.delete(k);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, search, defs]);

  return { state, set, clear };
}
