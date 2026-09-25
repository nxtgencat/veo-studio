"use client";

import { useCallback, useEffect, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useStudio } from "@/stores/use-studio";

/** Poll in-flight server jobs while any render is pending. Replaces the old mock renderer. */
export function useRenderTick() {
  const pollJobs = useStudio((s) => s.pollJobs);
  const hasPending = useStudio((s) => s.projects.some((q) => q.library.some((v) => v.status === "pending")));
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => void pollJobs(), 3000);
    return () => clearInterval(t);
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
 */
export function useQueryState<T extends Record<string, string>>(defaults: T) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const state = useMemo(() => parseParams(search, defaults), [search, defaults]);

  const set = useCallback(
    (patch: Partial<T>, opts?: { replace?: boolean }) => {
      const next = new URLSearchParams(search.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "" || v === (defaults as Record<string, string>)[k]) next.delete(k);
        else next.set(k, String(v));
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search, defaults],
  );

  const clear = useCallback(
    (keys?: (keyof T)[]) => {
      const next = new URLSearchParams(search.toString());
      if (!keys) {
        for (const k of Object.keys(defaults)) next.delete(k);
      } else {
        for (const k of keys) next.delete(k as string);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search, defaults],
  );

  return { state, set, clear, search };
}
