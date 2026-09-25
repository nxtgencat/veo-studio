// Slate theme — own reusable primitives following shadcn patterns (cva + cn).
// Do NOT import from @/components/ui. These are the only UI atoms studio code may use.
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { X } from "lucide-react";

const buttonVariants = cva(
  "slate-btn inline-flex items-center justify-center gap-[7px] h-[38px] px-[14px] rounded-[9px] text-[13.5px] font-semibold whitespace-nowrap border border-transparent transition-colors select-none active:translate-y-px disabled:opacity-45 disabled:pointer-events-none [&_svg]:size-[15px] [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "slate-btn-primary",
        ghost: "slate-btn-ghost",
        quiet: "slate-btn-quiet",
        danger: "slate-btn-danger",
      },
      size: {
        md: "",
        sm: "slate-btn-sm !h-[30px] px-[10px] text-[12.5px] rounded-[8px] [&_svg]:size-[14px]",
        icon: "!w-[38px] !px-0 shrink-0",
        "icon-sm": "!h-[30px] !w-[30px] !px-0 shrink-0 [&_svg]:size-3.5",
        "icon-xs": "!h-7 !w-7 !px-0 shrink-0 rounded-[8px] [&_svg]:size-3.5",
        "icon-2xs": "!h-[22px] !w-[22px] !px-0 shrink-0 rounded-full [&_svg]:size-3",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface SlateButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const SlateButton = React.forwardRef<HTMLButtonElement, SlateButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button ref={ref} type={(type as "button" | "submit") ?? "button"} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
SlateButton.displayName = "SlateButton";

/**
 * Square icon-only button — one consistent primitive for every icon action
 * (composer enhance/audio/advanced, dialog close, refresh, row menus).
 * Shadcn parity: button.tsx `icon` / `icon-sm` sizes, ghost hover, active press.
 */
export const SlateIconButton = React.forwardRef<
  HTMLButtonElement,
  Omit<SlateButtonProps, "size" | "children"> & {
    size?: "icon" | "icon-sm" | "icon-xs" | "icon-2xs";
    label: string;
    children: React.ReactNode;
  }
>(({ className, variant = "ghost", size = "icon-sm", label, children, ...props }, ref) => (
  <SlateButton ref={ref} variant={variant} size={size} aria-label={label} title={label} className={className} {...props}>
    {children}
  </SlateButton>
));
SlateIconButton.displayName = "SlateIconButton";

/** Dialog/drawer/modal close — quiet sm, right-aligned by default. */
export function SlateCloseButton({
  onClick,
  className,
  label = "Close",
}: {
  onClick: () => void;
  className?: string;
  label?: string;
}) {
  return (
    <SlateIconButton variant="quiet" size="icon-sm" label={label} onClick={onClick} className={cn("!w-8 ml-auto shrink-0", className)}>
      <X className="size-3.5" />
    </SlateIconButton>
  );
}
export { buttonVariants };
