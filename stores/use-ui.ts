"use client";

import { create } from "zustand";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { api, type StoredBackup } from "@/lib/api";

export type ToastTone = "ok" | "danger" | "info" | "pending" | "draft" | "brand";

export interface ToastOptions {
  icon?: string;
  tone?: ToastTone;
  detail?: string;
}

/** Shared manager (same primitive shadcn's Toaster wraps). Limit/timeout live on the Provider. */
export const slateToastManager = ToastPrimitive.createToastManager<{
  icon?: string;
  tone?: ToastTone;
}>();

const TYPE_FOR_TONE: Record<ToastTone, "success" | "error" | "info" | "loading" | undefined> = {
  ok: "success",
  danger: "error",
  info: "info",
  pending: "loading",
  draft: undefined,
  brand: undefined,
};

export function toast(msg: string, opts?: ToastOptions): string {
  const tone = opts?.tone ?? "ok";
  return slateToastManager.add({
    title: msg,
    description: opts?.detail,
    type: TYPE_FOR_TONE[tone],
    priority: tone === "danger" ? "high" : "low",
    // Danger toasts carry full error text — give them time to be read.
    timeout: tone === "danger" ? 9000 : 4200,
    data: { icon: opts?.icon, tone },
  });
}

interface ToastState {
  push: (msg: string, opts?: ToastOptions) => void;
}

/** Error toast shorthand: danger tone + ! icon, optional detail. */
export function pushErr(msg: string, detail?: string): void {
  toast(msg, { icon: "!", tone: "danger", ...(detail ? { detail } : {}) });
}

export const useToasts = create<ToastState>()(() => ({
  push: (msg, opts) => {
    void toast(msg, opts);
  },
}));

// YouTube token lives in memory only — never persisted (matches reference behavior).
interface YtAuthState {
  token: string;
  exp: number;
  channel: string;
  setAuth: (token: string, exp: number, channel?: string) => void;
  clear: () => void;
}

export const useYtAuth = create<YtAuthState>()((set) => ({
  token: "",
  exp: 0,
  channel: "",
  setAuth: (token, exp, channel = "") => set({ token, exp, channel }),
  clear: () => set({ token: "", exp: 0, channel: "" }),
}));

// Backup files live on the server: build one, upload yours, then
// download / restore / delete any of them. The list is server truth.
interface BackupState {
  files: StoredBackup[];
  busy: { kind: "build" | "upload" | "restore"; label: string } | null;
  refresh: () => Promise<void>;
  buildNow: () => Promise<StoredBackup | null>;
  upload: (file: File, signal?: AbortSignal, onProgress?: (frac: number) => void) => Promise<StoredBackup | null>;
  remove: (id: string) => Promise<boolean>;
  restore: (id: string) => Promise<Record<string, Record<string, number>> | null>;
}

export const useBackup = create<BackupState>()((set, get) => ({
  files: [],
  busy: null,

  refresh: async () => {
    try {
      const { backups } = await api.listBackups();
      set({ files: backups });
    } catch { /* list is best-effort; rows below show errors */ }
  },

  buildNow: async () => {
    if (get().busy) return null;
    set({ busy: { kind: "build", label: "Packing everything…" } });
    try {
      const row = await api.buildBackup();
      set({ files: [row, ...get().files] });
      return row;
    } catch {
      return null;
    } finally {
      set({ busy: null });
    }
  },

  upload: async (file, signal, onProgress) => {
    if (get().busy) return null;
    set({ busy: { kind: "upload", label: `Storing ${file.name}…` } });
    try {
      const row = await api.uploadBackup(file, signal, (frac) => {
        onProgress?.(frac);
        const b = get().busy;
        if (b?.kind === "upload") set({ busy: { ...b, label: `Storing ${file.name}… ${Math.round(frac * 100)}%` } });
      });
      set({ files: [row, ...get().files] });
      return row;
    } catch {
      return null;
    } finally {
      set({ busy: null });
    }
  },

  remove: async (id) => {
    try {
      await api.deleteBackup(id);
      set({ files: get().files.filter((f) => f.id !== id) });
      return true;
    } catch {
      return false;
    }
  },

  restore: async (id) => {
    if (get().busy) return null;
    const row = get().files.find((f) => f.id === id);
    set({ busy: { kind: "restore", label: `Restoring ${row?.filename ?? "backup"}…` } });
    try {
      return await api.restoreBackup(id);
    } catch {
      return null;
    } finally {
      set({ busy: null });
    }
  },
}));
