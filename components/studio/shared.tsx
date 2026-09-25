"use client";

import {
  Check, CircleCheck, CircleX, Clapperboard, Columns2, Film, Image, Layers,
  Loader2, StretchHorizontal, Type, type LucideIcon,
} from "lucide-react";
import { SlateBadge } from "@/components/slate/badge";

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

export { Check, Clapperboard };
