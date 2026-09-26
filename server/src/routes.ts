import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { isAuthorized, isAuthorizedMedia, passwordRequired } from "./access.ts";
import { uniqueSlug } from "./slug.ts";
import { getDb, nowIso } from "./db.ts";
import { clearTokenCache, getSettings, parseSaJson, saAccessToken, saveSettings, type SaCreds } from "./auth.ts";
import { checkBucket } from "./gcs.ts";
import { IMAGE_MAX_BYTES, isAllowedImageMime, parseDataUrl, sniffImageMime } from "./images.ts";
import { probeVideoMetadata, videoMetaToResAspect } from "./frames.ts";
import { deleteMedia, getMedia, MEDIA_MAX_BYTES, mediaIdFromUrl, saveMedia } from "./media-store.ts";
import { BACKUP_MAX_BYTES, buildBackupFile, inspectBackupFile, restoreBackupFile, backupTmpPath, removeBackupTmp } from "./backup.ts";
import { capabilitiesSnapshot, getModel } from "./capabilities.ts";
import { pricingTable } from "./pricing.ts";
import { jobInputSchema, zodDetails } from "./validation.ts";
import { cancelJob, createJob, getJob, jobElapsedMs, jobEta } from "./jobs.ts";
import { extractFrames } from "./frames.ts";
import { logger } from "./logger.ts";

export const app = new Hono();

const err = (c: any, status: number, code: string, message: string, details?: unknown) =>
  c.json({ error: { code, message, ...(details ? { details } : {}) } }, status as never);

app.use("*", async (c, next) => {
  const t0 = Date.now();
  await next();
  logger.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - t0 },
    "request",
  );
});

// Browser web app (Next on :3000 by default) calls this API cross-origin.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000").split(",");
app.use(
  "*",
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? origin),
    allowHeaders: ["Content-Type", "Idempotency-Key", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    maxAge: 86400,
  }),
);

// Password gate (VEO_PASSWORD env). Unset = open (dev default).
// Registered AFTER cors so preflights never hit auth. /health stays public
// for container healthchecks; /auth/status is public so the UI can prompt.
const PUBLIC_PATHS = new Set(["/health", "/auth/status"]);

app.use("*", async (c, next) => {
  if (PUBLIC_PATHS.has(new URL(c.req.url).pathname)) return next();
  // Browser media tags (<video src>) can't send Authorization headers —
  // allow ?token= as a fallback for media playback only (Range-safe).
  if (c.req.method === "GET" && new URL(c.req.url).pathname.startsWith("/media/")) {
    const q = new URL(c.req.url).searchParams.get("token") ?? "";
    if (!isAuthorizedMedia(c.req.header("authorization"), q)) {
      return c.json({ error: { code: "UNAUTHORIZED", message: "Valid Bearer token required (set VEO_PASSWORD)" } }, 401);
    }
    return next();
  }
  if (!isAuthorized(c.req.header("authorization"))) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Valid Bearer token required (set VEO_PASSWORD)" } }, 401);
  }
  return next();
});

app.get("/auth/status", (c) => c.json({ required: passwordRequired() }));

// ---------- projects ----------
app.post("/projects", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled project";
  const db = getDb();
  // Check-then-insert can race under concurrent creates — retry on PK clash.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = uniqueSlug(name, (s) => !!db.query("SELECT id FROM projects WHERE id=?").get(s));
    try {
      const now = nowIso();
      db.query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(id, name, now, now);
      return c.json({ id, name, createdAt: now }, 201);
    } catch (e: any) {
      const code = String(e?.code ?? "");
      if (!code.startsWith("SQLITE_CONSTRAINT")) throw e;
    }
  }
  return c.json({ error: { code: "SLUG_EXHAUSTED", message: "Could not pick a unique project id — try again" } }, 503);
});

app.get("/projects", (c) => {
  const rows = getDb().query("SELECT * FROM projects ORDER BY created_at DESC").all() as any[];
  return c.json({ projects: rows });
});

app.get("/projects/:id", (c) => {
  const row = getDb().query("SELECT * FROM projects WHERE id=?").get(c.req.param("id")) as any;
  if (!row) return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  return c.json(row);
});

app.patch("/projects/:id", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const db = getDb();
  const row = db.query("SELECT * FROM projects WHERE id=?").get(c.req.param("id")) as any;
  if (!row) return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : row.name;
  db.query("UPDATE projects SET name=?, updated_at=? WHERE id=?").run(name, nowIso(), row.id);
  return c.json({ ...(row as object), name });
});

app.delete("/projects/:id", async (c) => {
  const db = getDb();
  const pid = c.req.param("id");
  if (!db.query("SELECT id FROM projects WHERE id=?").get(pid)) {
    return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  }
  const vids = db.query("SELECT video_url FROM library WHERE project_id=?").all(pid) as { video_url: string }[];
  const mids = [...new Set(vids.map((v) => mediaIdFromUrl(v.video_url)).filter((m): m is string => !!m))];
  db.query("DELETE FROM elements WHERE project_id=?").run(pid);
  db.query("DELETE FROM jobs WHERE project_id=?").run(pid);
  db.query("DELETE FROM library WHERE project_id=?").run(pid);
  db.query("DELETE FROM project_settings WHERE project_id=?").run(pid);
  db.query("DELETE FROM projects WHERE id=?").run(pid);
  // Drop hosted files no other library row references (GCS objects untouched).
  for (const mid of mids) {
    const refs = db.query("SELECT id FROM library WHERE video_url=?").get(`/media/${mid}`);
    if (!refs) await deleteMedia(mid);
  }
  return c.json({ deleted: true });
});

// ---------- elements (characters/locations/assets/frames) ----------
const elementSchema = z.object({
  category: z.enum(["characters", "locations", "assets", "frames"]),
  name: z.string().min(1).max(200),
  imageUrl: z.string().default(""),
  note: z.string().default(""),
});

app.post("/projects/:id/elements", async (c) => {
  const pid = c.req.param("id");
  const db = getDb();
  if (!db.query("SELECT id FROM projects WHERE id=?").get(pid)) {
    return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  }
  const parsed = elementSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, 422, "VALIDATION", "Invalid element", zodDetails(parsed.error));
  // Inline uploads are inspected now (remote URLs are checked at submit time):
  // JPEG/PNG only, ≤20 MB each.
  const inline = parseDataUrl(parsed.data.imageUrl);
  if (inline) {
    if (!isAllowedImageMime(inline.mime) || !sniffImageMime(inline.bytes)) {
      return err(c, 422, "E_IMAGE_TYPE", `Element image must be JPEG or PNG, got ${inline.mime || "unknown"}`);
    }
    if (inline.bytes.length > IMAGE_MAX_BYTES) {
      return err(c, 422, "E_IMAGE_TOO_LARGE", "Element image exceeds 20 MB");
    }
  }
  const id = Bun.randomUUIDv7();
  const now = nowIso();
  db.query(
    "INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)",
  ).run(id, pid, parsed.data.category, parsed.data.name, parsed.data.imageUrl, parsed.data.note, now);
  return c.json({ id, projectId: pid, ...parsed.data, createdAt: now }, 201);
});

app.get("/projects/:id/elements", (c) => {
  const pid = c.req.param("id");
  const cat = c.req.query("category");
  const rows =
    cat
      ? (getDb().query("SELECT * FROM elements WHERE project_id=? AND category=? ORDER BY created_at").all(pid, cat) as any[])
      : (getDb().query("SELECT * FROM elements WHERE project_id=? ORDER BY created_at").all(pid) as any[]);
  return c.json({ elements: rows });
});

app.patch("/elements/:id", async (c) => {
  const db = getDb();
  const row = db.query("SELECT * FROM elements WHERE id=?").get(c.req.param("id")) as any;
  if (!row) return err(c, 404, "ELEMENT_NOT_FOUND", "No such element");
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name ? body.name : row.name;
  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl : row.image_url;
  const note = typeof body.note === "string" ? body.note : row.note;
  const inlinePatch = parseDataUrl(imageUrl);
  if (inlinePatch && (!isAllowedImageMime(inlinePatch.mime) || !sniffImageMime(inlinePatch.bytes))) {
    return err(c, 422, "E_IMAGE_TYPE", `Element image must be JPEG or PNG, got ${inlinePatch.mime || "unknown"}`);
  }
  if (inlinePatch && inlinePatch.bytes.length > IMAGE_MAX_BYTES) {
    return err(c, 422, "E_IMAGE_TOO_LARGE", "Element image exceeds 20 MB");
  }
  db.query("UPDATE elements SET name=?, image_url=?, note=? WHERE id=?").run(name, imageUrl, note, row.id);
  return c.json({ ...row, name, image_url: imageUrl, note });
});

app.delete("/elements/:id", (c) => {
  const r = getDb().query("DELETE FROM elements WHERE id=?").run(c.req.param("id"));
  if (!r.changes) return err(c, 404, "ELEMENT_NOT_FOUND", "No such element");
  return c.json({ deleted: true });
});

// ---------- project settings (auth + bucket; SA key never leaves the server) ----------
// Built once and shared: PATCH used to re-fetch via an internal sub-request,
// which carries no Authorization header and 401s behind the password gate —
// blanking both cards until refresh. Never do authed sub-requests to self.
function settingsBody(pid: string): Record<string, unknown> {
  const s = getSettings(pid);
  let saEmail: string | null = null;
  let saProjectId: string | null = null;
  if (s.saJson.trim()) {
    try {
      const sa = parseSaJson(s.saJson);
      saEmail = sa.client_email;
      saProjectId = sa.project_id;
    } catch { /* stored key invalid — surface via hasSaJson only */ }
  }
  return {
    projectId: pid,
    bucket: s.bucket,
    useBucket: s.useBucket,
    authMode: s.authMode,
    hasSaJson: !!s.saJson.trim(),
    saEmail,
    saProjectId,
    bucketLocation: null as string | null,
  };
}

app.get("/projects/:id/settings", (c) => {
  const pid = c.req.param("id");
  if (!getDb().query("SELECT id FROM projects WHERE id=?").get(pid)) {
    return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  }
  return c.json(settingsBody(pid));
});

const settingsSchema = z.object({
  saJson: z.string().max(20000).optional(),
  bucket: z.string().max(63).optional(),
  useBucket: z.boolean().optional(),
  authMode: z.enum(["service_account", "env"]).optional(),
});

app.patch("/projects/:id/settings", async (c) => {
  const pid = c.req.param("id");
  if (!getDb().query("SELECT id FROM projects WHERE id=?").get(pid)) {
    return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  }
  const parsed = settingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, 422, "VALIDATION", "Invalid settings", zodDetails(parsed.error));
  // Live verification BEFORE anything is saved: a new key must mint a token,
  // and a bucket ID must exist and be reachable with the effective credentials.
  // Only valid, reachable config persists.
  try {
    await verifySettingsLive(pid, parsed.data);
  } catch (e: any) {
    return err(c, 422, e?.code ?? "SETTINGS_INVALID", e?.message ?? "Invalid settings");
  }
  try {
    saveSettings(pid, parsed.data);
  } catch (e: any) {
    return err(c, 422, e?.code ?? "SETTINGS_INVALID", e?.message ?? "Invalid settings");
  }
  // Key changed or cleared: drop cached tokens (keyed by client_email, so a
  // rotated same-email key would otherwise keep minting with the revoked one).
  if (parsed.data.saJson !== undefined) clearTokenCache();
  logger.info({ projectId: pid, authMode: parsed.data.authMode, useBucket: parsed.data.useBucket }, "project settings saved");
  return c.json({ ...settingsBody(pid), bucketCheck: lastBucketCheck.get(pid) ?? null, bucketLocation: lastBucketCheck.get(pid)?.location ?? null });
});

/**
 * Mint a token for a fresh key and check bucket reachability with the
 * effective credentials. Throws coded errors; saves nothing.
 */
const lastBucketCheck = new Map<string, { location: string } | null>();

async function verifySettingsLive(
  projectId: string,
  patch: { saJson?: string; bucket?: string; useBucket?: boolean; authMode?: "service_account" | "env" },
): Promise<void> {
  const stored = getSettings(projectId);
  const authMode = patch.authMode ?? stored.authMode;
  // Explicit clear ("") must never exchange the STORED key: a dead stored key
  // would fail verification and brick both remove and re-add. Clearing proves
  // nothing and verifies nothing — it just clears.
  const clearingSa = patch.saJson !== undefined && !patch.saJson.trim();
  // Toggle-off touches no credentials and verifies nothing: it must work
  // even with a dead stored key or no network (otherwise you couldn't turn
  // the bucket off without disconnecting first).
  if (
    patch.saJson === undefined &&
    patch.bucket === undefined &&
    patch.authMode === undefined &&
    patch.useBucket === false
  ) {
    return;
  }
  // Effective key: fresh paste wins, otherwise the stored one.
  let sa: SaCreds | null = null;
  if (patch.saJson !== undefined && patch.saJson.trim()) {
    sa = parseSaJson(patch.saJson);
    // Prove the key works before saving it.
    await saAccessToken(sa);
  } else if (!clearingSa && authMode === "service_account" && stored.saJson.trim()) {
    sa = parseSaJson(stored.saJson);
  }
  // Effective token for the bucket check.
  let token: string | null = null;
  if (sa) token = await saAccessToken(sa);
  else if (authMode === "env") token = process.env.VERTEX_ACCESS_TOKEN ?? null;

  const bucket = patch.bucket !== undefined ? patch.bucket.trim() : stored.bucket;
  if (patch.bucket !== undefined && bucket) {
    if (!token) {
      throw Object.assign(
        new Error("Cannot verify bucket with no credentials — save a service account first"),
        { code: "E_SA_MISSING" },
      );
    }
    const check = await checkBucket(bucket, token);
    lastBucketCheck.set(projectId, { location: check.location });
  } else if (patch.bucket !== undefined) {
    lastBucketCheck.set(projectId, null);
  }
}

// ---------- composer / jobs ----------
app.post("/composer/jobs", async (c) => {
  const key = c.req.header("idempotency-key") ?? c.req.header("Idempotency-Key");
  const body = await c.req.json().catch(() => ({}));
  const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;
  const parsed = jobInputSchema.safeParse(body);
  if (!parsed.success) return err(c, 422, "VALIDATION", "Invalid job input", zodDetails(parsed.error));
  const result = createJob(parsed.data, key ?? bodyKey ?? "");
  if (!result.ok) {
    const status = result.code === "IDEMPOTENCY_REQUIRED" ? 400 : result.code === "PROJECT_NOT_FOUND" ? 404 : 422;
    return err(c, status, result.code, result.message, (result as any).details);
  }
  return c.json({ jobId: result.jobId, deduped: result.deduped }, 202);
});

app.get("/jobs/:id", (c) => {
  const row = getJob(c.req.param("id"));
  if (!row) return err(c, 404, "JOB_NOT_FOUND", "No such job");
  return c.json(formatJob(row));
});

app.get("/jobs", (c) => {
  const projectId = c.req.query("projectId");
  const db = getDb();
  const rows = projectId
    ? (db.query("SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 200").all(projectId) as any[])
    : (db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 200").all() as any[]);
  // ETA depends only on (model, resolution) — memoize per request instead of
  // one query per row (200 rows sharing a few models = 200 queries before).
  const etaCache = new Map<string, { etaMs: number; source: "measured" | "estimated" }>();
  return c.json({ jobs: rows.map((r) => formatJob(r, etaCache)) });
});

app.delete("/jobs/:id", (c) => {
  const db = getDb();
  const row = db.query("SELECT status FROM jobs WHERE id=?").get(c.req.param("id")) as { status: string } | null;
  if (!row) return err(c, 404, "JOB_NOT_FOUND", "No such job");
  if (row.status === "queued" || row.status === "running") {
    return err(c, 422, "JOB_ACTIVE", "Cancel a running job first — delete is for terminal records only");
  }
  db.query("DELETE FROM jobs WHERE id=?").run(c.req.param("id"));
  return c.json({ deleted: true });
});

app.post("/jobs/:id/cancel", async (c) => {
  const r = await cancelJob(c.req.param("id"));
  if (!r.ok) return err(c, r.code === "JOB_NOT_FOUND" ? 404 : 502, r.code, r.message);
  return c.json({
    ...r,
    // Document cost implication inline so UI can display it.
    costImplication:
      r.status === "cancelled"
        ? "Cancelled before completion: no output seconds produced, no per-second charge."
        : "Already terminal on Vertex: full per-second charge for produced seconds applies.",
  });
});

function formatJob(row: any, etaCache?: Map<string, { etaMs: number; source: "measured" | "estimated" }>) {
  const key = `${row.model}|${row.resolution}`;
  let eta = etaCache?.get(key);
  if (!eta) {
    eta = jobEta(row.model, row.resolution);
    etaCache?.set(key, eta);
  }
  const { etaMs, source } = eta;
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    model: row.model,
    prompt: row.prompt,
    resolution: row.resolution,
    aspect: row.aspect,
    durationSeconds: row.duration_seconds,
    audio: !!row.audio,
    sampleCount: row.sample_count,
    seed: row.seed,
    person: row.person ?? "allow_adult",
    negativePrompt: row.negative_prompt ?? "",
    status: row.status,
    progress: row.progress,
    error: row.error,
    costEstimate: row.cost_estimate,
    vertexOperation: row.vertex_operation,
    inputsJson: row.inputs_json ?? "{}",
    elapsedMs: jobElapsedMs(row),
    etaMs,
    etaSource: source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- media file store ----------
app.post("/media/upload", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return err(c, 400, "FILE_REQUIRED", "Multipart field 'file' is required");
  if (!file.size) return err(c, 400, "EMPTY_FILE", "Uploaded file is empty");
  if (file.size > MEDIA_MAX_BYTES) return err(c, 413, "MEDIA_TOO_LARGE", "Limit is 200 MB per file");
  const mime = (file as File).type || "application/octet-stream";
  if (!mime.startsWith("video/") && !mime.startsWith("image/")) {
    return err(c, 415, "MEDIA_TYPE", `Only video/* and image/* uploads, got ${mime}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const saved = await saveMedia(bytes, mime);
    return c.json(saved, 201);
  } catch (e: any) {
    return err(c, 422, e?.code ?? "UPLOAD_FAILED", e?.message ?? "Could not store file");
  }
});

app.get("/media/:id", (c) => {
  const hit = getMedia(c.req.param("id"));
  if (!hit) return err(c, 404, "MEDIA_NOT_FOUND", "No such file");
  const file = Bun.file(hit.path);
  const size = file.size || hit.bytes;
  const range = c.req.header("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
        const partial: Blob = file.slice(start, end + 1);
        return new Response(partial, {
          status: 206,
          headers: {
            "Content-Type": hit.mime,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
          },
        });
      }
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
  }
  return new Response(file as unknown as Blob, {
    headers: { "Content-Type": hit.mime, "Content-Length": String(size), "Accept-Ranges": "bytes" },
  });
});

// ---------- account totals (sidebar: spans projects the client never opened) ----------
app.get("/stats", (c) => {
  const db = getDb();
  const lib = db.query(
    "SELECT COUNT(*) AS videos, COALESCE(SUM(cost_estimate), 0) AS spend FROM library WHERE status='succeeded'",
  ).get() as { videos: number; spend: number };
  const projs = db.query("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
  const spend = Math.round(lib.spend * 100) / 100;
  const byProject = db.query(
    "SELECT project_id AS projectId, COUNT(*) AS videos, COALESCE(SUM(cost_estimate), 0) AS spend FROM library WHERE status='succeeded' GROUP BY project_id",
  ).all() as { projectId: string; videos: number; spend: number }[];
  for (const r of byProject) r.spend = Math.round(r.spend * 100) / 100;
  return c.json({ projects: projs.n, videos: lib.videos, delivered: lib.videos, spend, byProject });
});

// ---------- library ----------
// On-disk bytes ride along via LEFT JOIN (one query, no N+1): media.id is the
// tail of a hosted video_url ("/media/<id>"); gs:// and empty URLs match
// nothing and yield NULL.
const LIBRARY_WITH_BYTES = "library.*, media.bytes AS bytes FROM library LEFT JOIN media ON media.id = substr(library.video_url, 8)";

app.get("/library", (c) => {
  const projectId = c.req.query("projectId");
  const db = getDb();
  const rows = projectId
    ? (db.query(`SELECT ${LIBRARY_WITH_BYTES} WHERE library.project_id=? ORDER BY library.created_at DESC`).all(projectId) as any[])
    : (db.query(`SELECT ${LIBRARY_WITH_BYTES} ORDER BY library.created_at DESC LIMIT 200`).all() as any[]);
  return c.json({ videos: rows });
});

app.get("/library/:id", (c) => {
  const row = getDb().query(`SELECT ${LIBRARY_WITH_BYTES} WHERE library.id=?`).get(c.req.param("id")) as any;
  if (!row) return err(c, 404, "VIDEO_NOT_FOUND", "No such video");
  return c.json(row);
});

app.patch("/library/:id", async (c) => {
  const db = getDb();
  const row = db.query("SELECT * FROM library WHERE id=?").get(c.req.param("id")) as any;
  if (!row) return err(c, 404, "VIDEO_NOT_FOUND", "No such video");
  const body = await c.req.json().catch(() => ({}));
  const thumb = typeof body.thumbDataUrl === "string" ? body.thumbDataUrl : "";
  if (!thumb) return err(c, 422, "THUMB_REQUIRED", "thumbDataUrl is required");
  // Browser-captured JPEG/PNG only, ≤2 MB — same rules as import thumbs.
  const inline = parseDataUrl(thumb);
  if (!inline || !isAllowedImageMime(inline.mime) || !sniffImageMime(inline.bytes)) {
    return err(c, 422, "E_IMAGE_TYPE", `Thumbnail must be JPEG or PNG, got ${inline?.mime || "unknown"}`);
  }
  if (inline.bytes.length > 2000000) {
    return err(c, 422, "E_IMAGE_TOO_LARGE", "Thumbnail exceeds 2 MB");
  }
  db.query("UPDATE library SET thumb_url=?, updated_at=? WHERE id=?").run(thumb, nowIso(), row.id);
  return c.json({ ...(row as object), thumb_url: thumb });
});

app.delete("/library/:id", async (c) => {
  const db = getDb();
  const row = db.query("SELECT video_url FROM library WHERE id=?").get(c.req.param("id")) as { video_url: string } | null;
  if (!row) return err(c, 404, "VIDEO_NOT_FOUND", "No such video");
  db.query("DELETE FROM library WHERE id=?").run(c.req.param("id"));
  // Drop the server-hosted file too (GCS objects are left alone).
  const mid = mediaIdFromUrl(row.video_url);
  if (mid) await deleteMedia(mid);
  return c.json({ deleted: true });
});

const importSchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().max(500).default("Uploaded video"),
  resolution: z.enum(["720p", "1080p", "4K"]).default("720p"),
  aspect: z.enum(["16:9", "9:16"]).default("16:9"),
  durationSeconds: z.number().int().min(1).max(3600).default(8),
  audio: z.boolean().default(true),
  thumbDataUrl: z.string().max(2000000).default(""),
  mediaId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});

app.post("/library/import", async (c) => {
  const parsed = importSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return err(c, 422, "VALIDATION", "Invalid import", zodDetails(parsed.error));
  const db = getDb();
  if (!db.query("SELECT id FROM projects WHERE id=?").get(parsed.data.projectId)) {
    return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
  }
  let videoUrl = "";
  let resolution = parsed.data.resolution;
  let aspect = parsed.data.aspect;
  let durationSeconds = parsed.data.durationSeconds;
  let actualDuration: number | null = null;
  if (parsed.data.mediaId) {
    const hit = getMedia(parsed.data.mediaId);
    if (!hit) return err(c, 422, "MEDIA_NOT_FOUND", "Upload the file via POST /media/upload first");
    videoUrl = `/media/${parsed.data.mediaId}`;
    // Verify container server-side instead of trusting client-declared meta.
    try {
      const meta = await probeVideoMetadata(new Uint8Array(await Bun.file(hit.path).bytes()), hit.mime);
      const mapped = videoMetaToResAspect(meta.width, meta.height);
      resolution = mapped.res;
      aspect = mapped.aspect;
      durationSeconds = Math.max(1, Math.round(meta.durationSeconds));
      actualDuration = meta.durationSeconds > 0 ? Math.round(meta.durationSeconds * 10) / 10 : null;
    } catch (e) {
      logger.error({ mediaId: parsed.data.mediaId, err: String(e) }, "import probe failed, keeping client meta");
    }
  }
  const id = Bun.randomUUIDv7();
  const now = nowIso();
  db.query(
    `INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect,
      duration_seconds, actual_duration_seconds, audio, status, cost_estimate, video_url, thumb_url, inputs_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, parsed.data.projectId, `import-${id}`, "t2v", "import", parsed.data.prompt,
    resolution, aspect, durationSeconds, actualDuration,
    parsed.data.audio ? 1 : 0, "succeeded", 0, videoUrl, parsed.data.thumbDataUrl, "{}", now, now,
  );
  logger.info({ id, projectId: parsed.data.projectId, videoUrl }, "video imported");
  return c.json({ id }, 201);
});

// ---------- backup & restore ----------
app.get("/backup", async (c) => {
  const q = c.req.query();
  const opts = {
    elements: q.elements === "1",
    generated: q.generated === "1",
    uploads: q.uploads === "1",
    ...(q.projectId ? { projectId: q.projectId } : {}),
  };
  try {
    const { filename, path } = await buildBackupFile(opts);
    return new Response(Bun.file(path), {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e: any) {
    return err(c, e?.code === "E_BACKUP_TOO_LARGE" ? 413 : 500, e?.code ?? "BACKUP_FAILED", e?.message ?? "Backup failed");
  }
});

app.post("/restore", async (c) => {
  const up = await readUploadTmp(c);
  if (up === null) return err(c, 413, "BACKUP_TOO_LARGE", "Archive exceeds the 1 GB cap");
  if (typeof up !== "string") return err(c, 400, "FILE_REQUIRED", up.message);
  try {
    return c.json(await restoreBackupFile(up));
  } catch (e: any) {
    const code = e?.code ?? "RESTORE_FAILED";
    const status = code === "E_BACKUP_TOO_LARGE" ? 413 : 422;
    return err(c, status, code, e?.message ?? "Restore failed");
  } finally {
    removeBackupTmp(up);
  }
});

/** Inspect an archive without importing anything (confirm-before-restore). */
app.post("/restore/inspect", async (c) => {
  const up = await readUploadTmp(c);
  if (up === null) return err(c, 413, "BACKUP_TOO_LARGE", "Archive exceeds the 1 GB cap");
  if (typeof up !== "string") return err(c, 400, "FILE_REQUIRED", up.message);
  try {
    const { manifest, counts } = await inspectBackupFile(up);
    return c.json({ manifest, counts });
  } catch (e: any) {
    return err(c, 422, e?.code ?? "RESTORE_FAILED", e?.message ?? "Inspect failed");
  } finally {
    removeBackupTmp(up);
  }
});

/**
 * Stream an uploaded archive straight to disk (constant RAM) instead of
 * buffering it. Returns the temp path, null when over the cap, or a message.
 */
async function readUploadTmp(c: any): Promise<string | { message: string } | null> {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return { message: "Multipart field 'file' (.tar) is required" };
  if (file.size > BACKUP_MAX_BYTES) return null;
  if (!file.size) return { message: "Uploaded file is empty" };
  const path = `${backupTmpPath("upload")}.tar`;
  await Bun.write(path, (file as Blob).stream());
  return path;
}

// ---------- capabilities ----------
app.get("/models/capabilities", (c) => {
  const snap = capabilitiesSnapshot();
  return c.json({
    ...snap,
    pricingPerSecond: pricingTable(),
    defaults: { region: "us-central1", fps: 24, model: "veo-3.1-fast-generate-001" },
    retiring: snap.models.filter((m: any) => (m as any).retires).map((m: any) => m.id),
  });
});

// ---------- frames (MediaBunny, no ffmpeg) ----------
app.post("/frames/extract", async (c) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("video");
  if (!(file instanceof Blob)) return err(c, 400, "VIDEO_REQUIRED", "Multipart field 'video' is required");
  const count = Math.min(Math.max(Number(form?.get("count") ?? 3), 1), 10);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) return err(c, 400, "EMPTY_VIDEO", "Uploaded video is empty");
  if (bytes.length > 200 * 1024 * 1024) return err(c, 413, "VIDEO_TOO_LARGE", "Limit is 200MB");
  try {
    const result = await extractFrames(bytes, (file as File).type || "video/mp4", { count });
    logger.info(
      { duration: result.durationSeconds, frames: result.frames.length },
      "frames extracted",
    );
    return c.json(result);
  } catch (e: any) {
    logger.error({ err: e?.message }, "frame extraction failed");
    return err(c, 422, "EXTRACTION_FAILED", e?.message ?? "Could not decode video");
  }
});

app.get("/health", (c) => c.json({ ok: true, time: nowIso() }));

export type App = typeof app;
export { getModel };
