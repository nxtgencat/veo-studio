import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

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
    VariantProps<typeof badgeVariants> {}

export function SlateBadge({ className, tone, ...props }: SlateBadgeProps) {
  return <span className={cn(badgeVariants({ tone }), "tabular-nums", className)} {...props} />;
}
export { badgeVariants };
