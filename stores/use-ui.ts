"use client";

import { create } from "zustand";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { api, type StoredBackup } from "@/lib/api";
import type { YtAccountState, YtChannelMeta } from "@/lib/youtube";

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

// YouTube session persists in this browser only (localStorage) — never on the
// server, never anywhere except Google's APIs. The access token itself
// expires ~1h after Google issues it; the channel identity outlives it so
// the UI can tell "session expired" apart from "never connected".
const YT_KEY = "veo-yt";

interface YtPersisted {
  token: string;
  exp: number;
  channel: string;
  meta: YtChannelMeta | null;
  account: YtAccountState;
  detail: string;
}

function loadYt(): YtPersisted {
  const empty: YtPersisted = { token: "", exp: 0, channel: "", meta: null, account: "unknown", detail: "" };
  try {
    if (typeof window === "undefined") return empty;
    const raw = window.localStorage.getItem(YT_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<YtPersisted>;
    return {
      token: typeof p.token === "string" ? p.token : "",
      exp: typeof p.exp === "number" ? p.exp : 0,
      channel: typeof p.channel === "string" ? p.channel : "",
      meta: p.meta && typeof p.meta === "object" ? (p.meta as YtChannelMeta) : null,
      account: p.account === "ok" || p.account === "no-channel" || p.account === "error" ? p.account : "unknown",
      detail: typeof p.detail === "string" ? p.detail : "",
    };
  } catch {
    return empty; // private mode — memory only
  }
}

function saveYt(p: YtPersisted): void {
  try {
    window.localStorage.setItem(YT_KEY, JSON.stringify(p));
  } catch { /* private mode — memory only */ }
}

export interface YtAuthInput {
  token: string;
  exp: number;
  channel?: string;
  meta?: YtChannelMeta | null;
  account?: YtAccountState;
  detail?: string;
}

interface YtAuthState {
  token: string;
  exp: number;
  channel: string;
  meta: YtChannelMeta | null;
  account: YtAccountState;
  detail: string;
  setAuth: (auth: YtAuthInput) => void;
  clear: () => void;
}

const YT_EMPTY = { token: "", exp: 0, channel: "", meta: null, account: "unknown", detail: "" } as const;

export const useYtAuth = create<YtAuthState>()((set) => ({
  ...loadYt(),
  setAuth: (auth) => {
    const next = {
      token: auth.token,
      exp: auth.exp,
      channel: auth.channel ?? "",
      meta: auth.meta ?? null,
      account: auth.account ?? "unknown",
      detail: auth.detail ?? "",
    };
    saveYt(next);
    set(next);
  },
  clear: () => {
    saveYt({ ...YT_EMPTY });
    set({ ...YT_EMPTY });
  },
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
