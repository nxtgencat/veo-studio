// Script tab: client types (mirror the server v5 view) + display metadata.
// All data comes from the API via lib/api.ts — nothing is mocked.

export interface ScriptSummary {
  id: string;
  title: string;
  updatedAt: string;
  files: { id: string; filename: string }[];
}

export interface ScriptEntity {
  kind: "character" | "location" | "prop" | "composite";
  id: string;
  name: string;
  lockVersion: number | null;
  variantOf: string;
  appearsInShots: number[];
  usedInShots: number[];
  identity: string;
  sideDetail: string;
  voice: string;
  personality: string;
  light: string;
  holderPath: string;
  stateChanges: string;
  contains: string[];
  binding: string;
  why: string;
  adhoc: boolean;
  imagePrompt: string;
  negativePrompt: string;
}

export interface ShotLine {
  id: string;
  who: string;
  text: string;
}

export interface ScriptShot {
  id: number;
  scene: number;
  beat: string;
  plannedS: number;
  footageS: number;
  location: string;
  characters: string[];
  props: string[];
  lines: ShotLine[];
  callIds: string[];
  startS: number;
  endS: number;
}

export interface ScriptCall {
  id: string;
  shot: number;
  pos: number;
  of: number;
  mode: string;
  refs: string[];
  characters: string[];
  props: string[];
  dur: number;
  chained_from: string | null;
  seed_from: string | null;
  continues_from: string | null;
  anchor_from: string | null;
  ends_at: string | null;
  dialogue: string[];
  chain_risk: string;
  content_risk: string;
  flags: string[];
  prompt: string;
  negative_prompt: string;
  renderedPrompt: string;
  renderSource: "actual" | "planned" | "missing" | "na";
  startS: number;
  endS: number;
  summary: string;
}

export interface ScriptCheck {
  code: string;
  severity: "error" | "warn" | "info";
  callId?: string;
  entityId?: string;
  message: string;
}

export interface ScriptDetail {
  script: { id: string; title: string; updatedAt: string };
  files: { id: string; filename: string; role: string; docs: number; calls: number; entities: number }[];
  meta: Record<string, unknown> | null;
  entities: ScriptEntity[];
  shots: ScriptShot[];
  calls: ScriptCall[];
  scenes: { n: number; title: string; shotIds: number[]; callIds: string[]; plannedS: number; footageS: number; startS: number; endS: number }[];
  index: Record<string, { calls: string[]; shots: number[] }>;
  checks: ScriptCheck[];
  totals: { footageS: number; plannedS: number; targetS: number | null; scenes: number; shots: number; calls: number };
}

export interface PreviewFile {
  filename: string;
  role: string;
  status: "new" | "update" | "duplicate" | "invalid";
  docCount?: number;
  match?: { scriptId: string; fileId: string; filename: string; kind: string; shared?: number };
  changes?: { key: string; fields: string[]; added?: boolean; removed?: boolean }[];
  error?: { doc: number; message: string };
}

/** Seconds → "m:ss" (45 → "0:45", 135 → "2:15"). */
export function mmss(s: number): string {
  const v = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

export const KIND_META = {
  C: { one: "Character", many: "Characters", hint: "The people who appear on screen." },
  L: { one: "Location", many: "Locations", hint: "Where the story takes place." },
  P: { one: "Prop", many: "Props", hint: "Objects that matter to the story." },
  G: { one: "Group image", many: "Group images", hint: "One reference image covering several characters of the same kind — only for groups sharing 2 or more shots." },
} as const;

export type EntityKindKey = keyof typeof KIND_META;

/** Short pill label from a full name ("Nora" stays "Nora"). */
export function shortName(name: string): string {
  const w = name.trim().split(/\s+/)[0];
  return w || name;
}

export const MODE_META: Record<string, { label: string; tip: string; dot: string; tone: "draft" | "info" | "ok" | "pending" }> = {
  "reference-to-video": { label: "Reference", tip: "A hard start using up to 3 reference images.", dot: "#2B5FB8", tone: "info" },
  extend: { label: "Extend", tip: "Continues the same shot. No new references.", dot: "#2A8F58", tone: "ok" },
  "frame-to-video": { label: "Re-anchor", tip: "Opens a new chain off a hard cut, seeded by a last frame or composite.", dot: "#B8790E", tone: "pending" },
};

export const CHAIN_RISK_META: Record<string, { tip: string; tone: "pending" | "danger" }> = {
  monitor: { tip: "Chain at or past the soft cap. Check before extending.", tone: "pending" },
  hard_stop: { tip: "Chain reached the hard cap. Close it here.", tone: "danger" },
};

export const CONTENT_RISK_META: Record<string, { tip: string; tone: "pending" | "danger" }> = {
  elevated: { tip: "Known hard case. Budget for a regeneration.", tone: "danger" },
  low_consistency: { tip: "No clean reference fix exists, flag for manual QC.", tone: "pending" },
};

export const CHECK_TONE: Record<ScriptCheck["severity"], "danger" | "pending" | "info"> = {
  error: "danger",
  warn: "pending",
  info: "info",
};

export const ROLE_LABEL: Record<string, string> = {
  single: "Single-file package",
  bible: "Bible",
  calls: "Calls",
  chunk: "Call chunk",
  entities: "Entities",
  shots: "Shots",
};
