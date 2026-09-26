"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

/**
 * Themed tooltip — the only tooltip studio code may use (never import
 * ui/tooltip here, and never ship native `title=` tooltips: they render in
 * the OS style and clash with the theme). Portaled, collision-aware,
 * slate-card styled. Trigger renders with zero wrapper DOM.
 */
export function SlateTooltip({
  tip,
  side = "top",
  children,
}: {
  tip?: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactElement;
}) {
  if (!tip) return <>{children}</>;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={6} className="z-[95] outline-none">
          <TooltipPrimitive.Popup className="max-w-[240px] rounded-[8px] border slate-hair bg-surface px-2 py-1 text-center text-[12px] font-medium leading-snug text-fg shadow-xl outline-none">
            {tip}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
