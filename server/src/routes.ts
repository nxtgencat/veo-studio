import { Hono } from "hono";
import { z } from "zod";
import { getDb, nowIso } from "./db.ts";
import { capabilitiesSnapshot, getModel } from "./capabilities.ts";
import { pricingTable } from "./pricing.ts";
import { jobInputSchema, zodDetails } from "./validation.ts";
import { cancelJob, createJob, getJob } from "./jobs.ts";
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

// ---------- projects ----------
app.post("/projects", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Untitled project";
  const id = Bun.randomUUIDv7();
  const now = nowIso();
  getDb().query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)").run(id, name, now, now);
  return c.json({ id, name, createdAt: now }, 201);
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

app.delete("/projects/:id", (c) => {
  const r = getDb().query("DELETE FROM projects WHERE id=?").run(c.req.param("id"));
  if (!r.changes) return err(c, 404, "PROJECT_NOT_FOUND", "No such project");
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
  db.query("UPDATE elements SET name=?, image_url=?, note=? WHERE id=?").run(name, imageUrl, note, row.id);
  return c.json({ ...row, name, image_url: imageUrl, note });
});

app.delete("/elements/:id", (c) => {
  const r = getDb().query("DELETE FROM elements WHERE id=?").run(c.req.param("id"));
  if (!r.changes) return err(c, 404, "ELEMENT_NOT_FOUND", "No such element");
  return c.json({ deleted: true });
});

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

function formatJob(row: any) {
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
    status: row.status,
    progress: row.progress,
    error: row.error,
    costEstimate: row.cost_estimate,
    vertexOperation: row.vertex_operation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- library ----------
app.get("/library", (c) => {
  const projectId = c.req.query("projectId");
  const db = getDb();
  const rows = projectId
    ? (db.query("SELECT * FROM library WHERE project_id=? ORDER BY created_at DESC").all(projectId) as any[])
    : (db.query("SELECT * FROM library ORDER BY created_at DESC LIMIT 200").all() as any[]);
  return c.json({ videos: rows });
});

app.get("/library/:id", (c) => {
  const row = getDb().query("SELECT * FROM library WHERE id=?").get(c.req.param("id")) as any;
  if (!row) return err(c, 404, "VIDEO_NOT_FOUND", "No such video");
  return c.json(row);
});

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
