"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { defaultGen, useComposer, useStudio } from "@/stores/use-studio";
import { buildLibrary, groupElements } from "@/lib/derive";
import type { GenDraft, Project } from "@/lib/schemas";

/** Poll in-flight server jobs while any render is pending. */
export function useRenderTick() {
  const pollTick = useStudio((s) => s.pollTick);
  // Raw jobs, not derived views: boolean stays stable between progress
  // ticks, so this hook never re-subscribes the interval on every poll.
  const hasPending = useStudio((s) =>
    s.jobs.some((j) => j.status === "queued" || j.status === "running"),
  );
  useEffect(() => {
    if (!hasPending) return;
    // pollTick itself skips hidden tabs + in-flight requests; the
    // visibility listener re-syncs immediately on return instead of waiting
    // out the remainder of the interval.
    const tick = () => {
      if (!document.hidden) void pollTick();
    };
    const t = setInterval(tick, 3000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [hasPending, pollTick]);
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

/**
 * Derived library for one project, memoized on raw row refs. Recomputes only
 * when this project's rows (or its youtube overlays) actually change — never
 * on composer keystrokes or other projects' polls.
 */
export function useLibrary(projectId: string): Project["library"] {
  const videos = useStudio((s) => s.videos);
  const jobs = useStudio((s) => s.jobs);
  const elements = useStudio((s) => s.elements);
  const youtube = useComposer((s) => s.youtube);
  return useMemo(
    () => buildLibrary(projectId, videos, jobs, elements, youtube),
    [projectId, videos, jobs, elements, youtube],
  );
}

/** Derived grouped elements for one project, memoized on the raw rows. */
export function useElements(projectId: string): Project["elements"] {
  const elements = useStudio((s) => s.elements);
  return useMemo(() => groupElements(projectId, elements), [projectId, elements]);
}

/** Composer draft for one project. The store holds a ref per project, so the
 *  returned object is stable unless that project's draft is edited. */
export function useGen(projectId: string): GenDraft {
  const draft = useComposer((s) => s.drafts[projectId]);
  return useMemo(() => draft ?? defaultGen(), [draft]);
}

/** Publish prefs for one project: server truth once loaded, local cache
 *  before that (mirrors the old derived Project.settings merge). */
export function usePublishPrefs(projectId: string): { ytClientId: string; ytPrivacy: "private" | "unlisted" | "public"; ytCategory: string } {
  const srv = useStudio((s) => (projectId ? s.settings[projectId] : undefined));
  const loc = useComposer((s) => (projectId ? s.settings[projectId] : undefined));
  return useMemo(
    () => ({
      ytClientId: srv?.ytClientId ?? loc?.ytClientId ?? "",
      ytPrivacy: (srv?.ytPrivacy ?? loc?.ytPrivacy ?? "unlisted") as "private" | "unlisted" | "public",
      ytCategory: srv?.ytCategory ?? loc?.ytCategory ?? "22",
    }),
    [srv, loc],
  );
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
