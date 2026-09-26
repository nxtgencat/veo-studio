// Full backup & restore (plain tar via Bun.Archive).
// Deliberately UNCOMPRESSED: payloads are mp4s that gzip can't shrink
// (measured: 21s gzipped vs 1s plain on ~1 GB, same bytes out). gzip also
// pushed archives over the restore cap and outlasted the server idle timeout,
// which surfaced as proxy socket hang-ups on full backups.
// Scope toggles — projects + settings always included:
//   elements: element rows (images are inline data-URLs already)
//   generated: library rows (model != import) + terminal jobs + their media
//   uploads: library rows (model = import) + their media files
// Restore merges with INSERT OR IGNORE (existing IDs are skipped, reported).
//
// Memory discipline (measured on a ~1 GB library): Bun.Archive is
// buffer-in/buffer-out by design — no streaming input exists upstream — so
// the file-based paths below are the efficient shape: uploads stream to disk,
// builds stream to disk via Archive.write, downloads stream from disk, and
// only one direction ever holds a full copy. Peak ≈ 1× file instead of 2-3×.

import { getDb } from "./db.ts";
import { extForMime, importMediaFile } from "./media-store.ts";
import { childLogger } from "./logger.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

const log = childLogger({ module: "backup" });

export const BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

export interface BackupOptions {
  elements: boolean;
  generated: boolean;
  uploads: boolean;
  /** Optional: scope the whole archive to one project (the >1 GB answer). */
  projectId?: string;
}

function backupTmpRoot(): string {
  const d = join(tmpdir(), "veo-backup");
  mkdirSync(d, { recursive: true });
  return d;
}

/** Unique temp path (caller appends extension as needed). */
export function backupTmpPath(kind: "build" | "upload" | "restore"): string {
  return join(backupTmpRoot(), `${kind}-${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`);
}

/** Best-effort cleanup of our temp files (crash leftovers, served downloads). */
export function sweepBackupTmp(maxAgeMs = 30 * 60 * 1000): void {
  try {
    const root = backupTmpRoot();
    const now = Date.now();
    for (const f of readdirSync(root)) {
      if (!/^(build|upload|restore)-/.test(f)) continue;
      const p = join(root, f);
      try {
        const st = statSync(p);
        const age = now - st.mtimeMs;
        const gone = st.isDirectory()
          ? readdirSync(p).length === 0 || age > maxAgeMs
          : age > maxAgeMs;
        if (gone) rmSync(p, { recursive: true, force: true });
      } catch { /* racing delete */ }
    }
  } catch { /* tmp missing — nothing to do */ }
}

export function removeBackupTmp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch { /* already gone */ }
}

export interface RestoreReport {
  imported: { projects: number; settings: number; elements: number; library: number; jobs: number; media: number };
  skipped: { projects: number; elements: number; library: number; jobs: number; media: number };
}

type Table = Record<string, unknown>[];

function insertIgnore(table: string, columns: string[], rows: Table): { imported: number; skipped: number } {
  if (!rows.length) return { imported: 0, skipped: 0 };
  const db = getDb();
  const pick = (r: Record<string, unknown>) => columns.map((c) => (r[c] ?? null) as unknown);
  const marks = `(${columns.map(() => "?").join(",")})`;
  const stmt = db.query(`INSERT OR IGNORE INTO ${table} (${columns.join(",")}) VALUES ${rows.map(() => marks).join(",")}`);
  // bun:sqlite run with flat args:
  const flat: unknown[] = [];
  for (const r of rows) flat.push(...pick(r));
  const res = (stmt as unknown as { run: (...a: unknown[]) => { changes: number } }).run(...flat);
  return { imported: res.changes, skipped: rows.length - res.changes };
}

export async function buildBackup(opts: BackupOptions): Promise<{ filename: string; bytes: Uint8Array }> {
  const { files, filename } = await assembleBackup(opts);
  const archive = new Bun.Archive(files);
  const bytes = await archive.bytes();
  if (bytes.length > BACKUP_MAX_BYTES) {
    throw Object.assign(new Error("Backup exceeds the 1 GB cap — deselect media-heavy scopes"), {
      code: "E_BACKUP_TOO_LARGE",
    });
  }
  return { filename, bytes };
}

/**
 * Disk-streamed build for production: the input map still lives in RAM
 * (Bun.Archive has no streaming input), but the ~1 GB output streams
 * straight to disk instead of a second full copy — and serving streams
 * from disk too. Peak ≈ 1× file instead of ≈ 2×.
 */
export async function buildBackupFile(opts: BackupOptions): Promise<{ filename: string; path: string }> {
  sweepBackupTmp();
  const { files, filename } = await assembleBackup(opts);
  const path = `${backupTmpPath("build")}.tar`;
  await Bun.Archive.write(path, files);
  if (statSync(path).size > BACKUP_MAX_BYTES) {
    removeBackupTmp(path);
    throw Object.assign(new Error("Backup exceeds the 1 GB cap — deselect media-heavy scopes"), {
      code: "E_BACKUP_TOO_LARGE",
    });
  }
  // Served for up to 10 minutes, then swept.
  setTimeout(() => removeBackupTmp(path), 10 * 60 * 1000).unref?.();
  return { filename, path };
}

async function assembleBackup(opts: BackupOptions): Promise<{
  files: Record<string, string | Uint8Array>; filename: string;
}> {
  const db = getDb();
  const files: Record<string, string | Uint8Array> = {};
  const pid = opts.projectId;
  const projects = (
    pid
      ? db.query("SELECT * FROM projects WHERE id=?").all(pid)
      : db.query("SELECT * FROM projects ORDER BY created_at").all()
  ) as Table;
  const settings = (
    pid
      ? db.query("SELECT * FROM project_settings WHERE project_id=?").all(pid)
      : db.query("SELECT * FROM project_settings").all()
  ) as Table;
  files["projects.json"] = JSON.stringify(projects);
  files["settings.json"] = JSON.stringify(settings);

  let mediaTotal = 0;
  const mediaIndex: Record<string, { mime: string; bytes: number }> = {};
  const addMedia = async (id: string) => {
    const row = db.query("SELECT mime, bytes, path FROM media WHERE id=?").get(id) as {
      mime: string;
      bytes: number;
      path: string;
    } | null;
    if (!row) return;
    if (mediaTotal + row.bytes > BACKUP_MAX_BYTES) {
      throw Object.assign(new Error("Backup exceeds the 1 GB cap — deselect media-heavy scopes"), {
        code: "E_BACKUP_TOO_LARGE",
      });
    }
    const data = await Bun.file(row.path).bytes().catch(() => null);
    if (!data) return;
    files[`media/${id}.${extForMime(row.mime)}`] = data;
    mediaIndex[id] = { mime: row.mime, bytes: row.bytes };
    mediaTotal += row.bytes;
  };

  let elements: Table = [];
  if (opts.elements) {
    elements = (
      pid
        ? db.query("SELECT * FROM elements WHERE project_id=? ORDER BY created_at").all(pid)
        : db.query("SELECT * FROM elements ORDER BY created_at").all()
    ) as Table;
    files["elements.json"] = JSON.stringify(elements);
  }

  let library: Table = [];
  let jobs: Table = [];
  if (opts.generated || opts.uploads) {
    const conds: string[] = [];
    if (opts.generated) conds.push("model != 'import'");
    if (opts.uploads) conds.push("model = 'import'");
    const scope = pid ? "project_id=? AND " : "";
    const args = pid ? [pid] : [];
    library = db.query(`SELECT * FROM library WHERE ${scope}(${conds.join(" OR ")}) ORDER BY created_at`).all(...args) as Table;
    files["library.json"] = JSON.stringify(library);
    for (const v of library) {
      const url = String((v as Record<string, unknown>).video_url ?? "");
      const m = /^\/media\/([A-Za-z0-9_-]{8,64})$/.exec(url);
      if (m?.[1]) await addMedia(m[1]);
    }
  }
  if (opts.generated) {
    jobs = (
      pid
        ? db.query("SELECT * FROM jobs WHERE project_id=? AND status IN ('succeeded','failed','cancelled') ORDER BY created_at").all(pid)
        : db.query("SELECT * FROM jobs WHERE status IN ('succeeded','failed','cancelled') ORDER BY created_at").all()
    ) as Table;
    files["jobs.json"] = JSON.stringify(jobs);
  }
  files["media.json"] = JSON.stringify(mediaIndex);

  const manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    includes: { ...opts },
    counts: {
      projects: projects.length,
      settings: settings.length,
      elements: elements.length,
      library: library.length,
      jobs: jobs.length,
      media: Object.keys(mediaIndex).length,
      mediaBytes: mediaTotal,
    },
  };
  files["manifest.json"] = JSON.stringify(manifest, null, 2);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tag = pid ? `${String(pid).replace(/[^a-z0-9-]+/gi, "-").slice(0, 40)}-` : "";
  // Fail fast before archiving: JSON thumbs/posters count toward the cap too
  // (media bytes are already tracked in mediaTotal — strings only here).
  let jsonBytes = 0;
  for (const v of Object.values(files)) if (typeof v === "string") jsonBytes += v.length;
  if (mediaTotal + jsonBytes > BACKUP_MAX_BYTES) {
    throw Object.assign(new Error("Backup exceeds the 1 GB cap — deselect media-heavy scopes"), {
      code: "E_BACKUP_TOO_LARGE",
    });
  }
  return { files, filename: `veo-backup-${tag}${stamp}.tar` };
}

const JSON_FILE = /^(manifest|projects|settings|elements|library|jobs|media)\.json$/;
const MEDIA_FILE = /^media\/([A-Za-z0-9_-]{8,64})\.[a-z0-9]+$/;

export interface ParsedBackup {
  manifest: { version: number; exportedAt: string; includes: BackupOptions; counts: Record<string, number> };
  projects: Table;
  settings: Table;
  elements: Table;
  library: Table;
  jobs: Table;
  mediaIndex: Record<string, { mime?: string }>;
  mediaFiles: Map<string, { bytes: Uint8Array; mime: string }>;
}

export async function parseBackup(data: Uint8Array, loadMedia: boolean): Promise<ParsedBackup> {
  if (data.length > BACKUP_MAX_BYTES) {
    throw Object.assign(new Error("Archive exceeds the 1 GB cap"), { code: "E_BACKUP_TOO_LARGE" });
  }
  let entries: Map<string, File>;
  try {
    entries = await new Bun.Archive(data).files();
  } catch {
    throw Object.assign(new Error("Not a readable tar archive"), { code: "E_BACKUP_INVALID" });
  }
  for (const [path] of entries) {
    if (!JSON_FILE.test(path) && !MEDIA_FILE.test(path)) {
      throw Object.assign(new Error(`Unexpected path in archive: ${path}`), { code: "E_BACKUP_INVALID" });
    }
  }
  const readTable = async (name: string, required: boolean): Promise<Table> => {
    const f = entries.get(name);
    if (!f) {
      if (required) throw Object.assign(new Error(`Archive is missing ${name}`), { code: "E_BACKUP_INVALID" });
      return [];
    }
    try {
      const j = JSON.parse(await f.text()) as unknown;
      if (!Array.isArray(j)) throw new Error("not an array");
      return j as Table;
    } catch {
      throw Object.assign(new Error(`${name} is corrupt`), { code: "E_BACKUP_INVALID" });
    }
  };
  const manifestFile = entries.get("manifest.json");
  if (!manifestFile) throw Object.assign(new Error("Archive is missing manifest.json"), { code: "E_BACKUP_INVALID" });
  const manifest = JSON.parse(await manifestFile.text()) as ParsedBackup["manifest"];
  if (manifest.version !== 1) {
    throw Object.assign(new Error(`Unsupported backup version ${String(manifest.version)}`), {
      code: "E_BACKUP_VERSION",
    });
  }
  let mediaIndex: ParsedBackup["mediaIndex"] = {};
  const indexFile = entries.get("media.json");
  if (indexFile) {
    try {
      const parsed = JSON.parse(await indexFile.text()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad index");
      mediaIndex = parsed as Record<string, { mime?: string }>;
    } catch {
      throw Object.assign(new Error("media.json is corrupt"), { code: "E_BACKUP_INVALID" });
    }
  }
  const mediaFiles = new Map<string, { bytes: Uint8Array; mime: string }>();
  if (loadMedia) {
    for (const [path, file] of entries) {
      const m = MEDIA_FILE.exec(path);
      if (!m?.[1]) continue;
      const id = m[1];
      mediaFiles.set(id, {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mime: mediaIndex[id]?.mime ?? "video/mp4",
      });
    }
  } else {
    for (const [path] of entries) {
      const m = MEDIA_FILE.exec(path);
      if (m?.[1]) mediaFiles.set(m[1], { bytes: new Uint8Array(0), mime: mediaIndex[m[1]]?.mime ?? "video/mp4" });
    }
  }
  return {
    manifest,
    projects: await readTable("projects.json", true),
    settings: await readTable("settings.json", false),
    elements: await readTable("elements.json", false),
    library: await readTable("library.json", false),
    jobs: await readTable("jobs.json", false),
    mediaIndex,
    mediaFiles,
  };
}

function emptyReport(): RestoreReport {
  return {
    imported: { projects: 0, settings: 0, elements: 0, library: 0, jobs: 0, media: 0 },
    skipped: { projects: 0, elements: 0, library: 0, jobs: 0, media: 0 },
  };
}

function applyTables(
  report: RestoreReport,
  parsed: { projects: Table; settings: Table; elements: Table; library: Table; jobs: Table },
): void {
  const apply = (
    key: "projects" | "elements" | "library" | "jobs",
    table: string,
    columns: string[],
    rows: Table,
  ) => {
    const r = insertIgnore(table, columns, rows);
    report.imported[key] = r.imported;
    report.skipped[key] = r.skipped;
  };

  apply("projects", "projects", ["id", "name", "created_at", "updated_at"], parsed.projects);
  const s = insertIgnore(
    "project_settings",
    ["project_id", "sa_json", "bucket", "use_bucket", "auth_mode", "updated_at"],
    parsed.settings,
  );
  report.imported.settings = s.imported;
  apply(
    "elements",
    "elements",
    ["id", "project_id", "category", "name", "image_url", "note", "created_at"],
    parsed.elements,
  );
  apply(
    "library",
    "library",
    ["id", "project_id", "job_id", "mode", "model", "prompt", "resolution", "aspect", "duration_seconds", "actual_duration_seconds", "audio", "status", "cost_estimate", "video_url", "gcs_uri", "thumb_url", "inputs_json", "vertex_operation", "created_at", "updated_at"],
    parsed.library.map((r) => ({ gcs_uri: "", thumb_url: "", ...r })),
  );
  apply(
    "jobs",
    "jobs",
    ["id", "project_id", "idempotency_key", "mode", "model", "prompt", "resolution", "aspect", "duration_seconds", "audio", "sample_count", "seed", "inputs_json", "status", "progress", "error", "cost_estimate", "vertex_operation", "webhook_url", "created_at", "updated_at"],
    parsed.jobs,
  );
}

export async function restoreBackup(data: Uint8Array): Promise<RestoreReport> {
  const parsed = await parseBackup(data, true);
  const report = emptyReport();
  applyTables(report, parsed);

  // Media files (already loaded by parseBackup).
  const db = getDb();
  for (const [id, file] of parsed.mediaFiles) {
    const exists = db.query("SELECT id FROM media WHERE id=?").get(id);
    if (exists) {
      report.skipped.media++;
      continue;
    }
    if (await importMediaFile(id, file.bytes, file.mime)) report.imported.media++;
    else report.skipped.media++;
  }

  log.info({ imported: report.imported, skipped: report.skipped }, "backup restored");
  return report;
}

/** Allowlisted entry check shared by both restore paths. */
function assertSafeEntries(names: Iterable<string>): void {
  for (const path of names) {
    if (!JSON_FILE.test(path) && !MEDIA_FILE.test(path)) {
      throw Object.assign(new Error(`Unexpected path in archive: ${path}`), { code: "E_BACKUP_INVALID" });
    }
  }
}

async function readJsonTable<T>(read: (name: string) => Promise<string | null>, name: string, required: boolean): Promise<Table> {
  const text = await read(name);
  if (text == null) {
    if (required) throw Object.assign(new Error(`Archive is missing ${name}`), { code: "E_BACKUP_INVALID" });
    return [];
  }
  try {
    const j = JSON.parse(text) as unknown;
    if (!Array.isArray(j)) throw new Error("not an array");
    return j as Table;
  } catch {
    throw Object.assign(new Error(`${name} is corrupt`), { code: "E_BACKUP_INVALID" });
  }
}

function parseManifest(text: string | null): ParsedBackup["manifest"] {
  if (!text) throw Object.assign(new Error("Archive is missing manifest.json"), { code: "E_BACKUP_INVALID" });
  const manifest = JSON.parse(text) as ParsedBackup["manifest"];
  if (manifest.version !== 1) {
    throw Object.assign(new Error(`Unsupported backup version ${String(manifest.version)}`), {
      code: "E_BACKUP_VERSION",
    });
  }
  return manifest;
}

/**
 * Disk-based restore for production: the upload streams to disk, the archive
 * constructor sees one bounded copy, entries extract to disk, and media files
 * import one at a time. Peak ≈ 1× file instead of ≈ 2-3×.
 */
export async function restoreBackupFile(path: string): Promise<RestoreReport> {
  if (statSync(path).size > BACKUP_MAX_BYTES) {
    throw Object.assign(new Error("Archive exceeds the 1 GB cap"), { code: "E_BACKUP_TOO_LARGE" });
  }
  const work = `${backupTmpPath("restore")}-dir`;
  mkdirSync(work, { recursive: true });
  try {
    const archive = new Bun.Archive(await Bun.file(path).bytes());
    await archive.extract(work);
    const names: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${f.name}` : f.name;
        if (f.isDirectory()) walk(join(dir, f.name), rel);
        else names.push(rel);
      }
    };
    walk(work, "");
    assertSafeEntries(names);
    const read = async (name: string): Promise<string | null> => {
      const p = join(work, name);
      try {
        return await Bun.file(p).text();
      } catch {
        return null;
      }
    };
    const manifest = parseManifest(await read("manifest.json"));
    const parsed = {
      projects: await readJsonTable(read, "projects.json", true),
      settings: await readJsonTable(read, "settings.json", false),
      elements: await readJsonTable(read, "elements.json", false),
      library: await readJsonTable(read, "library.json", false),
      jobs: await readJsonTable(read, "jobs.json", false),
    };
    let mediaIndex: ParsedBackup["mediaIndex"] = {};
    try {
      const raw = await read("media.json");
      if (raw) {
        const j = JSON.parse(raw) as unknown;
        if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("bad index");
        mediaIndex = j as Record<string, { mime?: string }>;
      }
    } catch {
      throw Object.assign(new Error("media.json is corrupt"), { code: "E_BACKUP_INVALID" });
    }
    const report = emptyReport();
    applyTables(report, parsed);
    const db = getDb();
    for (const name of names) {
      const m = MEDIA_FILE.exec(name);
      if (!m?.[1]) continue;
      const id = m[1];
      if (db.query("SELECT id FROM media WHERE id=?").get(id)) {
        report.skipped.media++;
        continue;
      }
      const bytes = new Uint8Array(await Bun.file(join(work, name)).bytes());
      if (await importMediaFile(id, bytes, mediaIndex[id]?.mime ?? "video/mp4")) report.imported.media++;
      else report.skipped.media++;
    }
    log.info({ imported: report.imported, skipped: report.skipped }, "backup restored");
    return report;
  } finally {
    removeBackupTmp(work);
  }
}

/**
 * Disk-based inspect: only the manifest materializes (counts ship inside it),
 * so even a 1 GB upload costs kilobytes of RAM here.
 */
export async function inspectBackupFile(path: string): Promise<{
  manifest: ParsedBackup["manifest"];
  counts: Record<string, number>;
}> {
  if (statSync(path).size > BACKUP_MAX_BYTES) {
    throw Object.assign(new Error("Archive exceeds the 1 GB cap"), { code: "E_BACKUP_TOO_LARGE" });
  }
  const archive = new Bun.Archive(await Bun.file(path).bytes());
  const files = await archive.files("manifest.json");
  const entry = files.get("manifest.json");
  if (!entry) throw Object.assign(new Error("Archive is missing manifest.json"), { code: "E_BACKUP_INVALID" });
  const manifest = parseManifest(await entry.text());
  return { manifest, counts: manifest.counts };
}
