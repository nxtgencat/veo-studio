"use client";

import * as React from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "cn";
import { Check, ChevronDown } from "lucide-react";
import { SlateTooltip } from "@/components/slate/tooltip";

/**
 * Single reusable dropdown — slate theme over the same primitive shadcn wraps
 * (@base-ui/react Menu: Root/Trigger/Portal/Positioner/Popup/Item).
 * Anchor-positioned with collision handling, portaled to body (never clipped by
 * overflow/sticky ancestors), Escape/arrow/typeahead out of the box.
 * Replaces the old manual getBoundingClientRect + duplicate-id implementation.
 */
export function SlateDropdown({
  label,
  menu,
  btnClassName,
  title,
  trigger,
  align = "start",
}: {
  label?: React.ReactNode;
  menu: (close: () => void) => React.ReactNode;
  btnClassName?: string;
  title?: string;
  trigger?: React.ReactElement;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);

  // Themed tooltip composes with the menu trigger (no wrapper DOM, no
  // native title) — every dropdown's `title` renders in-theme, app-wide.
  const triggerEl = trigger ? (
    <MenuPrimitive.Trigger render={trigger} />
  ) : (
    <MenuPrimitive.Trigger
      render={
        <button
          type="button"
          aria-label={typeof label === "string" ? label : title}
          aria-haspopup="listbox"
          className={cn(
            "slate-field !min-h-[30px] !h-[30px] !w-auto !py-0 !pl-2 !pr-1 !text-[12px] font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0",
            btnClassName,
          )}
        />
      }
    >
      <span className="flex-1 min-w-0 truncate text-left">{label}</span>
      <ChevronDown className="size-3.5 text-muted shrink-0" />
    </MenuPrimitive.Trigger>
  );

  return (
    <MenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <SlateTooltip tip={title}>{triggerEl}</SlateTooltip>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner
          align={align}
          side="bottom"
          sideOffset={6}
          className="z-[90] outline-none"
        >
          <MenuPrimitive.Popup
            role="listbox"
            className="slate-card slate-menu-popup w-max min-w-(--anchor-width) max-w-[min(320px,calc(100vw-16px))] max-h-[min(46dvh,320px)] overflow-y-auto p-1.5 shadow-xl outline-none"
          >
            {menu(close)}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export function SlateOption({
  active,
  disabled,
  note,
  sub,
  tone = "default",
  className,
  onPick,
  onClose,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  note?: string;
  sub?: string;
  tone?: "default" | "danger";
  className?: string;
  onPick: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      disabled={disabled}
      onClick={() => {
        onPick();
        onClose();
      }}
      className={cn(
        "slate-menu-item w-full flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12.5px] font-semibold cursor-pointer select-none outline-none",
        active
          ? "bg-[var(--t-brand-bg)] text-[var(--t-brand-fg)]"
          : tone === "danger"
            ? "text-[#C9432E] dark:text-[#E88A76] hover:bg-surface2"
            : "hover:bg-surface2",
        disabled && "opacity-50 pointer-events-none",
        className,
      )}
    >
      <span className="flex-1 min-w-0 truncate">
        {children}
        {note && <span className="text-[11px] text-muted"> · {note}</span>}
      </span>
      {sub && <span className="text-[11px] text-muted shrink-0">{sub}</span>}
      {active && <Check className="size-3.5 shrink-0" />}
    </MenuPrimitive.Item>
  );
}

/** Rich menu row (icon + title + desc) for the mode switcher and similar. */
export function SlateMenuRow({
  active,
  disabled,
  onPick,
  onClose,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onPick: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <div className="opacity-40" aria-disabled="true">
        {children}
      </div>
    );
  }
  return (
    <MenuPrimitive.Item
      onClick={() => {
        onPick();
        onClose();
      }}
      className={cn(
        "slate-menu-item w-full flex items-center gap-2.5 rounded-[9px] px-2 py-2 text-left cursor-pointer select-none outline-none",
        active ? "bg-[var(--t-brand-bg)]" : "hover:bg-surface2",
      )}
    >
      {children}
    </MenuPrimitive.Item>
  );
}
