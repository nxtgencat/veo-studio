"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { cn } from "cn";
import { SlateIconButton } from "@/components/slate/button";
import { SlateDrawer } from "@/components/slate/overlays";

const STORAGE_KEY = "slate-sidebar-open";
const DESKTOP_QUERY = "(min-width: 1024px)";

/**
 * Slate sidebar — same pattern as shadcn's Sidebar primitives
 * (Provider + Trigger + desktop collapsible + mobile drawer):
 * - desktop (lg+): aside collapses in-flow, persisted to localStorage
 * - mobile: trigger opens the drawer (SlateDrawer)
 * - Cmd/Ctrl+B toggles, like shadcn's SIDEBAR_KEYBOARD_SHORTCUT
 */
interface SlateSidebarState {
  open: boolean;
  setOpen: (v: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (v: boolean) => void;
  isDesktop: boolean;
  toggle: () => void;
}

const SlateSidebarContext = React.createContext<SlateSidebarState | null>(null);

export function useSlateSidebar() {
  const ctx = React.useContext(SlateSidebarContext);
  if (!ctx) throw new Error("useSlateSidebar must be used within SlateSidebarProvider.");
  return ctx;
}

function useMedia(query: string) {
  const [matches, setMatches] = React.useState(false);
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function SlateSidebarProvider({
  children,
  storageKey = STORAGE_KEY,
}: {
  children: React.ReactNode;
  storageKey?: string;
}) {
  const isDesktop = useMedia(DESKTOP_QUERY);
  const [open, setOpenState] = React.useState(true);
  const [openMobile, setOpenMobile] = React.useState(false);

  // Apply persisted desktop state after mount (avoids SSR mismatch).
  React.useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      if (v != null) setOpenState(v === "1");
    } catch {
      /* private mode — stay open */
    }
  }, [storageKey]);

  const setOpen = React.useCallback(
    (v: boolean) => {
      setOpenState(v);
      try {
        localStorage.setItem(storageKey, v ? "1" : "0");
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );

  const setOpenMobileStable = React.useCallback((v: boolean) => setOpenMobile(v), []);

  const toggle = React.useCallback(() => {
    if (window.matchMedia(DESKTOP_QUERY).matches) {
      setOpenState((prev) => {
        const next = !prev;
        try {
          localStorage.setItem(storageKey, next ? "1" : "0");
        } catch {
          /* ignore */
        }
        return next;
      });
    } else {
      setOpenMobile((prev) => !prev);
    }
  }, [storageKey]);

  // Cmd/Ctrl+B shortcut (shadcn parity).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = React.useMemo<SlateSidebarState>(
    () => ({ open, setOpen, openMobile, setOpenMobile: setOpenMobileStable, isDesktop, toggle }),
    [open, setOpen, openMobile, setOpenMobileStable, isDesktop, toggle],
  );

  return <SlateSidebarContext.Provider value={value}>{children}</SlateSidebarContext.Provider>;
}

/** Panel-left trigger: opens the drawer on mobile, collapses on desktop. */
export function SlateSidebarTrigger({ className }: { className?: string }) {
  const { toggle } = useSlateSidebar();
  return (
    <SlateIconButton variant="quiet" size="icon-sm" label="Toggle sidebar" onClick={toggle} className={cn("shrink-0", className)}>
      <PanelLeft className="size-4" />
      <span className="sr-only">Toggle sidebar</span>
    </SlateIconButton>
  );
}

/** Desktop collapsible aside (hidden below lg, offcanvas when closed). */
export function SlateSidebar({ children, className }: { children: React.ReactNode; className?: string }) {
  const { open } = useSlateSidebar();
  return (
    <aside
      data-slot="slate-sidebar"
      data-state={open ? "expanded" : "collapsed"}
      className={cn("hidden w-[260px] shrink-0 border-r slate-hair overflow-hidden", open && "lg:flex lg:flex-col", className)}
    >
      {children}
    </aside>
  );
}

/** Mobile drawer. Auto-closes on route change so every navigation dismisses it. */
export function SlateSidebarDrawer({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { openMobile, setOpenMobile } = useSlateSidebar();
  const pathname = usePathname();
  const first = React.useRef(true);

  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);

  if (!openMobile) return null;
  return (
    <SlateDrawer title={title} onClose={() => setOpenMobile(false)} footer={footer}>
      {children}
    </SlateDrawer>
  );
}
