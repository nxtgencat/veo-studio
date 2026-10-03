"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { fullTs, money } from "@/lib/format";
import { modelOf } from "@/lib/pricing";
import { authedMediaUrl } from "@/lib/api";
import { useStudio } from "@/stores/use-studio";
import { StudioShell } from "@/components/studio/studio-shell";
import { StudioDialogs } from "@/components/studio/dialogs";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton } from "@/components/slate/button";
import { ModeBadge, StatusBadge } from "@/components/studio/shared";
import { useLibrary } from "@/hooks/use-studio-hooks";

/** Deep-link/shareable full-page render of a single library video. */
export default function VideoDeepLinkPage() {
  const params = useParams<{ projectId: string; videoId: string }>();
  const hydrated = useStudio((s) => s.hydrated);
  const projectName = useStudio((s) => s.projects.find((p) => p.id === params.projectId)?.name);
  const lib = useLibrary(params.projectId);
  if (!hydrated) return null;
  if (projectName == null) notFound();
  const v = lib.find((x) => x.id === params.videoId);
  if (!v) notFound();

  return (
    <StudioShell>
      <div className="max-w-[720px]">
        <Link href={`/p/${params.projectId}/library?video=${v.id}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-fg2 hover:text-fg no-underline mb-4">
          <ArrowLeft className="size-3.5" /> Back to Library
        </Link>
        <div className="slate-card p-4">
          <div className="flex items-center gap-1.5 flex-wrap">
            <ModeBadge mode={v.mode} />
            <StatusBadge status={v.status} />
            <SlateBadge tone="draft">{v.dur}s · {v.res} · {v.aspect}</SlateBadge>
            <span className="ml-auto text-[12px] font-mono text-fg2">
              {v.status === "failed" ? <s>{money(v.cost)}</s> : `${money(v.cost)}${v.status === "pending" ? " est." : ""}`}
            </span>
          </div>
          <div className="mt-3">
            {v.url ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <video className="w-full rounded-[10px] bg-black" controls playsInline poster={v.thumb || ""} src={authedMediaUrl(v.url)} />
            ) : v.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={v.thumb} className="w-full rounded-[10px] object-cover" alt="" />
            ) : (
              <div className="aspect-video grid place-items-center text-muted text-[12px]">No preview yet</div>
            )}
          </div>
          <p className="text-[13.5px] font-semibold mt-3">{v.prompt || "Untitled"}</p>
          <p className="text-[11.5px] font-mono text-muted mt-1" title={fullTs(v.createdAt)}>
            {modelOf(v.model).label} · {fullTs(v.createdAt)}
          </p>
          <div className="mt-3">
            <Link href={`/p/${params.projectId}/library?video=${v.id}`} className="no-underline">
              <SlateButton variant="primary" size="sm">Open details</SlateButton>
            </Link>
          </div>
        </div>
      </div>
      <StudioDialogs />
    </StudioShell>
  );
}
