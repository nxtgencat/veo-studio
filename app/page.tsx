"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard, Plus } from "lucide-react";
import { useHydrateStudio } from "@/hooks/use-studio-hooks";
import { useStudio } from "@/stores/use-studio";
import { SlateButton } from "@/components/slate/button";
import { SlateEmpty } from "@/components/slate/core";

/** Root: deep-link into the last/active project, or offer a fresh start. */
export default function Home() {
  const router = useRouter();
  const hydrated = useHydrateStudio();
  const projects = useStudio((s) => s.projects);
  const activeId = useStudio((s) => s.activeId);
  const createProject = useStudio((s) => s.createProject);

  useEffect(() => {
    if (!hydrated) return;
    const target = projects.find((p) => p.id === activeId) ?? projects[0];
    if (target) router.replace(`/p/${target.id}/generate`);
  }, [hydrated, projects, activeId, router]);

  if (!hydrated) return null;
  if (projects.length > 0) return null;

  return (
    <div className="slate-app h-[100dvh] flex flex-col overflow-hidden">
      <header className="h-[52px] shrink-0 border-b slate-hair bg-surface flex items-center gap-2.5 px-4">
        <span className="grid place-items-center w-7 h-7 rounded-[9px] bg-[#1C7247] text-white shrink-0">
          <Clapperboard className="size-4" />
        </span>
        <p className="font-display font-bold text-[14.5px]">AI Video Studio</p>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto grid place-items-center p-6">
        <div className="w-full max-w-[480px]">
          <SlateEmpty
            icon={<Clapperboard className="size-6 text-[#1C7247]" />}
            title="No projects yet"
            sub="Fresh canvas — create a project to start generating."
            action={
              <SlateButton
                variant="primary"
                onClick={() => {
                  const id = createProject("Untitled project");
                  router.push(`/p/${id}/generate`);
                }}
              >
                <Plus className="size-4" /> Create project
              </SlateButton>
            }
          />
        </div>
      </main>
    </div>
  );
}
