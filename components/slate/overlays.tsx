"use client";

import * as React from "react";
import { SlateButton, SlateCloseButton } from "@/components/slate/button";

/** Shared dialog behavior: body scroll-lock + Escape to close. */
function useDialog(onClose: () => void) {
  React.useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
}

export function SlateModal({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  useDialog(onClose);
  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="min-h-full flex p-4">
          <div className="m-auto w-full slate-card p-5 max-w-[560px]">
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
  useDialog(onClose);
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
  useDialog(onClose);
  React.useEffect(() => {
    requestAnimationFrame(() => setInX(true));
  }, []);
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

/** Shared delete/cancel/dismiss confirm: title + body + Cancel/danger pair. */
export function ConfirmDeleteDialog({
  title,
  body,
  action = "Delete",
  icon,
  busy,
  close,
  confirm,
}: {
  title: string;
  body: React.ReactNode;
  action?: string;
  icon?: React.ReactNode;
  busy?: boolean;
  close: () => void;
  confirm: () => void;
}) {
  return (
    <SlateModal onClose={close}>
      <h3 className="font-display font-bold text-[16px]">{title}</h3>
      <p className="mt-1.5 text-[13.5px] text-fg2 leading-relaxed">{body}</p>
      <div className="mt-5 flex gap-2 justify-end">
        <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
        <SlateButton variant="danger" disabled={busy} onClick={confirm}>
          {icon}{action}
        </SlateButton>
      </div>
    </SlateModal>
  );
}
