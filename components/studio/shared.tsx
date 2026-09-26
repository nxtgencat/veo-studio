"use client";

import {
  CircleCheck, CircleX, Columns2, Film, Image, Layers,
  Loader2, StretchHorizontal, Type, type LucideIcon,
} from "lucide-react";
import { SlateBadge } from "@/components/slate/badge";
import { SlateTooltip } from "@/components/slate/tooltip";
import { fmtCountdown, fmtElapsed, money } from "@/lib/format";
import type { VideoItem } from "@/lib/schemas";

export const MODE_ICONS: Record<string, LucideIcon> = {
  type: Type, image: Image, "columns-2": Columns2, layers: Layers, "stretch-horizontal": StretchHorizontal, film: Film,
};

export function ModeIcon({ name, className }: { name: string; className?: string }) {
  const C = MODE_ICONS[name] ?? Film;
  return <C className={className ?? "size-4"} />;
}

const MODE_LABEL: Record<string, [string, string]> = {
  t2v: ["Text to Video", "type"],
  i2v: ["Image to Video", "image"],
  frames: ["Frames to Video", "columns-2"],
  r2v: ["Reference to Video", "layers"],
  extend: ["Extend", "stretch-horizontal"],
};

export function StatusBadge({ status }: { status: string }) {
  if (status === "success")
    return (
      <SlateBadge tone="ok">
        <CircleCheck className="size-3" /> Success
      </SlateBadge>
    );
  if (status === "failed")
    return (
      <SlateBadge tone="danger">
        <CircleX className="size-3" /> Failed
      </SlateBadge>
    );
  return (
    <SlateBadge tone="pending">
      <Loader2 className="size-3" /> Pending
    </SlateBadge>
  );
}

export function ModeBadge({ mode }: { mode: string }) {
  const [label, icon] = MODE_LABEL[mode] ?? [mode, "film"];
  return (
    <SlateBadge tone="info">
      <ModeIcon name={icon} className="size-3" /> {label}
    </SlateBadge>
  );
}

/** Pending-job progress line: lead · countdown · elapsed, with ETA-source tip. */
export function VideoProgress({ v, lead, trail = " elapsed", className }: {
  v: VideoItem; lead?: React.ReactNode; trail?: string; className?: string;
}) {
  return (
    <SlateTooltip tip={v.etaSource === "measured" ? "Based on your past renders" : "Typical time for this tier"}>
      <p className={`font-mono ${className ?? "text-[11.5px] text-muted mt-1.5"}`}>
        {lead ?? `${v.progress || 5}%`} · {fmtCountdown(v.etaMs, v.elapsedMs)} · {fmtElapsed(v.elapsedMs ?? 0)}{trail}
      </p>
    </SlateTooltip>
  );
}

/** Cost with pending estimate + failed strikethrough + explanatory tip. */
export function VideoCost({ v, className }: { v: VideoItem; className?: string }) {
  return (
    <SlateTooltip tip={v.status === "pending" ? "Expected cost — debited on success" : v.status === "failed" ? "Would-be cost — not billed" : undefined}>
      <span className={className ?? "font-mono text-[12px] text-fg2"}>
        {v.status === "failed" ? <s>{money(v.cost)}</s> : `${money(v.cost)}${v.status === "pending" ? " est." : ""}`}
      </span>
    </SlateTooltip>
  );
}
