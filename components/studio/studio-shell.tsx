"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Clapperboard, Database, Film, Settings2, Shapes, Wallet, WandSparkles } from "lucide-react";
import { TABS } from "@/lib/catalog";
import { money } from "@/lib/format";
import { pendingOf, spendOf } from "@/lib/pricing";
import { useStudio } from "@/stores/use-studio";
import { SlateBadge } from "@/components/slate/badge";
import { SlateSidebar, SlateSidebarDrawer, SlateSidebarTrigger } from "@/components/slate/sidebar";
import { ProjectList } from "@/components/studio/project-list";

const TAB_ICONS: Record<string, typeof Film> = {
  generate: WandSparkles, library: Film, elements: Shapes, settings: Settings2,
};

export function StudioShell({ children }: { children: React.ReactNode }) {
  const params = useParams<{ projectId?: string; tab?: string }>();
  const projects = useStudio((s) => s.projects);
  // Route is the source of truth: prefer the URL project so header/sidebar
  // can never disagree with the views (which render by params). The tab page
  // syncs the store's activeId from the URL for mutations.
  const storeActive = useStudio((s) => s.projects.find((x) => x.id === s.activeId) ?? s.projects[0]);
  const active =
    (params.projectId ? projects.find((x) => x.id === params.projectId) : undefined) ?? storeActive;

  const totalPending = projects.reduce((a, q) => a + pendingOf(q), 0);
  const firstRunning = projects.find((x) => pendingOf(x) > 0);

  if (!active) {
    return (
      <div className="slate-app h-[100dvh] flex flex-col overflow-hidden">
        <header className="h-[52px] shrink-0 border-b slate-hair bg-surface flex items-center gap-2.5 px-3 sm:px-4 lg:px-6">
          <span className="grid place-items-center w-7 h-7 rounded-[9px] bg-[#1C7247] text-white shrink-0">
            <Clapperboard className="size-4" />
          </span>
          <p className="font-display font-bold text-[14.5px]">AI Video Studio</p>
        </header>
        <main className="flex-1 min-h-0 overflow-y-auto grid place-items-center p-6">{children}</main>
      </div>
    );
  }

  return (
    <div className="slate-app h-[100dvh] flex flex-col overflow-hidden">
      <header className="relative z-40 h-[52px] shrink-0 border-b slate-hair bg-surface/90 backdrop-blur-xl flex items-center gap-2.5 px-3 sm:px-4 lg:px-6">
        <SlateSidebarTrigger />
        <span className="grid place-items-center w-7 h-7 rounded-[9px] bg-[#1C7247] dark:bg-[#3FA96D] text-white dark:text-[#0B1A10] shrink-0">
          <Clapperboard className="size-4" />
        </span>
        <p className="font-display font-bold text-[14.5px] truncate min-w-0">{active.name}</p>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <SlateBadge tone="brand" title="Spent in this project">
            <Wallet className="size-3" /> {money(spendOf(active))}
          </SlateBadge>
          {totalPending > 0 && firstRunning && (
            <Link
              href={`/p/${firstRunning.id}/library?status=pending`}
              className="no-underline"
              title="Active renders — jump to project"
            >
              <SlateBadge tone="pending">
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" /> {totalPending} running
              </SlateBadge>
            </Link>
          )}
        </span>
      </header>

      <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden">
        <SlateSidebar>
          <div className="px-3 pt-3 pb-2 shrink-0">
            <p className="px-2 mb-1 text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">Studio</p>
            <div className="flex flex-col gap-0.5">
              {TABS.map((t) => {
                const Icon = TAB_ICONS[t.id] ?? Film;
                const on = params.tab === t.id;
                const count =
                  t.id === "library"
                    ? active.library.length
                    : t.id === "elements"
                      ? Object.values(active.elements).reduce((a, c) => a + c.length, 0)
                      : null;
                return (
                  <Link
                    key={t.id}
                    href={`/p/${active.id}/${t.id}`}
                    className={`relative flex items-center gap-2.5 h-10 pl-3 pr-2 rounded-[10px] text-[13.5px] font-semibold w-full text-left no-underline ${
                      on ? "bg-[var(--t-brand-bg)] text-[var(--t-brand-fg)]" : "text-fg2 hover:bg-surface2"
                    }`}
                  >
                    {on && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-[#2A8F58]" />}
                    <Icon className="size-[17px] shrink-0" />
                    <span className="flex-1 truncate">{t.label}</span>
                    {count != null && (
                      <span className={`text-[10.5px] font-mono px-1.5 h-[18px] leading-[18px] rounded-full ${on ? "bg-surface" : "bg-surface2"} text-muted`}>
                        {count}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="mt-1 flex-1 min-h-0 overflow-y-auto border-t slate-hair">
            <div className="px-3 pt-2.5">
              <div className="flex items-center px-2 mb-1.5">
                <p className="text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
                  Projects · {projects.length}
                </p>
              </div>
              <ProjectList compact />
            </div>
          </div>
          <div className="p-3 pt-2 shrink-0 border-t slate-hair">
            <SpendCard
              spend={money(spendOf(active))}
              videos={active.library.length}
              delivered={active.library.filter((v) => v.status === "success").length}
            />
          </div>
        </SlateSidebar>

        <main className="flex-1 min-w-0 min-h-0 overflow-y-auto overflow-x-hidden px-3 sm:px-5 lg:px-8 py-5">
          {children}
        </main>
      </div>

      <SlateSidebarDrawer
        title="Projects"
        footer={
          <SpendCard
            spend={money(spendOf(active))}
            videos={active.library.length}
            delivered={active.library.filter((v) => v.status === "success").length}
          />
        }
      >
        <div className="flex items-center px-2 mb-1.5">
          <p className="text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">
            Projects · {projects.length}
          </p>
        </div>
        <ProjectList compact />
      </SlateSidebarDrawer>

      <footer className="shrink-0 h-9 border-t slate-hair bg-surface/90 hidden sm:flex items-center gap-4 px-4 lg:px-6 text-[11.5px] text-muted overflow-hidden whitespace-nowrap">
        <span className="hidden lg:flex items-center gap-1.5">
          <Database className="size-3.5" />
          <span className="font-mono">{active.settings.bucket ? `gs://${active.settings.bucket}` : "no bucket"}</span>
        </span>
        <span className="ml-auto hidden md:flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2A8F58]" /> us-central1 · 50 RPM / model
        </span>
      </footer>

      <nav
        className="lg:hidden shrink-0 border-t slate-hair bg-surface/95 flex overflow-x-auto no-scrollbar"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {TABS.map((t) => {
          const Icon = TAB_ICONS[t.id] ?? Film;
          const on = params.tab === t.id;
          return (
            <Link
              key={t.id}
              href={`/p/${active.id}/${t.id}`}
              className={`flex-1 flex flex-col items-center justify-center gap-1 min-h-[56px] px-2 text-[10.5px] font-semibold no-underline ${
                on ? "text-[#1C7247] dark:text-[#6FC191]" : "text-fg2"
              }`}
            >
              <Icon className="size-[19px]" /> {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function SpendCard({ spend, videos, delivered }: { spend: string; videos: number; delivered: number }) {
  return (
    <div className="rounded-[12px] border slate-hair p-3.5 slate-spend-card">
      <p className="text-[10.5px] font-bold uppercase tracking-[.1em] text-muted">Project spend</p>
      <p className="font-display font-bold text-[24px] mt-0.5 leading-none tabular-nums">{spend}</p>
      <p className="text-[11px] text-muted mt-1.5 font-mono tabular-nums">
        {videos} videos · {delivered} delivered
      </p>
    </div>
  );
}
