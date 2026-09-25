// Mock catalog only. No UI, no logic — pure data.
// Mirrors references/ai-video-studio.html MODELS / RATES / MODES / TABS / EL_CATS.

export const MODELS = [
  { id: "veo-3.1-generate-001", label: "Veo 3.1", tier: "Standard", ref: true, ext: true, flf: true, res: ["720p", "1080p", "4K"], dur: [4, 6, 8], retires: false },
  { id: "veo-3.1-fast-generate-001", label: "Veo 3.1 Fast", tier: "Fast", ref: true, ext: true, flf: true, res: ["720p", "1080p", "4K"], dur: [4, 6, 8], retires: false },
  { id: "veo-3.1-lite-generate-001", label: "Veo 3.1 Lite", tier: "Lite", ref: false, ext: true, flf: true, res: ["720p", "1080p"], dur: [4, 6, 8], retires: false, preview: true },
  { id: "veo-3.0-generate-001", label: "Veo 3", tier: "Standard", ref: false, ext: false, flf: false, res: ["720p", "1080p"], dur: [4, 6, 8], retires: true },
  { id: "veo-3.0-fast-generate-001", label: "Veo 3 Fast", tier: "Fast", ref: false, ext: false, flf: false, res: ["720p", "1080p"], dur: [4, 6, 8], retires: true },
  { id: "veo-2.0-generate-001", label: "Veo 2", tier: "Legacy", ref: true, ext: false, flf: true, res: ["720p"], dur: [5, 6, 7, 8], retires: true, silent: true },
] as const;

export type ModelId = (typeof MODELS)[number]["id"];

export const RATES: Record<string, Record<string, { a: number | null; s: number | null }>> = {
  Standard: { "720p": { a: 0.4, s: 0.2 }, "1080p": { a: 0.4, s: 0.2 }, "4K": { a: 0.6, s: 0.4 } },
  Fast: { "720p": { a: 0.1, s: 0.08 }, "1080p": { a: 0.12, s: 0.1 }, "4K": { a: 0.3, s: 0.25 } },
  Lite: { "720p": { a: 0.05, s: 0.03 }, "1080p": { a: 0.08, s: 0.05 } },
  Legacy: { "720p": { a: null, s: 0.5 } },
};

export const MODES = [
  { id: "t2v", label: "Text", icon: "type", desc: "Prompt only — a fresh shot from words" },
  { id: "i2v", label: "Image", icon: "image", desc: "One still + a motion prompt" },
  { id: "frames", label: "Frames", icon: "columns-2", desc: "Pin the exact start and end frame" },
  { id: "r2v", label: "Reference", icon: "layers", desc: "Up to 3 refs — identity locked, 8s" },
  { id: "extend", label: "Extend", icon: "stretch-horizontal", desc: "Continue a clip — plus 7 seconds" },
] as const;

export type GenerationMode = (typeof MODES)[number]["id"];

export const SAMPLE_VIDEOS = [
  "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
];

export const TABS = [
  { id: "generate", label: "Generate", icon: "wand-sparkles" },
  { id: "library", label: "Library", icon: "film" },
  { id: "elements", label: "Elements", icon: "shapes" },
  { id: "settings", label: "Settings", icon: "settings-2" },
] as const;

export type StudioTab = (typeof TABS)[number]["id"];

export const EL_CATS = [
  { id: "characters", label: "Characters", icon: "user-round" },
  { id: "locations", label: "Locations", icon: "map-pin" },
  { id: "assets", label: "Assets", icon: "package" },
  { id: "frames", label: "Frames", icon: "images" },
] as const;

export type ElementCat = (typeof EL_CATS)[number]["id"];

export const YT_PRIVS = [
  { id: "private", label: "Private", hint: "always works" },
  { id: "unlisted", label: "Unlisted", hint: "link-only" },
  { id: "public", label: "Public", hint: "needs audit" },
] as const;

export const YT_CATS = [
  { id: "22", label: "People & Blogs" },
  { id: "28", label: "Science & Tech" },
  { id: "24", label: "Entertainment" },
  { id: "27", label: "Education" },
  { id: "10", label: "Music" },
  { id: "17", label: "Sports" },
] as const;
