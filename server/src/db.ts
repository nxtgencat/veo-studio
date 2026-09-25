import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  const file = process.env.SQLITE_FILE ?? "data/veo.sqlite";
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  return db;
}

export function migrate(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS elements (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('characters','locations','assets','frames')),
      name TEXT NOT NULL,
      image_url TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_elements_project ON elements(project_id, category);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      resolution TEXT NOT NULL,
      aspect TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      audio INTEGER NOT NULL,
      sample_count INTEGER NOT NULL,
      seed INTEGER,
      inputs_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '',
      cost_estimate REAL NOT NULL DEFAULT 0,
      vertex_operation TEXT NOT NULL DEFAULT '',
      webhook_url TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      person TEXT NOT NULL DEFAULT 'allow_adult',
      negative_prompt TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at);
    CREATE TABLE IF NOT EXISTS library (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      resolution TEXT NOT NULL,
      aspect TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      audio INTEGER NOT NULL,
      status TEXT NOT NULL,
      cost_estimate REAL NOT NULL DEFAULT 0,
      video_url TEXT NOT NULL DEFAULT '',
      thumb_url TEXT NOT NULL DEFAULT '',
      gcs_uri TEXT NOT NULL DEFAULT '',
      person TEXT NOT NULL DEFAULT 'allow_adult',
      negative_prompt TEXT NOT NULL DEFAULT '',
      inputs_json TEXT NOT NULL DEFAULT '{}',
      vertex_operation TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_library_project ON library(project_id, created_at);
    CREATE TABLE IF NOT EXISTS project_settings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      sa_json TEXT NOT NULL DEFAULT '',
      bucket TEXT NOT NULL DEFAULT '',
      use_bucket INTEGER NOT NULL DEFAULT 1,
      auth_mode TEXT NOT NULL DEFAULT 'service_account',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  // Column added after launch — backfill existing databases.
  const cols = d.query("PRAGMA table_info(library)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "gcs_uri")) {
    d.exec("ALTER TABLE library ADD COLUMN gcs_uri TEXT NOT NULL DEFAULT ''");
  }
  const jobCols = d.query("PRAGMA table_info(jobs)").all() as { name: string }[];
  // Vertex submit time + completed duration (ms) — powers measured ETAs.
  if (!jobCols.some((c) => c.name === "submitted_at")) {
    d.exec("ALTER TABLE jobs ADD COLUMN submitted_at TEXT NOT NULL DEFAULT ''");
  }
  if (!jobCols.some((c) => c.name === "duration_ms")) {
    d.exec("ALTER TABLE jobs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0");
  }
  for (const [table, column, ddl] of [
    ["jobs", "person", "TEXT NOT NULL DEFAULT 'allow_adult'"],
    ["jobs", "negative_prompt", "TEXT NOT NULL DEFAULT ''"],
    ["library", "person", "TEXT NOT NULL DEFAULT 'allow_adult'"],
    ["library", "negative_prompt", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    const existing = d.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!existing.some((c) => c.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
}

export function resetDbForTests() {
  db?.close();
  db = null;
}

export const nowIso = () => new Date().toISOString();
