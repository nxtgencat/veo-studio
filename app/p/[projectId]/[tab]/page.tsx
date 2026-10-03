"use client";

import { Suspense, useEffect } from "react";
import { notFound, useParams, useRouter } from "next/navigation";
import { studioTabSchema } from "@/lib/schemas";
import { useStudio } from "@/stores/use-studio";
import { StudioShell } from "@/components/studio/studio-shell";
import { GenerateView } from "@/components/studio/generate-view";
import { ScriptView } from "@/components/studio/script-view";
import { LibraryView } from "@/components/studio/library-view";
import { ElementsView } from "@/components/studio/elements-view";
import { SettingsView } from "@/components/studio/settings-view";
import { StudioDialogs } from "@/components/studio/dialogs";
import { TabLoadingSkeleton } from "@/components/slate/skeleton";

/**
 * Dynamic route: /p/[projectId]/[tab]
 * - projectId slug selects the project (deep-linkable, shareable)
 * - tab slug selects generate | library | elements | settings
 * - filters & dialogs live in ?query= (see useQueryState) — no prop drilling
 */
export default function ProjectTabPage() {
  const params = useParams<{ projectId: string; tab: string }>();
  const router = useRouter();
  const hydrated = useStudio((s) => s.hydrated);
  // Existence only — never whole rows: the page must not re-render on poll
  // ticks or composer keystrokes. Dialog open/close is a query-only
  // navigation (no store change), so this stays stable and only the view +
  // dialog below do work.
  const projectId = params.projectId;
  const projectExists = useStudio((s) => s.projects.some((p) => p.id === projectId));
  const setActiveId = useStudio((s) => s.setActiveId);
  const ensureProject = useStudio((s) => s.ensureProject);

  const tabParsed = studioTabSchema.safeParse(params.tab);

  useEffect(() => {
    if (!hydrated) return;
    if (projectExists && useStudio.getState().activeId !== projectId) setActiveId(projectId);
    if (projectId) void ensureProject(projectId);
  }, [hydrated, projectExists, setActiveId, ensureProject, projectId]);

  // Navigation must happen in an effect — never during render.
  useEffect(() => {
    if (!hydrated) return;
    if (projectExists) return;
    const fallback = useStudio.getState().projects[0];
    if (!fallback) router.replace("/");
    else router.replace(`/p/${fallback.id}/${params.tab}`);
  }, [hydrated, projectExists, router, params.tab]);

  if (tabParsed.success === false) notFound();
  if (!hydrated) return null;
  if (!projectExists) return null;

  return (
    <StudioShell>
      {/* Explicit boundaries: views + dialogs read useSearchParams (Next requirement)
          and show section skeletons instead of blank while deopting/hydrating. */}
      <Suspense fallback={<TabLoadingSkeleton />}>
        {params.tab === "generate" && <GenerateView />}
        {params.tab === "script" && <ScriptView />}
        {params.tab === "library" && <LibraryView />}
        {params.tab === "elements" && <ElementsView />}
        {params.tab === "settings" && <SettingsView />}
      </Suspense>
      <Suspense fallback={null}>
        <StudioDialogs />
      </Suspense>
    </StudioShell>
  );
}
