// Full backup & restore (plain tar via Bun.Archive — deliberately
// UNCOMPRESSED: mp4s don't shrink; gzip cost 21s vs 1s on ~1 GB).
// One model: a build packs everything; uploads are validated + filed.
// Restore merges with INSERT OR IGNORE (existing IDs skipped, reported).
//
// Bun-first transfer shapes (bun.com/docs/runtime/{file-io,archive}):
// - uploads arrive as 8 MiB octet-stream parts (POST /uploads, PUT part,
//   POST complete) so every default body cap holds; the session file
//   assembles on disk via node:fs appendFile (Bun's own guide: no native
//   append API exists) and finalizes per kind below.
// - builds hold media bytes (no lazy input exists — verified), but the
//   archive streams to disk via construct + Bun.write (no 2nd full copy).
// - downloads stream from disk via new Response(Bun.file(path)).
// - restore imports media file→file (kernel copy, no userland bytes).
// Unavoidable RAM copies (upstream by design, both capped): Bun.Archive has
// no streaming input (constructor takes bytes), and the MediaBunny import
// probe needs random access to demux. Caps: 1 GB archive / 200 MB media.

import { getDb, nowIso } from "./db.ts";
import { extForMime, importMediaPath } from "./media-store.ts";
import { logger } from "./logger.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";

const log = logger.child({ module: "backup" });

export const BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

/** 1 GB cap: "Backup…" when we build it, "Archive…" when one arrives. */
function assertCap(n: number, what: "Backup" | "Archive"): void {
  if (n > BACKUP_MAX_BYTES) {
    throw Object.assign(new Error(`${what} exceeds the 1 GB cap`), { code: "E_BACKUP_TOO_LARGE" });
  }
}

function newBackupId(): string {
  return `b_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Archive input: JSON strings or raw bytes.
 * NOTE: BunFile handles are NOT valid values — on Bun 1.4.2 they archive as
 * silent 0-byte entries (verified: construct+Bun.write and the static
 * Archive.write both). Only in-memory string/Uint8Array/Blob work. */
type ArchiveFiles = Record<string, string | Uint8Array | Blob>;

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
function sweepBackupTmp(maxAgeMs = 30 * 60 * 1000): void {
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

function removeBackupTmp(path: string): void {
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

/** Where finished backup files live (served for download, read for restore). */
export function backupsDir(): string {
  const dir = process.env.BACKUPS_DIR ?? "data/backups";
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface StoredBackup {
  id: string;
  filename: string;
  bytes: number;
  counts: Record<string, number>;
  created_at: string;
}

function toStored(row: any): StoredBackup {
  let counts: Record<string, number> = {};
  try {
    const j = JSON.parse(row.counts ?? "{}") as unknown;
    if (j && typeof j === "object") counts = j as Record<string, number>;
  } catch { /* corrupt counts — treat as empty */ }
  return { id: row.id, filename: row.filename, bytes: row.bytes, counts, created_at: row.created_at };
}

export function listBackups(): StoredBackup[] {
  return (getDb().query("SELECT * FROM backups ORDER BY created_at DESC").all() as any[]).map(toStored);
}

export function backupFilePath(id: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const row = getDb().query("SELECT id FROM backups WHERE id=?").get(id) as { id: string } | null;
  if (!row) return null;
  const p = join(backupsDir(), `${id}.tar`);
  try {
    if (statSync(p).isFile()) return p;
  } catch { /* gone */ }
  return null;
}

export function deleteBackup(id: string): boolean {
  const p = backupFilePath(id);
  if (p) removeBackupTmp(p);
  const r = getDb().query("DELETE FROM backups WHERE id=?").run(id);
  return r.changes > 0 || !!p;
}

/** Build a full backup (everything, all projects) straight into the store. */
export async function buildStoredBackup(): Promise<StoredBackup> {
  sweepBackupTmp();
  const { files } = await assembleBackup();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const id = newBackupId();
  const filename = `veo-backup-${stamp}.tar`;
  const path = join(backupsDir(), `${id}.tar`);
  // Construct + Bun.write streams the archive to disk: peak is the input
  // map only (the old .bytes() shape held a second full copy of the output
  // in RAM too).
  const archive = new Bun.Archive(files);
  await Bun.write(path, archive);
  const bytes = statSync(path).size;
  if (bytes > BACKUP_MAX_BYTES) {
    removeBackupTmp(path);
    throw Object.assign(new Error("Backup exceeds the 1 GB cap"), { code: "E_BACKUP_TOO_LARGE" });
  }
  const counts = manifestCounts(files);
  const created = nowIso();
  getDb().query("INSERT INTO backups (id, filename, bytes, counts, created_at) VALUES (?,?,?,?,?)").run(
    id, filename, bytes, JSON.stringify(counts), created,
  );
  return { id, filename, bytes, counts, created_at: created };
}

/** Counts ship inside manifest.json — read them without loading media. */
function manifestCounts(files: ArchiveFiles): Record<string, number> {
  try {
    const m = JSON.parse(String(files["manifest.json"] ?? "{}")) as { counts?: Record<string, number> };
    return m.counts && typeof m.counts === "object" ? m.counts : {};
  } catch {
    return {};
  }
}

/**
 * Store an uploaded archive: validate it's one of ours, then file it.
 * Returns the stored row (counts come from its own manifest).
 */
export async function storeUploadedBackup(tmpPath: string, filename: string): Promise<StoredBackup> {
  assertCap(statSync(tmpPath).size, "Archive");
  const archive = new Bun.Archive(await Bun.file(tmpPath).bytes());
  const found = await archive.files("manifest.json");
  const entry = found.get("manifest.json");
  if (!entry) {
    removeBackupTmp(tmpPath);
    throw Object.assign(new Error("Not one of ours — manifest.json missing"), { code: "E_BACKUP_INVALID" });
  }
  let counts: Record<string, number> = {};
  try {
    const m = JSON.parse(await entry.text()) as { version?: number; counts?: Record<string, number> };
    if (m.version !== 1) throw new Error("version");
    if (m.counts && typeof m.counts === "object") counts = m.counts;
  } catch {
    removeBackupTmp(tmpPath);
    throw Object.assign(new Error("Not a readable backup manifest"), { code: "E_BACKUP_INVALID" });
  }
  const id = newBackupId();
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "upload.tar";
  const dest = join(backupsDir(), `${id}.tar`);
  await Bun.write(dest, Bun.file(tmpPath));
  removeBackupTmp(tmpPath);
  const bytes = statSync(dest).size;
  const created = nowIso();
  getDb().query("INSERT INTO backups (id, filename, bytes, counts, created_at) VALUES (?,?,?,?,?)").run(
    id, safe, bytes, JSON.stringify(counts), created,
  );
  return { id, filename: safe, bytes, counts, created_at: created };
}

async function assembleBackup(): Promise<{
  files: ArchiveFiles; filename: string;
}> {
  const db = getDb();
  const files: ArchiveFiles = {};
  const projects = db.query("SELECT * FROM projects ORDER BY created_at").all() as Table;
  const settings = db.query("SELECT * FROM project_settings").all() as Table;
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
    assertCap(mediaTotal + row.bytes, "Backup");
    // Eager bytes: lazy BunFile handles archive as 0-byte entries (see
    // ArchiveFiles note). Fail-fast cap check above keeps this bounded.
    const data = await Bun.file(row.path).bytes().catch(() => null);
    if (!data) return;
    files[`media/${id}.${extForMime(row.mime)}`] = data;
    mediaIndex[id] = { mime: row.mime, bytes: row.bytes };
    mediaTotal += row.bytes;
  };

  let elements: Table = [];
  elements = db.query("SELECT * FROM elements ORDER BY created_at").all() as Table;
  files["elements.json"] = JSON.stringify(elements);

  let library: Table = [];
  let jobs: Table = [];
  library = db.query("SELECT * FROM library ORDER BY created_at").all() as Table;
  files["library.json"] = JSON.stringify(library);
  for (const v of library) {
    const url = String((v as Record<string, unknown>).video_url ?? "");
    const m = /^\/media\/([A-Za-z0-9_-]{8,64})$/.exec(url);
    if (m?.[1]) await addMedia(m[1]);
  }
  jobs = db
    .query("SELECT * FROM jobs WHERE status IN ('succeeded','failed','cancelled') ORDER BY created_at")
    .all() as Table;
  files["jobs.json"] = JSON.stringify(jobs);
  files["media.json"] = JSON.stringify(mediaIndex);

  const manifest = {
    version: 1,
    exportedAt: nowIso(),
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
  // Fail fast before archiving: JSON thumbs/posters count toward the cap too
  // (media bytes are already tracked in mediaTotal — strings only here).
  let jsonBytes = 0;
  for (const v of Object.values(files)) if (typeof v === "string") jsonBytes += v.length;
  assertCap(mediaTotal + jsonBytes, "Backup");
  return { files, filename: `veo-backup-${stamp}.tar` };
}

const JSON_FILE = /^(manifest|projects|settings|elements|library|jobs|media)\.json$/;
const MEDIA_FILE = /^media\/([A-Za-z0-9_-]{8,64})\.[a-z0-9]+$/;

interface BackupManifest {
  version: number;
  exportedAt: string;
  counts: Record<string, number>;
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

/** Allowlisted entry check shared by both restore paths. */
function assertSafeEntries(names: Iterable<string>): void {
  for (const path of names) {
    if (!JSON_FILE.test(path) && !MEDIA_FILE.test(path)) {
      throw Object.assign(new Error(`Unexpected path in archive: ${path}`), { code: "E_BACKUP_INVALID" });
    }
  }
}

async function readJsonTable(read: (name: string) => Promise<string | null>, name: string, required: boolean): Promise<Table> {
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

function parseManifest(text: string | null): BackupManifest {
  if (!text) throw Object.assign(new Error("Archive is missing manifest.json"), { code: "E_BACKUP_INVALID" });
  const manifest = JSON.parse(text) as BackupManifest;
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
  assertCap(statSync(path).size, "Archive");
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
    parseManifest(await read("manifest.json")); // validates version, throws otherwise
    const parsed = {
      projects: await readJsonTable(read, "projects.json", true),
      settings: await readJsonTable(read, "settings.json", false),
      elements: await readJsonTable(read, "elements.json", false),
      library: await readJsonTable(read, "library.json", false),
      jobs: await readJsonTable(read, "jobs.json", false),
    };
    let mediaIndex: Record<string, { mime?: string }> = {};
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
    for (const name of names) {
      const m = MEDIA_FILE.exec(name);
      if (!m?.[1]) continue;
      const id = m[1];
      // Already on disk (extracted) → file→file import, no userland bytes.
      if (await importMediaPath(id, join(work, name), mediaIndex[id]?.mime ?? "video/mp4")) report.imported.media++;
      else report.skipped.media++;
    }
    log.info({ imported: report.imported, skipped: report.skipped }, "backup restored");
    return report;
  } finally {
    removeBackupTmp(work);
  }
}
