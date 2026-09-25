"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { cn } from "cn";
import {
  Check, Loader2, MonitorPlay, Plus, Sparkles, Trash2, TriangleAlert, Upload, X,
} from "lucide-react";
import { slateToastManager, type ToastTone } from "@/stores/use-ui";

const toneBg: Record<ToastTone, string> = {
  ok: "slate-badge-ok",
  danger: "slate-badge-danger",
  info: "slate-badge-info",
  pending: "slate-badge-pending",
  draft: "slate-badge-draft",
  brand: "slate-badge-brand",
};

/** Status glyph — lucide icons like shadcn's ToastIcon, not text/emoji. */
function ToastGlyph({ icon, tone }: { icon?: string; tone: ToastTone }) {
  if (tone === "pending") return <Loader2 className="size-4 animate-spin" aria-hidden="true" />;
  switch (icon) {
    case "check":
    case "✓":
      return <Check className="size-4" aria-hidden="true" />;
    case "plus":
      return <Plus className="size-4" aria-hidden="true" />;
    case "trash":
      return <Trash2 className="size-4" aria-hidden="true" />;
    case "!":
      return <TriangleAlert className="size-4" aria-hidden="true" />;
    case "▶":
      return <MonitorPlay className="size-4" aria-hidden="true" />;
    case "✦":
      return <Sparkles className="size-4" aria-hidden="true" />;
    case "↑":
      return <Upload className="size-4" aria-hidden="true" />;
    default:
      return <Check className="size-4" aria-hidden="true" />;
  }
}

/**
 * Slate toaster — same primitive shadcn wraps (@base-ui/react Toast:
 * Provider/Viewport/Root/Content/Title/Description/Close + toast manager).
 * Stacking, swipe-to-dismiss, hover-pause, ARIA live announcements free;
 * slate theme (card, tone circle, type) on top. Replaces the old hand-rolled
 * fixed-div + setTimeout stack.
 */
export function SlateToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <ToastPrimitive.Provider toastManager={slateToastManager} limit={4} timeout={4200}>
      {children}
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="pointer-events-none fixed z-[80] bottom-20 lg:bottom-5 inset-x-3 sm:left-auto sm:right-5 sm:w-[340px] outline-none">
          <SlateToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

function SlateToastList() {
  const { toasts } = ToastPrimitive.useToastManager<{ icon?: string; tone?: ToastTone }>();

  return toasts.map((t) => {
    const tone = t.data?.tone ?? "ok";
    return (
      <ToastPrimitive.Root
        key={t.id}
        toast={t}
        data-slot="toast"
        className={cn(
          "slate-card group/toast pointer-events-auto absolute right-0 bottom-0 w-full origin-bottom text-left shadow-lg will-change-transform outline-none select-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          "z-[calc(1000-var(--toast-index))] [--gap:0.375rem] [--height:var(--toast-frontmost-height,var(--toast-height))] [--offset-y:calc(var(--toast-offset-y)*-1+calc(var(--toast-index)*var(--gap)*-1)+var(--toast-swipe-movement-y))] [--peek:0.375rem] [--scale:calc(max(0,1-(var(--toast-index)*0.05)))] [--shrink:calc(1-var(--scale))]",
          "h-(--height) [transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--peek))-(var(--shrink)*var(--height))))_scale(var(--scale))] [transition:transform_500ms_cubic-bezier(0.22,1,0.36,1),opacity_500ms,height_150ms]",
          "after:absolute after:top-full after:left-0 after:h-[calc(var(--gap)+1px)] after:w-full after:content-['']",
          "data-expanded:h-(--toast-height) data-expanded:[transform:translateX(var(--toast-swipe-movement-x))_translateY(var(--offset-y))]",
          "data-limited:opacity-0 data-starting-style:[transform:translateY(150%)]",
          "[&[data-ending-style]:not([data-limited]):not([data-swipe-direction])]:[transform:translateY(150%)]",
          "data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
          "data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
          "data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
          "data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
          "data-expanded:data-ending-style:data-[swipe-direction=down]:[transform:translateY(calc(var(--toast-swipe-movement-y)+150%))]",
          "data-expanded:data-ending-style:data-[swipe-direction=left]:[transform:translateX(calc(var(--toast-swipe-movement-x)-150%))_translateY(var(--offset-y))]",
          "data-expanded:data-ending-style:data-[swipe-direction=right]:[transform:translateX(calc(var(--toast-swipe-movement-x)+150%))_translateY(var(--offset-y))]",
          "data-expanded:data-ending-style:data-[swipe-direction=up]:[transform:translateY(calc(var(--toast-swipe-movement-y)-150%))]",
        )}
      >
        <ToastPrimitive.Content
          data-slot="toast-content"
          className="flex h-full items-center gap-2.5 overflow-hidden pl-3 pr-2 py-2.5 transition-opacity duration-250 ease-[cubic-bezier(0.22,1,0.36,1)] data-behind:opacity-0 data-expanded:opacity-100"
        >
          <span className={cn("grid place-items-center w-8 h-8 rounded-full shrink-0", toneBg[tone])}>
            <ToastGlyph icon={t.data?.icon} tone={tone} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col justify-center">
            <ToastPrimitive.Title
              data-slot="toast-title"
              className="text-[13px] font-semibold leading-snug truncate"
            />
            <ToastPrimitive.Description
              data-slot="toast-description"
              className="text-[12px] font-normal text-muted mt-0.5 break-words line-clamp-4"
            />
          </div>
          <ToastPrimitive.Close
            data-slot="toast-close"
            aria-label="Dismiss toast"
            render={
              <button
                type="button"
                className="grid place-items-center w-7 h-7 rounded-full shrink-0 text-muted hover:text-fg hover:bg-surface2 transition-colors"
              />
            }
          >
            <X className="size-3.5" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Content>
      </ToastPrimitive.Root>
    );
  });
}
