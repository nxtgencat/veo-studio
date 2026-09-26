// Pure formatting helpers — no React, no store. DRY across views.
import type { VideoItem } from "@/lib/schemas";

export const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;

/** Elapsed clock: 45s → "0:45", 135s → "2:15". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Time left, honestly approximate: 45s → "≈45s left", 135s → "≈2m left". */
export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 90) return `≈${s}s left`;
  return `≈${Math.round(s / 60)}m left`;
}

/** Pending countdown: never shows a stuck "≈0s left" — says so when overdue. */
export function fmtCountdown(etaMs?: number, elapsedMs?: number): string {
  if (!(Number(etaMs) > 0)) return "estimating…";
  const left = Number(etaMs) - (Number(elapsedMs) || 0);
  if (left <= 0) return "taking longer than usual";
  return fmtLeft(left);
}

/** Requested vs delivered duration: 8 → "8s", (8, 6.2) → "8s → 6.2s". ±0.5s hides probe noise. */
export function fmtDurPair(expected: number, actual?: number | null): string {
  const e = Number(expected) || 0;
  if (actual == null || !(actual > 0) || Math.abs(actual - e) < 0.5) return `${e}s`;
  const a = Number.isInteger(actual) ? String(actual) : actual.toFixed(1);
  return `${e}s → ${a}s`;
}

/** Disk size: 29.7 MB, 800 KB, 0 → "—". */
export function fmtBytes(n?: number | null): string {
  if (!(Number(n) > 0)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

type DurNode = Pick<VideoItem, "id" | "mode" | "dur" | "inputs">;

/**
 * Expected total duration. Extend chains resolve recursively (8s → 15s → 22s):
 * old rows stored only the 7s chunk, new rows store the total — both resolve
 * the same. Deleted source with a chunk-only row is unknowable → 7.
 */
export function expectedDur(
  v: DurNode,
  find: (id: string) => DurNode | undefined,
  seen: Set<string> = new Set(),
): number {
  if (v.mode !== "extend" || seen.has(v.id)) return v.dur;
  seen.add(v.id);
  const src = v.inputs.extendVideo ? find(v.inputs.extendVideo) : undefined;
  if (!src) return v.dur > 7 ? v.dur : 7;
  return expectedDur(src, find, seen) + 7;
}

export function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1e3);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return d + (d === 1 ? " day ago" : " days ago");
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const fullTs = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
