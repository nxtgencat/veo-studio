import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "cn";

/** Slate skeleton (shadcn skeleton.tsx parity: animate-pulse + tonal fill). */
export function SlateSkeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden className={cn("slate-skeleton", className)} {...props} />;
}

/** Slate spinner (shadcn spinner.tsx parity). */
export function SlateSpinner({ className }: { className?: string }) {
  return <Loader2 role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} />;
}

/** Loading state for tab routes: head + card grid in the same shapes as real content. */
export function TabLoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <SlateSkeleton className="h-[24px] w-40" />
          <SlateSkeleton className="h-[16px] w-72 max-w-full mt-2" />
        </div>
        <SlateSkeleton className="h-[30px] w-28" />
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-2.5 sm:gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="slate-card overflow-hidden">
            <SlateSkeleton className="aspect-video !rounded-none" />
            <div className="p-2 sm:p-3 space-y-2">
              <SlateSkeleton className="h-[14px] w-11/12" />
              <div className="flex items-center justify-between gap-2">
                <SlateSkeleton className="h-[22px] w-20 !rounded-full" />
                <SlateSkeleton className="h-[14px] w-12" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Loading state for the video deep-link route. */
export function VideoLoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading video" className="slate-card p-4 max-w-[720px]">
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        <SlateSkeleton className="h-[22px] w-28 !rounded-full" />
        <SlateSkeleton className="h-[22px] w-20 !rounded-full" />
        <SlateSkeleton className="h-[22px] w-24 !rounded-full" />
      </div>
      <SlateSkeleton className="aspect-video w-full" />
      <SlateSkeleton className="h-[16px] w-3/4 mt-3" />
      <SlateSkeleton className="h-[12px] w-1/3 mt-2" />
    </div>
  );
}
