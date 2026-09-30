// Script packages (skill-v5 multi-document YAML): parse on the server only,
// store raw text verbatim, derive everything else on read.
//
// One module owns: per-doc `---` parsing (precise doc numbers on failure),
// duplicate/update/new classification, the read-time view builder
// (files, entities, shots, calls with running times, scenes, reverse index)
// and the machine-checkable Part C lint `checks[]` list.

import { YAML } from "bun";

export type DocKind =
  | "package_meta"
  | "character"
  | "location"
  | "prop"
  | "composite"
  | "shot"
  | "call"
  | "chunk_header"
  | "asset_log"
  | "call_log";

export const DOC_KINDS: DocKind[] = [
  "package_meta",
  "character",
  "location",
  "prop",
  "composite",
  "shot",
  "call",
  "chunk_header",
  "asset_log",
  "call_log",
];

export interface ScriptDoc {
  kind: DocKind;
  id?: string | number;
  [key: string]: unknown;
}

export interface DocError {
  doc: number;
  message: string;
}

export interface ParsedFile {
  docs: ScriptDoc[];
  error: DocError | null;
}

const MAX_DOCS = 500;
const MAX_FILE_CHARS = 2_000_000;

/** Split a `---`-separated stream into raw chunks (handles \r\n). */
function splitDocChunks(text: string): string[] {
  return text.split(/\r?\n[ \t]*---[ \t]*\r?\n?/);
}

/**
 * Parse each `---` chunk separately so one bad doc fails with its own
 * 1-based doc number instead of breaking the whole file.
 */
export function parseScriptText(text: string): ParsedFile {
  const raw = splitDocChunks(text.replace(/^\uFEFF/, ""));
  const chunks = raw.map((c) => c.trim()).filter((c) => c.length > 0);
  if (chunks.length > MAX_DOCS) {
    return { docs: [], error: { doc: MAX_DOCS + 1, message: `too many documents (>${MAX_DOCS})` } };
  }
  const docs: ScriptDoc[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as string;
    let parsed: unknown;
    try {
      parsed = YAML.parse(chunk);
    } catch (e) {
      return { docs: [], error: { doc: i + 1, message: yamlMessage(e) } };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { docs: [], error: { doc: i + 1, message: "document is not a mapping (expected `kind:` + fields)" } };
    }
    const doc = parsed as Record<string, unknown>;
    if (typeof doc.kind !== "string" || !DOC_KINDS.includes(doc.kind as DocKind)) {
      const got = typeof doc.kind === "string" ? doc.kind : "missing";
      return {
        docs: [],
        error: { doc: i + 1, message: `unknown kind "${got}" (expected one of ${DOC_KINDS.join(", ")})` },
      };
    }
    const problem = validateDoc(doc.kind as DocKind, doc);
    if (problem) return { docs: [], error: { doc: i + 1, message: problem } };
    docs.push(doc as ScriptDoc);
  }
  if (!docs.length) return { docs: [], error: { doc: 1, message: "no YAML documents found" } };
  return { docs, error: null };
}

function yamlMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? "parse error");
  // Bun's YAML errors carry line info already — keep the first line only.
  return msg.split("\n")[0]?.slice(0, 300) ?? "invalid YAML";
}

const ID_PATTERNS: Record<string, RegExp> = {
  character: /^C\d+b?$/,
  location: /^L\d+$/,
  prop: /^P\d+$/,
  composite: /^G\d+$/,
  call: /^CL\d+$/,
};

const CALL_MODES = ["reference-to-video", "extend", "frame-to-video"];

/** Minimal structural validation: only what the UI and checks need. */
function validateDoc(kind: DocKind, doc: Record<string, unknown>): string | null {
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  if (kind === "package_meta") {
    if (!str(doc.title)) return "package_meta needs a non-empty `title`";
    return null;
  }
  if (kind === "chunk_header") {
    if (doc.part == null || typeof doc.bible_file !== "string") return "chunk_header needs `part` and `bible_file`";
    return null;
  }
  if (kind === "shot") {
    if (typeof doc.id !== "number" || !Number.isInteger(doc.id)) return "shot needs an integer `id`";
    if (typeof doc.scene !== "number" || !Number.isInteger(doc.scene)) return `shot ${doc.id} needs an integer \`scene\``;
    if (typeof doc.planned_s !== "number" || !Number.isFinite(doc.planned_s)) return `shot ${doc.id} needs numeric \`planned_s\``;
    return null;
  }
  if (kind === "call") {
    const pat = ID_PATTERNS.call as RegExp;
    if (typeof doc.id !== "string" || !pat.test(doc.id)) return "call needs an `id` like CL001";
    for (const f of ["shot", "pos", "of", "dur"] as const) {
      if (typeof doc[f] !== "number" || !Number.isFinite(doc[f])) return `call ${doc.id} needs numeric \`${f}\``;
    }
    if (typeof doc.mode !== "string" || !CALL_MODES.includes(doc.mode)) {
      return `call ${doc.id} has unknown mode "${String(doc.mode)}"`;
    }
    if (!str(doc.prompt)) return `call ${doc.id} needs a non-empty \`prompt\``;
    return null;
  }
  if (kind === "asset_log" || kind === "call_log") {
    if (!str(doc.id)) return `${kind} needs a string \`id\``;
    return null;
  }
  // character | location | prop | composite (composites carry no name field).
  const pat = ID_PATTERNS[kind] as RegExp;
  if (typeof doc.id !== "string" || !pat.test(doc.id)) {
    return `${kind} needs an \`id\` matching ${pat} (got "${String(doc.id ?? "missing")}")`;
  }
  if (kind !== "composite" && !str(doc.name)) return `${kind} ${doc.id} needs a non-empty \`name\``;
  return null;
}

// ---------- hashing / identity ----------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = stable((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** Hash of the raw text, byte-for-byte. */
export const rawHash = (text: string): string => sha256Hex(text);

/**
 * Hash of the parsed documents (key order / whitespace / quoting ignored).
 * Null when the text does not parse — invalid files never reach here.
 */
export function canonHash(text: string): string | null {
  const { docs, error } = parseScriptText(text);
  if (error) return null;
  return sha256Hex(JSON.stringify(stable(docs)));
}

/** Collapse whitespace for verbatim-inclusion tests (Part C render rule). */
const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Group-by append: replaces the has/get/push triple. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/** Docs keyed by doc key (last wins; duplicates are a lint error anyway). */
function keyed(docs: ScriptDoc[]): Map<string, ScriptDoc> {
  const m = new Map<string, ScriptDoc>();
  for (const d of docs) {
    const k = docKey(d);
    if (k) m.set(k, d);
  }
  return m;
}

/** Stable per-doc key for overlap/diff. */
function docKey(doc: ScriptDoc): string | null {
  if (doc.kind === "package_meta") return "package_meta:meta";
  if (doc.kind === "chunk_header") return `chunk_header:part-${String(doc.part ?? "?")}`;
  if (doc.kind === "shot") return `shot:${String(doc.id)}`;
  return typeof doc.id === "string" ? `${doc.kind}:${doc.id}` : null;
}

export function docKeys(docs: ScriptDoc[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    const k = docKey(d);
    if (k) out.add(k);
  }
  return out;
}

export interface DocChange {
  key: string;
  fields: string[];
  added?: boolean;
  removed?: boolean;
}

/** Field-level diff of two doc sets, keyed by doc key. */
export function diffDocs(oldDocs: ScriptDoc[], newDocs: ScriptDoc[]): DocChange[] {
  const oldByKey = keyed(oldDocs);
  const newByKey = keyed(newDocs);
  const changes: DocChange[] = [];
  for (const [key, ndoc] of newByKey) {
    const odoc = oldByKey.get(key);
    if (!odoc) {
      changes.push({ key, fields: [], added: true });
      continue;
    }
    const fields = Object.keys(ndoc).filter(
      (f) => JSON.stringify(stable(ndoc[f])) !== JSON.stringify(stable(odoc[f])),
    );
    if (fields.length) changes.push({ key, fields: fields.sort() });
  }
  for (const key of oldByKey.keys()) {
    if (!newByKey.has(key)) changes.push({ key, fields: [], removed: true });
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

// ---------- file roles (from kinds present, never the filename) ----------

export type FileRole = "single" | "bible" | "calls" | "chunk" | "entities" | "shots";

export function fileRole(docs: ScriptDoc[]): FileRole {
  const kinds = new Set(docs.map((d) => d.kind));
  const hasMeta = kinds.has("package_meta");
  const hasCalls = kinds.has("call");
  const hasChunk = kinds.has("chunk_header");
  if (hasMeta && hasCalls) return "single";
  if (hasChunk) return "chunk";
  if (hasCalls) return "calls";
  if (hasMeta) return "bible";
  if (kinds.has("shot")) return "shots";
  return "entities";
}

// ---------- view builder (one server function, derived on read) ----------

export interface ViewFile {
  id: string;
  filename: string;
  role: FileRole;
  docs: number;
  calls: number;
  entities: number;
}

export type EntityKind = "character" | "location" | "prop" | "composite";

export interface EntityView {
  kind: EntityKind;
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

export interface ShotView {
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

export interface CallView extends ScriptDoc {
  fileId: string;
  filename: string;
  startS: number;
  endS: number;
  summary: string;
  /** Paste-ready prompt per the Part C render rule: placeholders replaced
   *  with log actuals when present, else the planned field. */
  renderedPrompt: string;
  renderSource: "actual" | "planned" | "missing" | "na";
}

export interface SceneView {
  n: number;
  title: string;
  shotIds: number[];
  callIds: string[];
  plannedS: number;
  footageS: number;
  startS: number;
  endS: number;
}

export interface CheckItem {
  code: string;
  severity: "error" | "warn" | "info";
  callId?: string;
  entityId?: string;
  message: string;
}

export interface ScriptDetail {
  script: { id: string; title: string; updatedAt: string };
  files: ViewFile[];
  meta: Record<string, unknown> | null;
  entities: EntityView[];
  shots: ShotView[];
  calls: CallView[];
  scenes: SceneView[];
  index: Record<string, { calls: string[]; shots: number[] }>;
  checks: CheckItem[];
  totals: { footageS: number; plannedS: number; targetS: number | null; scenes: number; shots: number; calls: number };
}

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");
const asStrArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const asNumArr = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : [];

/** First sentence of the prompt — the skill defines no call summary field.
 *  Template scaffolding is skipped: a bare `CONTINUE/CARRY: {{…}}` line
 *  carries no story content, and stray placeholders never leak through. */
function firstSentence(prompt: string): string {
  const cleaned = prompt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[A-Z]+:\s*\{\{[^}]*\}\}$/.test(l))
    .join(" ")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = cleaned.split(/(?<=[.!?])\s/)[0]?.trim() ?? "";
  const s = cut || cleaned.slice(0, 90);
  return s.length > 120 ? `${s.slice(0, 117).trimEnd()}…` : s;
}

/**
 * Part C render rule: before a prompt is handed over, replace
 * `{{continues_from}}` / `{{anchor_from}}` with the log's actuals when
 * present, else the planned field (whitespace collapsed). Unfillable
 * placeholders are left in place and reported as "missing".
 */
function renderPrompt(
  call: ScriptDoc,
  log: ScriptDoc | undefined,
): { text: string; source: "actual" | "planned" | "missing" | "na" } {
  let text = asStr(call.prompt);
  const sources: ("actual" | "planned" | "missing")[] = [];
  const fill = (token: "{{continues_from}}" | "{{anchor_from}}", actual: unknown, planned: unknown) => {
    if (!text.includes(token)) return;
    const a = asStr(actual).trim();
    const p = norm(asStr(planned));
    if (a) {
      text = text.replaceAll(token, a);
      sources.push("actual");
    } else if (p) {
      text = text.replaceAll(token, p);
      sources.push("planned");
    } else {
      sources.push("missing");
    }
  };
  const l = (log ?? {}) as Record<string, unknown>;
  fill("{{continues_from}}", l.continues_from_actual, call.continues_from);
  fill("{{anchor_from}}", l.anchor_from_actual, call.anchor_from);
  const source = sources.includes("missing") ? "missing" : sources.includes("actual") ? "actual" : sources.includes("planned") ? "planned" : "na";
  return { text, source };
}

export function buildScriptView(
  script: { id: string; title: string; updatedAt: string },
  files: { id: string; filename: string; raw: string }[],
): ScriptDetail {
  const parsed = files.map((f) => ({ file: f, docs: parseScriptText(f.raw).docs }));
  const metaDoc = parsed.flatMap((p) => p.docs).find((d) => d.kind === "package_meta") ?? null;
  const meta = metaDoc ? { ...(metaDoc as Record<string, unknown>) } : null;

  const names = new Map<string, string>();
  for (const { docs } of parsed) {
    for (const d of docs) {
      if ((d.kind === "character" || d.kind === "location" || d.kind === "prop") && typeof d.id === "string") {
        names.set(d.id, asStr(d.name) || d.id);
      }
    }
  }

  const entities: EntityView[] = [];
  for (const { docs } of parsed) {
    for (const d of docs) {
      if (d.kind !== "character" && d.kind !== "location" && d.kind !== "prop" && d.kind !== "composite") continue;
      const id = String(d.id ?? "");
      // Composites carry no name field — display their member names.
      const name =
        asStr(d.name) ||
        (d.kind === "composite" ? asStrArr(d.contains).map((m) => names.get(m) ?? m).join(" + ") : "") ||
        id;
      entities.push({
        kind: d.kind,
        id,
        name,
        lockVersion: typeof d.lock_version === "number" ? d.lock_version : null,
        variantOf: asStr(d.variant_of),
        appearsInShots: asNumArr(d.appears_in_shots),
        usedInShots: asNumArr(d.used_in_shots),
        identity: asStr(d.identity),
        sideDetail: asStr(d.side_detail),
        voice: asStr(d.voice),
        personality: asStr(d.personality),
        light: asStr(d.light),
        holderPath: asStr(d.holder_path),
        stateChanges: asStr(d.state_changes),
        contains: asStrArr(d.contains),
        binding: asStr(d.binding),
        why: asStr(d.why),
        adhoc: d.adhoc === true,
        imagePrompt: asStr(d.image_prompt),
        negativePrompt: asStr(d.negative_prompt),
      });
    }
  }

  const calls: CallView[] = [];
  let t = 0;
  const callLogById = new Map<string, ScriptDoc>();
  for (const { docs } of parsed) {
    for (const d of docs) {
      if (d.kind === "call_log" && typeof d.id === "string") callLogById.set(d.id, d);
    }
  }
  for (const { file, docs } of parsed) {
    for (const d of docs) {
      if (d.kind !== "call") continue;
      const dur = typeof d.dur === "number" ? d.dur : 0;
      const prompt = asStr(d.prompt);
      const rendered = renderPrompt(d, callLogById.get(String(d.id)));
      calls.push({ ...d, fileId: file.id, filename: file.filename, startS: t, endS: t + dur, summary: firstSentence(prompt), renderedPrompt: rendered.text, renderSource: rendered.source });
      t += dur;
    }
  }

  // Shots come from kind: shot documents; calls attach by shot id. A call
  // whose shot doc is missing still renders (synthesized entry) while the
  // lint flags it.
  const shotDocs = new Map<number, ScriptDoc>();
  for (const { docs } of parsed) {
    for (const d of docs) {
      if (d.kind === "shot" && typeof d.id === "number") shotDocs.set(d.id, d);
    }
  }
  const shotLines = (d: ScriptDoc | undefined): ShotLine[] => {
    if (!d || !Array.isArray(d.lines)) return [];
    return (d.lines as unknown[]).flatMap((l) =>
      l && typeof l === "object"
        ? [{ id: asStr((l as Record<string, unknown>).id), who: asStr((l as Record<string, unknown>).who), text: asStr((l as Record<string, unknown>).text) }]
        : [],
    );
  };
  const callsByShot = new Map<number, CallView[]>();
  for (const c of calls) pushTo(callsByShot, c.shot as number, c);
  const shotIds = [...new Set([...shotDocs.keys(), ...callsByShot.keys()])].sort((a, b) => a - b);
  const shots: ShotView[] = shotIds.map((n) => {
    const d = shotDocs.get(n);
    const cs = (callsByShot.get(n) ?? []).sort((a, b) => (a.pos as number) - (b.pos as number));
    const footage = cs.reduce((a, c) => a + (typeof c.dur === "number" ? c.dur : 0), 0);
    return {
      id: n,
      scene: typeof d?.scene === "number" ? d.scene : 0,
      beat: asStr(d?.beat),
      plannedS: typeof d?.planned_s === "number" ? d.planned_s : footage,
      footageS: footage,
      location: asStr(d?.location),
      characters: asStrArr(d?.characters),
      props: asStrArr(d?.props),
      lines: shotLines(d),
      callIds: cs.map((c) => String(c.id)),
      startS: cs.length ? Math.min(...cs.map((c) => c.startS)) : 0,
      endS: cs.length ? Math.max(...cs.map((c) => c.endS)) : 0,
    };
  });

  const sceneGroups = new Map<number, ShotView[]>();
  for (const s of shots) pushTo(sceneGroups, s.scene, s);
  const scenes: SceneView[] = [...sceneGroups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, ss]) => ({
      n,
      title: `Scene ${n}`,
      shotIds: ss.map((s) => s.id),
      callIds: ss.flatMap((s) => s.callIds),
      plannedS: ss.reduce((a, s) => a + s.plannedS, 0),
      footageS: ss.reduce((a, s) => a + s.footageS, 0),
      startS: ss.length ? Math.min(...ss.map((s) => s.startS)) : 0,
      endS: ss.length ? Math.max(...ss.map((s) => s.endS)) : 0,
    }));

  // Reverse index: entity id → calls (+ shots) that mention it.
  const index: Record<string, { calls: string[]; shots: number[] }> = {};
  const touchShot = (id: string, shotId: number) => {
    if (!id) return;
    const entry = (index[id] ??= { calls: [], shots: [] });
    if (!entry.shots.includes(shotId)) entry.shots.push(shotId);
  };
  const touch = (id: string, call: CallView) => {
    if (!id) return;
    const entry = (index[id] ??= { calls: [], shots: [] });
    const cid = String(call.id);
    // An entity can fill two slots in one call — index it once.
    if (!entry.calls.includes(cid)) entry.calls.push(cid);
    touchShot(id, call.shot as number);
  };
  for (const c of calls) {
    for (const id of [...asStrArr(c.characters), ...asStrArr(c.props), ...asStrArr(c.refs)]) touch(id, c);
  }
  for (const s of shots) {
    touchShot(s.location, s.id);
    for (const id of [...s.characters, ...s.props]) touchShot(id, s.id);
  }
  for (const k of Object.keys(index)) (index[k] as { shots: number[] }).shots.sort((a, b) => a - b);

  const viewFiles: ViewFile[] = parsed.map(({ file, docs }) => ({
    id: file.id,
    filename: file.filename,
    role: fileRole(docs),
    docs: docs.length,
    calls: docs.filter((d) => d.kind === "call").length,
    entities: docs.filter((d) => d.kind === "character" || d.kind === "location" || d.kind === "prop" || d.kind === "composite").length,
  }));

  const targetS = typeof meta?.target_runtime_s === "number" ? meta.target_runtime_s : null;
  const totals = {
    footageS: t,
    plannedS: shots.reduce((a, s) => a + s.plannedS, 0),
    targetS,
    scenes: scenes.length,
    shots: shots.length,
    calls: calls.length,
  };

  return {
    script,
    files: viewFiles,
    meta,
    entities,
    shots,
    calls,
    scenes,
    index,
    checks: runChecks(meta, entities, shots, calls, parsed.map((p) => ({ fileId: p.file.id, filename: p.file.filename, docs: p.docs }))),
    totals,
  };
}

// ---------- Part C lint checks that can be decided from the data alone ----------

const LOCK_FIELDS = ["name", "locked_date", "base_clip_s", "extend_increment_s", "chain_soft_s", "chain_hard_s", "chain_cap_s", "max_reference_images", "max_prompt_chars"];

function runChecks(
  meta: Record<string, unknown> | null,
  entities: EntityView[],
  shots: ShotView[],
  calls: CallView[],
  files: { fileId: string; filename: string; docs: ScriptDoc[] }[],
): CheckItem[] {
  const checks: CheckItem[] = [];
  const lock = (meta?.model_lock ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fb: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  const base = num(lock.base_clip_s, 8);
  const ext = num(lock.extend_increment_s, 7);
  const soft = num(lock.chain_soft_s, 22);
  const hard = num(lock.chain_hard_s, 29);
  const maxRefs = num(lock.max_reference_images, 3);
  const maxChars = num(lock.max_prompt_chars, 4000);
  const wps = num(lock.words_per_sec, 2.5);
  const empty = (v: unknown) => v == null || (typeof v === "string" && !v.trim());

  // 1. Package: exactly one meta with a complete lock; unique ids; refs exist.
  const metas = files.flatMap((f) => f.docs).filter((d) => d.kind === "package_meta");
  if (metas.length !== 1) {
    checks.push({ code: "package_meta_count", severity: "error", message: `Package has ${metas.length} package_meta documents (exactly one required)` });
  }
  if (meta) {
    const missing = LOCK_FIELDS.filter((f) => lock[f] == null);
    if (missing.length) {
      checks.push({ code: "model_lock_incomplete", severity: "error", message: `model_lock is missing ${missing.join(", ")}` });
    }
  }

  const entityIds = new Set(entities.map((e) => e.id));
  const callById = new Map(calls.map((c) => [String(c.id), c]));
  const callIds = new Set(callById.keys());
  const shotById = new Map(shots.map((s) => [s.id, s]));
  const compositeIds = new Set(entities.filter((e) => e.kind === "composite").map((e) => e.id));

  const seen = new Map<string, number>();
  for (const { docs } of files) {
    for (const d of docs) {
      const k = docKey(d);
      if (!k || k.startsWith("package_meta")) continue;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of [...seen.entries()].sort()) {
    if (n > 1) checks.push({ code: "duplicate_id", severity: "error", message: `${k} is defined ${n}× — only the last one is shown` });
  }

  // 2. Entities: lock_version integer; image prompts carry the lock verbatim.
  const byId = new Map(entities.map((e) => [e.id, e]));
  for (const e of entities) {
    if (e.lockVersion == null || !Number.isInteger(e.lockVersion)) {
      checks.push({ code: "lock_version", severity: "error", entityId: e.id, message: `${e.id} needs an integer lock_version` });
    }
    if (e.kind === "character") {
      if (!e.identity || !e.sideDetail || !e.voice) {
        checks.push({ code: "character_incomplete", severity: "error", entityId: e.id, message: `${e.id} needs identity, side_detail and voice` });
      }
      const img = norm(e.imagePrompt);
      if (e.identity && !img.includes(norm(e.identity))) {
        checks.push({ code: "image_prompt_drift", severity: "error", entityId: e.id, message: `${e.id} image_prompt does not contain the identity verbatim` });
      }
      if (e.sideDetail && !img.includes(norm(e.sideDetail))) {
        checks.push({ code: "image_prompt_drift", severity: "error", entityId: e.id, message: `${e.id} image_prompt does not contain the side_detail verbatim` });
      }
      if (e.identity.length > 400) {
        checks.push({ code: "identity_long", severity: "warn", entityId: e.id, message: `${e.id} identity is ${e.identity.length} chars (keep ≤ ~400)` });
      }
    }
    if (e.kind === "location" && e.identity && !norm(e.imagePrompt).includes(norm(e.identity))) {
      checks.push({ code: "image_prompt_drift", severity: "error", entityId: e.id, message: `${e.id} image_prompt does not contain the identity verbatim` });
    }
    if (e.kind === "composite") {
      if (e.contains.length < 2) {
        checks.push({ code: "composite_members", severity: "error", entityId: e.id, message: `${e.id} needs 2+ members` });
      }
      if (e.contains.length > 3) {
        checks.push({ code: "composite_members", severity: "warn", entityId: e.id, message: `${e.id} has ${e.contains.length} members (keep 2–3)` });
      }
      if (!e.binding.trim()) {
        checks.push({ code: "composite_binding", severity: "error", entityId: e.id, message: `${e.id} needs an explicit binding` });
      }
      const img = norm(e.imagePrompt);
      for (const m of e.contains) {
        const member = byId.get(m);
        if (!member) {
          checks.push({ code: "unknown_entity", severity: "error", entityId: e.id, message: `${e.id} contains undefined ${m}` });
          continue;
        }
        if (member.identity && !img.includes(norm(member.identity))) {
          checks.push({ code: "image_prompt_drift", severity: "error", entityId: e.id, message: `${e.id} image_prompt does not contain ${m}'s identity verbatim` });
        }
        if (member.sideDetail && !img.includes(norm(member.sideDetail))) {
          checks.push({ code: "image_prompt_drift", severity: "error", entityId: e.id, message: `${e.id} image_prompt does not contain ${m}'s side_detail verbatim` });
        }
      }
      if (!e.adhoc && e.usedInShots.length < 2) {
        checks.push({ code: "composite_unused", severity: "warn", entityId: e.id, message: `${e.id} is used in fewer than 2 shots` });
      }
    }
  }

  // 3. Shots: calls exist, pos runs 1..of, count cap, footage covers planned.
  const maxCalls = 1 + Math.floor((hard - base) / ext);
  const byShot = new Map<number, CallView[]>();
  for (const c of calls) pushTo(byShot, c.shot as number, c);
  for (const s of shots) {
    const cs = [...(byShot.get(s.id) ?? [])].sort((a, b) => (a.pos as number) - (b.pos as number));
    if (!cs.length) {
      checks.push({ code: "shot_without_calls", severity: "error", message: `Shot ${s.id} has no calls` });
      continue;
    }
    const of = cs[0]?.of as number;
    if (cs.some((c, i) => (c.pos as number) !== i + 1) || cs.some((c) => (c.of as number) !== of) || cs.length !== of) {
      checks.push({ code: "chain_order_break", severity: "error", message: `Shot ${s.id} positions don't run 1..${of}` });
    }
    if (of > maxCalls) {
      checks.push({ code: "chain_too_long", severity: "error", message: `Shot ${s.id} needs ${of} calls (max ${maxCalls} at this lock) — split the shot` });
    }
    if (s.footageS < s.plannedS) {
      checks.push({ code: "footage_short", severity: "error", message: `Shot ${s.id} footage ${s.footageS}s is under planned ${s.plannedS}s` });
    }
    const needed = s.plannedS <= base ? 1 : 1 + Math.ceil((s.plannedS - base) / ext);
    if (s.footageS - s.plannedS > 4 || of > needed) {
      checks.push({ code: "shot_slack", severity: "warn", message: `Shot ${s.id} has ${s.footageS - s.plannedS}s slack over ${s.plannedS}s planned` });
    }
    const loc = s.location;
    if (loc && !entityIds.has(loc)) {
      checks.push({ code: "unknown_entity", severity: "error", message: `Shot ${s.id} uses undefined location ${loc}` });
    }
    for (const id of [...s.characters, ...s.props]) {
      if (!entityIds.has(id)) {
        checks.push({ code: "unknown_entity", severity: "error", message: `Shot ${s.id} lists undefined ${id}` });
      }
    }
  }
  for (const [shotId] of byShot) {
    if (!shotById.has(shotId)) {
      checks.push({ code: "call_without_shot", severity: "error", message: `Calls reference shot ${shotId} with no shot document` });
    }
  }

  // 4–6. Calls. Previous shot's scene per shot id (cut-inside-scene check).
  const prevSceneByShot = new Map<number, number>();
  let lastScene: number | null = null;
  for (const s of [...shots].sort((a, b) => a.id - b.id)) {
    if (lastScene != null) prevSceneByShot.set(s.id, lastScene);
    lastScene = s.scene;
  }
  for (const c of calls) {
    const id = String(c.id);
    const pos = c.pos as number;
    const of = c.of as number;
    const dur = typeof c.dur === "number" ? c.dur : 0;
    const prompt = norm(asStr(c.prompt));
    // The cap applies to the handed-over (rendered) prompt, not the template.
    if (c.renderedPrompt.length > maxChars) {
      checks.push({
        code: "prompt_too_long", severity: "error", callId: id,
        message: `${id} rendered prompt is ${c.renderedPrompt.length.toLocaleString()} chars (limit ${maxChars.toLocaleString()})`,
      });
    }
    if (pos < of && empty(c.ends_at)) {
      checks.push({ code: "missing_ends_at", severity: "error", callId: id, message: `${id} is call ${pos} of ${of} but states no ends_at boundary` });
    }
    if (pos === of && !empty(c.ends_at)) {
      checks.push({ code: "final_ends_at_set", severity: "error", callId: id, message: `${id} is the chain's last call but still sets ends_at` });
    }
    const refs = asStrArr(c.refs);
    if (refs.length > maxRefs) {
      checks.push({ code: "too_many_references", severity: "error", callId: id, message: `${id} attaches ${refs.length} references (max ${maxRefs})` });
    }
    for (const r of [...refs, ...asStrArr(c.characters), ...asStrArr(c.props)]) {
      if (!entityIds.has(r)) {
        checks.push({ code: "unknown_entity", severity: "error", callId: id, message: `${id} mentions undefined ${r}` });
      }
    }
    // chain_risk derives from cumulative footage after this call.
    const cumulative = base + ext * (pos - 1);
    const expectedRisk = cumulative >= hard ? "hard_stop" : cumulative >= soft ? "monitor" : "none";
    if (asStr(c.chain_risk) !== expectedRisk) {
      checks.push({ code: "chain_risk_mismatch", severity: "error", callId: id, message: `${id} chain_risk is "${asStr(c.chain_risk) || "missing"}" but ${cumulative}s of footage derives "${expectedRisk}"` });
    }
    if (c.mode === "extend") {
      if (dur !== ext) {
        checks.push({ code: "call_duration", severity: "error", callId: id, message: `${id} extend dur is ${dur}s (lock says ${ext}s)` });
      }
      if (empty(c.continues_from)) {
        checks.push({ code: "missing_continues_from", severity: "error", callId: id, message: `${id} extends the chain but has no continues_from` });
      } else if (!prompt.includes("{{continues_from}}")) {
        checks.push({ code: "placeholder_missing", severity: "error", callId: id, message: `${id} prompt never renders its {{continues_from}}` });
      }
      if (refs.length > 0) {
        checks.push({ code: "extend_has_references", severity: "error", callId: id, message: `${id} is an extend call but carries ${refs.length} reference(s)` });
      }
      if (!empty(c.seed_from) || !empty(c.anchor_from)) {
        checks.push({ code: "extend_with_anchor", severity: "error", callId: id, message: `${id} is extend but sets seed_from/anchor_from` });
      }
      const chain = [...(byShot.get(c.shot as number) ?? [])].sort((a, b) => (a.pos as number) - (b.pos as number));
      const prev = chain[pos - 2];
      if (!prev || String(prev.id) !== String(c.chained_from)) {
        checks.push({ code: "dangling_chain", severity: "error", callId: id, message: `${id} chained_from ${String(c.chained_from ?? "nothing")} is not the previous call in shot ${c.shot}` });
      }
      if (empty(c.chained_from)) {
        checks.push({ code: "dangling_chain", severity: "error", callId: id, message: `${id} is extend but chained_from is empty` });
      }
      // Extend prompts restate no identity; new cast mid-chain is flagged.
      const prevChars = prev ? asStrArr(prev.characters) : [];
      for (const m of asStrArr(c.characters)) {
        const member = byId.get(m);
        if (member?.identity && prompt.includes(norm(member.identity))) {
          checks.push({ code: "extend_restates_identity", severity: "error", callId: id, message: `${id} restates ${m}'s full identity (extends stay lean)` });
        }
        if (prev && !prevChars.includes(m)) {
          checks.push({ code: "new_cast_mid_chain", severity: "warn", callId: id, message: `${id} introduces ${m}, absent from the previous call` });
        }
      }
    } else {
      // Opening calls (reference-to-video / frame-to-video).
      if (dur !== base) {
        checks.push({ code: "call_duration", severity: "error", callId: id, message: `${id} opening dur is ${dur}s (lock says ${base}s)` });
      }
      if (pos !== 1) {
        checks.push({ code: "chain_order_break", severity: "error", callId: id, message: `${id} is ${c.mode} at pos ${pos} (only pos 1 opens)` });
      }
      if (!empty(c.chained_from) || !empty(c.continues_from)) {
        checks.push({ code: "opener_with_chain", severity: "error", callId: id, message: `${id} opens the chain but sets chained_from/continues_from` });
      }
      if (c.mode === "frame-to-video") {
        if (empty(c.seed_from)) {
          checks.push({ code: "missing_seed_from", severity: "error", callId: id, message: `${id} is frame-to-video but names no seed_from` });
        } else if (!callIds.has(String(c.seed_from)) && !compositeIds.has(String(c.seed_from))) {
          checks.push({ code: "dangling_chain", severity: "error", callId: id, message: `${id} seeds from unknown ${String(c.seed_from)}` });
        }
        if (empty(c.anchor_from)) {
          checks.push({ code: "missing_anchor_from", severity: "error", callId: id, message: `${id} re-anchors but names no anchor_from state` });
        } else if (!prompt.includes("{{anchor_from}}")) {
          checks.push({ code: "placeholder_missing", severity: "error", callId: id, message: `${id} prompt never renders its {{anchor_from}}` });
        }
      } else {
        if (!empty(c.seed_from)) {
          checks.push({ code: "seed_off_mode", severity: "error", callId: id, message: `${id} sets seed_from outside frame-to-video` });
        }
        // reference-to-video cut inside a scene with no anchor_from (warn).
        if (empty(c.anchor_from)) {
          const scene = shotById.get(c.shot as number)?.scene;
          if (scene && scene === prevSceneByShot.get(c.shot as number)) {
            checks.push({ code: "cut_without_anchor", severity: "warn", callId: id, message: `${id} cuts inside scene ${scene} with no anchor_from` });
          }
        } else if (!prompt.includes("{{anchor_from}}")) {
          checks.push({ code: "placeholder_missing", severity: "error", callId: id, message: `${id} prompt never renders its {{anchor_from}}` });
        }
      }
    }
  }

  // 7. Dialogue: every shot line covered exactly once, verbatim, in budget.
  for (const s of shots) {
    const covered = new Map<string, string[]>();
    for (const cid of s.callIds) {
      for (const lid of asStrArr(callById.get(cid)?.dialogue)) pushTo(covered, lid, cid);
    }
    for (const line of s.lines) {
      const hits = covered.get(line.id) ?? [];
      if (!hits.length) {
        checks.push({ code: "line_uncovered", severity: "error", message: `Shot ${s.id} line ${line.id} is covered by no call` });
      } else if (hits.length > 1) {
        checks.push({ code: "line_covered_twice", severity: "error", message: `Shot ${s.id} line ${line.id} is covered by ${hits.join(", ")}` });
      } else {
        const call = callById.get(hits[0] as string);
        if (call && line.text && !norm(asStr(call.prompt)).includes(norm(line.text))) {
          checks.push({ code: "line_not_verbatim", severity: "error", callId: String(call.id), message: `${String(call.id)} does not carry ${line.id} verbatim` });
        }
      }
    }
    for (const [lid, hits] of covered) {
      if (!s.lines.some((l) => l.id === lid)) {
        checks.push({ code: "line_unknown", severity: "error", message: `Shot ${s.id} dialogue ${lid} (${hits.join(", ")}) is no line of the shot` });
      }
    }
    for (const cid of s.callIds) {
      const call = callById.get(cid);
      if (!call) continue;
      const words = asStrArr(call.dialogue).reduce((a, lid) => {
        const line = s.lines.find((l) => l.id === lid);
        return a + (line ? line.text.split(/\s+/).filter(Boolean).length : 0);
      }, 0);
      const budget = Math.floor(num(call.dur, 0) * wps * 0.8);
      if (words > budget) {
        checks.push({ code: "dialogue_over_budget", severity: "warn", callId: cid, message: `${cid} carries ${words} dialogue words (budget ${budget})` });
      }
    }
  }

  // 8. Files: chains never cross a file boundary; files stay small.
  const fileOf = new Map<string, string>();
  for (const { fileId, docs } of files) {
    for (const d of docs) {
      if (d.kind === "call") fileOf.set(String(d.id), fileId);
    }
  }
  for (const c of calls) {
    for (const target of [c.chained_from, c.seed_from]) {
      if (!empty(target) && typeof target === "string" && !compositeIds.has(target)) {
        const other = fileOf.get(target);
        if (other && other !== c.fileId) {
          checks.push({ code: "chain_split_across_files", severity: "error", callId: String(c.id), message: `${String(c.id)} links to ${target} in another file — never split mid-chain` });
        }
      }
    }
  }
  for (const { filename, docs } of files) {
    const n = docs.filter((d) => d.kind === "call").length;
    if (n > 30) {
      checks.push({ code: "file_too_big", severity: "warn", message: `${filename} holds ${n} calls (keep ~20–25 per chunk)` });
    }
  }

  // 9. Totals.
  const totals = (meta?.totals ?? {}) as Record<string, unknown>;
  const sceneCount = new Set(shots.map((s) => s.scene)).size;
  if (meta) {
    if (totals.shots !== shots.length || totals.scenes !== sceneCount || totals.calls !== calls.length) {
      checks.push({ code: "totals_mismatch", severity: "error", message: `totals ${totals.shots}/${totals.scenes}/${totals.calls} (shots/scenes/calls) don't match ${shots.length}/${sceneCount}/${calls.length}` });
    }
    const cost = (meta.cost_estimate ?? {}) as Record<string, unknown>;
    if (typeof cost.calls_raw === "number" && cost.calls_raw !== calls.length) {
      checks.push({ code: "calls_raw_mismatch", severity: "error", message: `cost_estimate.calls_raw is ${cost.calls_raw} but the package holds ${calls.length} call documents` });
    }
    const rate = typeof cost.first_pass_rate === "number" && cost.first_pass_rate > 0 ? cost.first_pass_rate : 0.5;
    if (typeof cost.calls_projected === "number" && cost.calls_projected !== Math.ceil(calls.length / rate)) {
      checks.push({ code: "calls_projected_mismatch", severity: "error", message: `calls_projected should be ceil(${calls.length}/${rate}) = ${Math.ceil(calls.length / rate)}` });
    }
    if (typeof cost.asset_images_raw === "number" && cost.asset_images_raw !== 3 * entities.length) {
      checks.push({ code: "asset_images_mismatch", severity: "warn", message: `asset_images_raw should be 3 × ${entities.length} entities` });
    }
    if (typeof meta.target_runtime_s === "number" && meta.target_runtime_s > 0) {
      const planned = shots.reduce((a, s) => a + s.plannedS, 0);
      if (Math.abs(planned - meta.target_runtime_s) / meta.target_runtime_s > 0.1) {
        checks.push({ code: "planned_off_target", severity: "error", message: `Shots plan ${planned}s, ${Math.round((Math.abs(planned - meta.target_runtime_s) / meta.target_runtime_s) * 100)}% off the ${meta.target_runtime_s}s target` });
      }
      const footage = calls.reduce((a, c) => a + (typeof c.dur === "number" ? c.dur : 0), 0);
      if (footage > meta.target_runtime_s * 1.25) {
        checks.push({ code: "footage_over_target", severity: "warn", message: `Footage sums to ${footage}s (over 125% of target)` });
      }
    }
  }
  if ((calls.length > 0 || shots.length > 0) && !meta) {
    checks.push({ code: "missing_bible", severity: "error", message: "Shots/calls exist but no package_meta bible file is committed" });
  }

  // 10. Production log checks (only when log documents are present).
  const assetLogs = files.flatMap((f) => f.docs).filter((d) => d.kind === "asset_log");
  const callLogs = files.flatMap((f) => f.docs).filter((d) => d.kind === "call_log");
  for (const l of assetLogs) {
    const e = byId.get(String(l.id));
    if (!e) {
      checks.push({ code: "log_unknown_id", severity: "error", message: `asset_log ${String(l.id)} matches no entity` });
    } else if (typeof l.lock_version === "number" && e.lockVersion != null && l.lock_version !== e.lockVersion) {
      checks.push({ code: "log_lock_stale", severity: "error", entityId: e.id, message: `${e.id} relocked to v${e.lockVersion} but the asset log pins v${l.lock_version} — regenerate` });
    }
  }
  for (const l of callLogs) {
    const id = String(l.id);
    const call = callById.get(id);
    if (!call) {
      checks.push({ code: "log_unknown_id", severity: "error", message: `call_log ${id} matches no call` });
      continue;
    }
    const used = (l.locks_used ?? {}) as Record<string, unknown>;
    for (const [eid, v] of Object.entries(used)) {
      const e = byId.get(eid);
      if (e?.lockVersion != null && typeof v === "number" && v !== e.lockVersion) {
        checks.push({ code: "log_lock_stale", severity: "warn", callId: id, message: `${id} was generated with ${eid} v${v}, now v${e.lockVersion} — stale` });
      }
    }
    const attempts = typeof l.attempts === "number" ? l.attempts : 0;
    if (attempts > 3 && asStr(l.decision) !== "escalate") {
      checks.push({ code: "log_attempts", severity: "warn", callId: id, message: `${id} took ${attempts} attempts without escalation` });
    }
    const qc = (l.qc ?? {}) as Record<string, unknown>;
    const anchored = call.mode === "extend" || (call.mode === "frame-to-video" && !empty(call.seed_from));
    if (asStr(l.decision) === "accept") {
      if (anchored && !["match", "drift"].includes(asStr(qc.boundary))) {
        checks.push({ code: "log_boundary", severity: "error", callId: id, message: `${id} accepted with no boundary match|drift recorded` });
      }
      if (asStr(qc.boundary) === "drift") {
        checks.push({ code: "log_boundary", severity: "warn", callId: id, message: `${id} accepted on drifted boundary` });
      }
      for (const f of ["binding", "speaker", "duration"] as const) {
        if (asStr(qc[f]) === "fail") {
          checks.push({ code: "log_qc_fail", severity: "error", callId: id, message: `${id} accepted with failed ${f} QC` });
        }
      }
      for (const m of asStrArr(call.characters)) {
        if (!assetLogs.some((a) => String(a.id) === m)) {
          checks.push({ code: "log_missing_asset", severity: "warn", callId: id, message: `${id} accepted while ${m} has no asset_log` });
        }
      }
    }
  }
  return checks;
}

export function checkFileSize(text: string): string | null {
  return text.length > MAX_FILE_CHARS ? `file is ${(text.length / 1e6).toFixed(1)} MB (max 2 MB)` : null;
}

export const MAX_COMMIT_FILES = 12;
