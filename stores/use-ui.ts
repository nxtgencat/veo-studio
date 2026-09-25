"use client";

import { create } from "zustand";
import { Toast as ToastPrimitive } from "@base-ui/react/toast";

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
    timeout: 4200,
    data: { icon: opts?.icon, tone },
  });
}

interface ToastState {
  push: (msg: string, opts?: ToastOptions) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastState>()(() => ({
  push: (msg, opts) => {
    void toast(msg, opts);
  },
  dismiss: (id) => slateToastManager.close(id),
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
