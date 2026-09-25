import { MODELS, RATES } from "@/mock/catalog.mock";
import type { Project, VideoItem } from "@/lib/schemas";

export const modelOf = (id: string) =>
  MODELS.find((m) => m.id === id) ?? MODELS[1];

export function rateFor(id: string, res: string, audio: boolean): number | null {
  const tier = modelOf(id).tier as keyof typeof RATES;
  const r = RATES[tier]?.[res];
  if (!r) return null;
  const v = audio ? r.a : r.s;
  return v == null ? null : v;
}

export function priceFor(
  id: string,
  res: string,
  dur: number,
  audio: boolean,
  batch = 1,
): number | null {
  const r = rateFor(id, res, audio);
  return r == null ? null : r * dur * (batch || 1);
}

export const spendOf = (p: Project) =>
  p.library.filter((v) => v.status === "success").reduce((a, v) => a + (v.cost || 0), 0);

export const pendingOf = (p: Project) =>
  p.library.filter((v) => v.status === "pending").length;

export function validateGen(
  g: { prompt: string; mode: string; image: string; first: string; last: string; refs: string[]; extendVideo: string },
  m: ReturnType<typeof modelOf>,
  lib: VideoItem[],
): string | null {
  if (!g.prompt.trim()) return "Write a prompt first.";
  if (g.mode === "i2v" && !g.image) return "Image mode needs 1 image.";
  if (g.mode === "frames" && (!g.first || !g.last)) return "Frames mode needs first + last frame.";
  if (g.mode === "r2v") {
    if (!("ref" in m && m.ref)) return `${m.label} has no reference mode.`;
    if (!g.refs.filter(Boolean).length) return "Reference mode needs 1–3 reference images.";
  }
  if (g.mode === "extend") {
    if (!("ext" in m && m.ext)) return `${m.label} cannot extend.`;
    if (!g.extendVideo) return "Pick a source video.";
    const s = lib.find((x) => x.id === g.extendVideo);
    if (!s) return "Source video is gone — pick another.";
    if (!s.url) return "Source file is gone after reload — re-upload it.";
    if (s.dur > 30) return `Source is ${s.dur}s — Extend inputs must be ≤ 30s.`;
  }
  if (g.mode === "frames" && !("flf" in m && m.flf)) return `${m.label} has no frames mode.`;
  return null;
}
