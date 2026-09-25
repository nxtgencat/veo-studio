"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { fullTs, money } from "@/lib/format";
import { modelOf } from "@/lib/pricing";
import { useStudio } from "@/stores/use-studio";
import { StudioShell } from "@/components/studio/studio-shell";
import { SlateBadge } from "@/components/slate/badge";
import { ModeBadge, StatusBadge } from "@/components/studio/shared";
import { StudioDialogs } from "@/components/studio/dialogs";

/**
 * Deep link: /p/[projectId]/video/[videoId]
 * Full-page render of a single video (shareable URL). Dialogs still work via ?youtube=.
 */
export default function VideoDeepLinkPage() {
  const params = useParams<{ projectId: string; videoId: string }>();
  const hydrated = useStudio((s) => s.hydrated);
  const project = useStudio((s) => s.projects.find((p) => p.id === params.projectId));
  if (!hydrated) return null;
  if (!project) notFound();
  const v = project.library.find((x) => x.id === params.videoId);
  if (!v) notFound();

  return (
    <StudioShell>
      <Link
        href={`/p/${project.id}/library?video=${v.id}`}
        className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-fg2 hover:text-fg mb-4 no-underline"
      >
        <ArrowLeft className="size-3.5" /> Back to Library
      </Link>
      <div className="slate-card p-4 max-w-[720px]">
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          <ModeBadge mode={v.mode} />
          <StatusBadge status={v.status} />
          <SlateBadge tone="draft">{v.dur}s · {v.res} · {v.aspect}</SlateBadge>
          <span className="ml-auto font-mono text-[12px] text-fg2">{v.status === "success" ? money(v.cost) : "$0.00"}</span>
        </div>
        {v.url ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video className="w-full rounded-[10px] bg-black" controls playsInline poster={v.thumb || ""} src={v.url} />
        ) : v.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={v.thumb} className="w-full rounded-[10px] object-cover" alt="" />
        ) : (
          <div className="w-full rounded-[10px] bg-surface2 aspect-video grid place-items-center text-muted text-[12px]">
            No preview yet
          </div>
        )}
        <p className="mt-3 text-[13.5px] font-semibold leading-relaxed">{v.prompt || "Untitled"}</p>
        <p className="mt-1 text-[11.5px] font-mono text-muted" title={fullTs(v.createdAt)}>
          {modelOf(v.model).label} · {fullTs(v.createdAt)}
        </p>
        <div className="mt-3">
          <Link href={`/p/${project.id}/library?video=${v.id}`} className="slate-btn slate-btn-primary slate-btn-sm no-underline">
            Open details
          </Link>
        </div>
      </div>
      <StudioDialogs />
    </StudioShell>
  );
}
