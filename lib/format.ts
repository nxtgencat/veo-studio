// Pure formatting helpers — no React, no store. DRY across views.
export const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

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
