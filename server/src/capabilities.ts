// Typed transcription of KNOWLEDGE.md §3 + §6. UI must drive from here.

export const MODELS = [
  {
    id: "veo-3.1-generate-001",
    label: "Veo 3.1",
    tier: "Standard" as const,
    stage: "GA" as const,
    retires: false,
    audio: true,
    modes: ["t2v", "i2v", "f2v", "r2v", "extend"] as const,
    durations: [4, 6, 8] as const,
    r2vDurations: [8] as const,
    resolutions: ["720p", "1080p", "4K"] as const,
    aspects: ["16:9", "9:16"] as const,
    fps: 24 as const,
    maxOutputs: 4,
    maxImageMB: 20,
    maxRefs: 3,
  },
  {
    id: "veo-3.1-fast-generate-001",
    label: "Veo 3.1 Fast",
    tier: "Fast" as const,
    stage: "GA" as const,
    retires: false,
    audio: true,
    modes: ["t2v", "i2v", "f2v", "r2v", "extend"] as const,
    durations: [4, 6, 8] as const,
    r2vDurations: [8] as const,
    resolutions: ["720p", "1080p", "4K"] as const,
    aspects: ["16:9", "9:16"] as const,
    fps: 24 as const,
    maxOutputs: 4,
    maxImageMB: 20,
    maxRefs: 3,
  },
  {
    id: "veo-3.1-lite-generate-001",
    label: "Veo 3.1 Lite",
    tier: "Lite" as const,
    stage: "Preview" as const,
    retires: false,
    audio: true,
    modes: ["t2v", "i2v", "f2v", "extend"] as const,
    durations: [4, 6, 8] as const,
    r2vDurations: [] as const,
    resolutions: ["720p", "1080p"] as const,
    aspects: ["16:9", "9:16"] as const,
    fps: 24 as const,
    maxOutputs: 4,
    maxImageMB: 20,
    maxRefs: 0,
  },
  {
    id: "veo-3.0-generate-001",
    label: "Veo 3",
    tier: "Standard" as const,
    stage: "GA" as const,
    retires: true,
    retireDate: "2026-06-30",
    audio: true,
    modes: ["t2v", "i2v"] as const,
    durations: [4, 6, 8] as const,
    r2vDurations: [] as const,
    resolutions: ["720p", "1080p"] as const,
    aspects: ["16:9", "9:16"] as const,
    fps: 24 as const,
    maxOutputs: 4,
    maxImageMB: 20,
    maxRefs: 0,
  },
  {
    id: "veo-3.0-fast-generate-001",
    label: "Veo 3 Fast",
    tier: "Fast" as const,
    stage: "GA" as const,
    retires: true,
    retireDate: "2026-06-30",
    audio: true,
    modes: ["t2v", "i2v"] as const,
    durations: [4, 6, 8] as const,
    r2vDurations: [] as const,
    resolutions: ["720p", "1080p"] as const,
    aspects: ["16:9", "9:16"] as const,
    fps: 24 as const,
    maxOutputs: 4,
    maxImageMB: 20,
    maxRefs: 0,
  },
  {
    id: "veo-2.0-generate-001",
    label: "Veo 2",
    tier: "Legacy" as const,
    stage: "GA" as const,
    retires: true,
    audio: false,
    modes: ["t2v", "i2v", "f2v", "r2v"] as const,
    durations: [5, 6, 7, 8] as const,
    r2vDurations: [8] as const,
    resolutions: ["720p"] as const,
    aspects: ["16:9", "9:16"] as const,
    fps: 24 as const,
    maxOutputs: 1,
    maxImageMB: 20,
    maxRefs: 3,
  },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];
export type Tier = (typeof MODELS)[number]["tier"];
export type GenerationMode = "t2v" | "i2v" | "f2v" | "r2v" | "extend";
export type Resolution = "720p" | "1080p" | "4K";
export type Aspect = "16:9" | "9:16";

export const MODES: { id: GenerationMode; label: string; desc: string }[] = [
  { id: "t2v", label: "Text", desc: "Prompt only — a fresh shot from words" },
  { id: "i2v", label: "Image", desc: "One still + a motion prompt" },
  { id: "f2v", label: "Frames", desc: "Pin the exact start and end frame" },
  { id: "r2v", label: "Reference", desc: "Up to 3 refs — identity locked, 8s" },
  { id: "extend", label: "Extend", desc: "Continue a clip — plus 7 seconds" },
];

export const EXTEND_SECONDS = 7;
export const EXTEND_TOTAL_CAP = 37;

export function getModel(id: string) {
  return MODELS.find((m) => m.id === id);
}

export function capabilitiesSnapshot() {
  return {
    models: MODELS.map((m) => ({ ...m })),
    modes: MODES,
    extend: { secondsPerCall: EXTEND_SECONDS, totalCapSeconds: EXTEND_TOTAL_CAP },
  };
}
