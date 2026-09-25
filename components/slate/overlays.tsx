"use client";

import * as React from "react";
import { cn } from "cn";
import { SlateCloseButton } from "@/components/slate/button";

function useLock() {
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
}

export function SlateModal({
  children,
  wide,
  onClose,
}: {
  children: React.ReactNode;
  wide?: boolean;
  onClose: () => void;
}) {
  useLock();
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="min-h-full flex p-4">
          <div className={cn("m-auto w-full slate-card p-5", wide ? "max-w-[720px]" : "max-w-[560px]")}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function SlateModalHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h3 className="font-display font-bold text-[17px]">{title}</h3>
      <SlateCloseButton onClick={onClose} />
    </div>
  );
}

/** Centered dialog: sticky header + footer, only body scrolls. */
export function SlateDialog({
  onClose,
  header,
  footer,
  children,
}: {
  onClose: () => void;
  header: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  useLock();
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div className="pointer-events-auto w-full max-w-[640px] slate-card rounded-[14px] flex flex-col overflow-hidden max-h-full">
          <div className="shrink-0 px-4 sm:px-5 py-3 border-b slate-hair flex items-center gap-2 flex-wrap">
            {header}
          </div>
          <div className="min-h-0 overflow-y-auto px-4 sm:px-5 py-4">{children}</div>
          {footer && (
            <div className="shrink-0 px-4 sm:px-5 py-3 border-t slate-hair flex items-center gap-2 flex-wrap">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function SlateDrawer({
  title,
  children,
  onClose,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  const [inX, setInX] = React.useState(false);
  React.useEffect(() => {
    requestAnimationFrame(() => setInX(true));
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] lg:hidden">
      <div
        className="absolute inset-0 bg-black/45"
        style={{ opacity: inX ? 1 : 0, transition: "opacity .2s" }}
        onClick={onClose}
      />
      <aside
        className="absolute left-0 top-0 h-full w-[280px] bg-surface flex flex-col"
        style={{ transform: inX ? "none" : "translateX(-100%)", transition: "transform .22s cubic-bezier(.22,1,.36,1)" }}
      >
        <div className="h-14 px-4 flex items-center justify-between border-b slate-hair shrink-0">
          <span className="font-display font-bold text-[14.5px]">{title}</span>
          <SlateCloseButton onClick={onClose} className="ml-0" />
        </div>
        <div className="flex-1 overflow-y-auto p-3">{children}</div>
        {footer && <div className="p-3 border-t slate-hair shrink-0">{footer}</div>}
      </aside>
    </div>
  );
}
