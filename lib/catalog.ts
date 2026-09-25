// Static UI constants (labels, tabs, categories). Not mock data — these never
// change per request. Model capabilities + pricing come from the server
// (GET /models/capabilities) via lib/pricing.ts.

export const MODES = [
  { id: "t2v", label: "Text", icon: "type", desc: "Prompt only — a fresh shot from words" },
  { id: "i2v", label: "Image", icon: "image", desc: "One still + a motion prompt" },
  { id: "frames", label: "Frames", icon: "columns-2", desc: "Pin the exact start and end frame" },
  { id: "r2v", label: "Reference", icon: "layers", desc: "Up to 3 refs — identity locked, 8s" },
  { id: "extend", label: "Extend", icon: "stretch-horizontal", desc: "Continue a clip — plus 7 seconds" },
] as const;

export const TABS = [
  { id: "generate", label: "Generate", icon: "wand-sparkles" },
  { id: "library", label: "Library", icon: "film" },
  { id: "elements", label: "Elements", icon: "shapes" },
  { id: "settings", label: "Settings", icon: "settings-2" },
] as const;

export const EL_CATS = [
  { id: "characters", label: "Characters", icon: "user-round" },
  { id: "locations", label: "Locations", icon: "map-pin" },
  { id: "assets", label: "Assets", icon: "package" },
  { id: "frames", label: "Frames", icon: "images" },
] as const;

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
