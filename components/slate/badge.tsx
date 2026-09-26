import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { SlateTooltip } from "@/components/slate/tooltip";

const badgeVariants = cva(
  "slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        draft: "slate-badge-draft",
        pending: "slate-badge-pending",
        ok: "slate-badge-ok",
        danger: "slate-badge-danger",
        info: "slate-badge-info",
        brand: "slate-badge-brand",
      },
    },
    defaultVariants: { tone: "draft" },
  },
);

export interface SlateBadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Themed tooltip (never a native title). */
  tip?: React.ReactNode;
}

export function SlateBadge({ className, tone, tip, ...props }: SlateBadgeProps) {
  const badge = <span className={cn(badgeVariants({ tone }), "tabular-nums", className)} {...props} />;
  return tip ? <SlateTooltip tip={tip}>{badge}</SlateTooltip> : badge;
}
export { badgeVariants };
