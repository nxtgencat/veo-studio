// Pricing + capability helpers backed by the server (GET /models/capabilities).
// Same export surface as before; `setCapabilities` is called once by the
// studio store during hydrate. No mock data anywhere in this file.
import type { Capabilities } from "@/lib/api";
import type { Project, VideoItem } from "@/lib/schemas";

let CAPS: Capabilities | null = null;

export function setCapabilities(c: Capabilities | null) {
  CAPS = c;
}

export function capabilitiesReady(): boolean {
  return CAPS != null;
}

export interface UiModel {
  id: string;
  label: string;
  tier: string;
  res: readonly string[];
  dur: readonly number[];
  ref: boolean;
  ext: boolean;
  flf: boolean;
  silent: boolean;
  retires: boolean;
  preview: boolean;
}

const FALLBACK: UiModel = {
  id: "unknown",
  label: "Unknown model",
  tier: "Standard",
  res: ["720p"],
  dur: [8],
  ref: false,
  ext: false,
  flf: false,
  silent: false,
  retires: false,
  preview: false,
};

export const modelOf = (id: string): UiModel => {
  const m = CAPS?.models.find((x) => x.id === id);
  if (!m) {
    if (id === "import") {
      return { ...FALLBACK, id: "import", label: "Upload", res: ["720p", "1080p", "4K"], dur: [4, 5, 6, 7, 8] };
    }
    return CAPS?.models[0]
      ? modelOf(CAPS.models[0].id)
      : FALLBACK;
  }
  return {
    id: m.id,
    label: m.label,
    tier: m.tier,
    res: m.resolutions,
    dur: m.durations,
    ref: m.modes.includes("r2v"),
    ext: m.modes.includes("extend"),
    flf: m.modes.includes("f2v"),
    silent: !m.audio,
    retires: m.retires,
    preview: m.stage === "Preview",
  };
};

export const allModels = (): UiModel[] => (CAPS?.models ?? []).map((m) => modelOf(m.id));

export function rateFor(id: string, res: string, audio: boolean): number | null {
  const m = modelOf(id);
  const r = CAPS?.pricingPerSecond[m.tier]?.[res];
  if (!r) return null;
  const v = audio ? r.audio : r.silent;
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
  return r == null ? null : Math.round(r * dur * (batch || 1) * 100) / 100;
}

export const spendOf = (p: Project) =>
  p.library.filter((v) => v.status === "success").reduce((a, v) => a + (v.cost || 0), 0);

export const pendingOf = (p: Project) =>
  p.library.filter((v) => v.status === "pending").length;

export function validateGen(
  g: { prompt: string; mode: string; image: string; first: string; last: string; refs: string[]; extendVideo: string },
  m: UiModel,
  lib: VideoItem[],
): string | null {
  if (!g.prompt.trim()) return "Write a prompt first.";
  if (g.mode === "i2v" && !g.image) return "Image mode needs 1 image.";
  if (g.mode === "frames" && (!g.first || !g.last)) return "Frames mode needs first + last frame.";
  if (g.mode === "r2v") {
    if (!m.ref) return `${m.label} has no reference mode.`;
    if (!g.refs.filter(Boolean).length) return "Reference mode needs 1–3 reference images.";
  }
  if (g.mode === "extend") {
    if (!m.ext) return `${m.label} cannot extend.`;
    if (!g.extendVideo) return "Pick a source video.";
    const s = lib.find((x) => x.id === g.extendVideo);
    if (!s) return "Source video is gone — pick another.";
    if (s.dur > 30) return `Source is ${s.dur}s — Extend inputs must be ≤ 30s.`;
  }
  if (g.mode === "frames" && !m.flf) return `${m.label} has no frames mode.`;
  return null;
}
