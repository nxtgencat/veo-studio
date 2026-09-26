// Full backup & restore (tar.gz via Bun.Archive).
// Scope toggles — projects + settings always included:
//   elements: element rows (images are inline data-URLs already)
//   generated: library rows (model != import) + terminal jobs + their media
//   uploads: library rows (model = import) + their media files
// Restore merges with INSERT OR IGNORE (existing IDs are skipped, reported).

import { getDb } from "./db.ts";
import { extForMime, importMediaFile } from "./media-store.ts";
import { childLogger } from "./logger.ts";

const log = childLogger({ module: "backup" });

export const BACKUP_MAX_BYTES = 1024 * 1024 * 1024;

export interface BackupOptions {
  elements: boolean;
  generated: boolean;
  uploads: boolean;
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
  const db = getDb();
  const files: Record<string, string | Uint8Array> = {};
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
    elements = db.query("SELECT * FROM elements ORDER BY created_at").all() as Table;
    files["elements.json"] = JSON.stringify(elements);
  }

  let library: Table = [];
  let jobs: Table = [];
  if (opts.generated || opts.uploads) {
    const conds: string[] = [];
    if (opts.generated) conds.push("model != 'import'");
    if (opts.uploads) conds.push("model = 'import'");
    library = db.query(`SELECT * FROM library WHERE ${conds.join(" OR ")} ORDER BY created_at`).all() as Table;
    files["library.json"] = JSON.stringify(library);
    for (const v of library) {
      const url = String((v as Record<string, unknown>).video_url ?? "");
      const m = /^\/media\/([A-Za-z0-9_-]{8,64})$/.exec(url);
      if (m?.[1]) await addMedia(m[1]);
    }
  }
  if (opts.generated) {
    jobs = db
      .query("SELECT * FROM jobs WHERE status IN ('succeeded','failed','cancelled') ORDER BY created_at")
      .all() as Table;
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
  const archive = new Bun.Archive(files, { compress: "gzip" });
  return { filename: `veo-backup-${stamp}.tar.gz`, bytes: await archive.bytes() };
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

export async function restoreBackup(data: Uint8Array): Promise<RestoreReport> {
  const parsed = await parseBackup(data, true);

  const report: RestoreReport = {
    imported: { projects: 0, settings: 0, elements: 0, library: 0, jobs: 0, media: 0 },
    skipped: { projects: 0, elements: 0, library: 0, jobs: 0, media: 0 },
  };
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
