"use client";

import { Suspense, useEffect } from "react";
import { notFound, useParams, useRouter } from "next/navigation";
import { studioTabSchema } from "@/lib/schemas";
import { useStudio } from "@/stores/use-studio";
import { StudioShell } from "@/components/studio/studio-shell";
import { GenerateView } from "@/components/studio/generate-view";
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
  const projects = useStudio((s) => s.projects);
  const setActiveId = useStudio((s) => s.setActiveId);
  const ensureLoaded = useStudio((s) => s.ensureLoaded);

  const tabParsed = studioTabSchema.safeParse(params.tab);
  const project = projects.find((p) => p.id === params.projectId);

  useEffect(() => {
    if (!hydrated) return;
    if (project && useStudio.getState().activeId !== project.id) setActiveId(project.id);
    if (params.projectId) void ensureLoaded(params.projectId);
  }, [hydrated, project, setActiveId, ensureLoaded, params.projectId]);

  // Navigation must happen in an effect — never during render.
  useEffect(() => {
    if (!hydrated) return;
    if (project) return;
    const fallback = useStudio.getState().projects[0];
    if (!fallback) router.replace("/");
    else router.replace(`/p/${fallback.id}/${params.tab}`);
  }, [hydrated, project, router, params.tab]);

  if (tabParsed.success === false) notFound();
  if (!hydrated) return null;
  if (!project) return null;

  return (
    <StudioShell>
      {/* Explicit boundaries: views + dialogs read useSearchParams (Next requirement)
          and show section skeletons instead of blank while deopting/hydrating. */}
      <Suspense fallback={<TabLoadingSkeleton />}>
        {params.tab === "generate" && <GenerateView />}
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
