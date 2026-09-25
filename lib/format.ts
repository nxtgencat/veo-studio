// Pure formatting helpers — no React, no store. DRY across views.
export const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

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
