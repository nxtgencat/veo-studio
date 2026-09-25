// Async job manager: idempotent create, immediate return, background Vertex
// submission + polling. Driver is injectable so bun:test can verify the
// lifecycle without touching the network; production driver is real Vertex.

import { getDb, nowIso } from "./db.ts";
import { getModel } from "./capabilities.ts";
import { estimateCost } from "./pricing.ts";
import { validateJob, type JobInput } from "./validation.ts";
import { childLogger } from "./logger.ts";
import * as vertex from "./vertex.ts";

const log = childLogger({ module: "jobs" });

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Driver = {
  submit: (p: Parameters<typeof vertex.vertexSubmit>[0]) => Promise<string>;
  get: typeof vertex.vertexGet;
  cancel: typeof vertex.vertexCancel;
};

const prodDriver: Driver = {
  submit: vertex.vertexSubmit,
  get: vertex.vertexGet,
  cancel: vertex.vertexCancel,
};

let driver: Driver = prodDriver;

/** Test-only injection (bun:test). Production never calls this. */
export function setDriverForTests(d: Driver | null) {
  driver = d ?? prodDriver;
}

export type CreateResult =
  | { ok: true; jobId: string; deduped: boolean }
  | { ok: false; code: string; message: string; details?: unknown };

export function createJob(input: JobInput, idempotencyKey: string): CreateResult {
  const db = getDb();
  if (!idempotencyKey) {
    return { ok: false, code: "IDEMPOTENCY_REQUIRED", message: "Idempotency-Key header is required" };
  }
  const verr = validateJob(input);
  if (verr) return { ok: false, code: verr.code, message: verr.message };

  const existing = db
    .query("SELECT id FROM jobs WHERE project_id = ? AND idempotency_key = ?")
    .get(input.projectId, idempotencyKey) as { id: string } | null;
  if (existing) return { ok: true, jobId: existing.id, deduped: true };

  const project = db.query("SELECT id FROM projects WHERE id = ?").get(input.projectId);
  if (!project) return { ok: false, code: "PROJECT_NOT_FOUND", message: `No project ${input.projectId}` };

  const model = getModel(input.model)!;
  const cost = estimateCost({
    tier: model.tier,
    modelId: model.id,
    resolution: input.resolution,
    audio: input.audio,
    durationSeconds: input.durationSeconds,
    sampleCount: input.sampleCount,
  });

  const id = Bun.randomUUIDv7();
  const now = nowIso();
  const inputs = {
    imageAssetId: input.imageAssetId,
    firstFrameAssetId: input.firstFrameAssetId,
    lastFrameAssetId: input.lastFrameAssetId,
    refAssetIds: input.refAssetIds,
    sourceVideoId: input.sourceVideoId,
    seed: input.seed,
  };
  db.query(
    `INSERT INTO jobs (id, project_id, idempotency_key, mode, model, prompt, resolution, aspect,
      duration_seconds, audio, sample_count, seed, inputs_json, status, progress, cost_estimate,
      webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.projectId, idempotencyKey, input.mode, input.model, input.prompt,
    input.resolution, input.aspect, input.durationSeconds, input.audio ? 1 : 0,
    input.sampleCount, input.seed ?? null, JSON.stringify(inputs), "queued", 0,
    cost, input.webhookUrl ?? "", now, now,
  );
  log.info({ jobId: id, mode: input.mode, model: input.model, cost }, "job created");
  void runInBackground(id);
  return { ok: true, jobId: id, deduped: false };
}

async function runInBackground(jobId: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!row || row.status !== "queued") return;
  const now = nowIso();
  db.query("UPDATE jobs SET status='running', progress=5, updated_at=? WHERE id=?").run(now, jobId);
  log.info({ jobId }, "job running");

  try {
    const opName = await driver.submit({
      model: row.model,
      prompt: row.prompt,
      aspectRatio: row.aspect,
      resolution: row.resolution,
      durationSeconds: row.duration_seconds,
      audio: !!row.audio,
      sampleCount: row.sample_count,
      seed: row.seed ?? undefined,
    });
    db.query("UPDATE jobs SET vertex_operation=?, progress=15, updated_at=? WHERE id=?").run(
      opName, nowIso(), jobId,
    );
    await pollUntilDone(jobId, opName);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    log.error({ jobId, err: msg }, "job failed at submit");
    failJob(jobId, e?.code ? `${e.code}: ${msg}` : msg);
  }
}

async function pollUntilDone(jobId: string, opName: string) {
  const db = getDb();
  const maxAttempts = Number(process.env.JOB_POLL_ATTEMPTS ?? 120);
  const intervalMs = Number(process.env.JOB_POLL_MS ?? 5000);
  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(intervalMs);
    const cur = db.query("SELECT status FROM jobs WHERE id=?").get(jobId) as any;
    if (!cur || cur.status === "cancelled") return;
    try {
      const op = await driver.get(opName);
      const progress = Math.min(15 + Math.round(((i + 1) / maxAttempts) * 80), 95);
      db.query("UPDATE jobs SET progress=?, updated_at=? WHERE id=?").run(progress, nowIso(), jobId);
      if (op.done) {
        if (op.error) failJob(jobId, op.error);
        else succeedJob(jobId);
        return;
      }
    } catch (e: any) {
      log.error({ jobId, err: e?.message }, "poll error (will retry)");
    }
  }
  failJob(jobId, "POLL_TIMEOUT: Vertex operation did not complete in time; poll GET /jobs/:id to retry later");
}

function succeedJob(jobId: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
  if (!row) return;
  const now = nowIso();
  db.query("UPDATE jobs SET status='succeeded', progress=100, updated_at=? WHERE id=?").run(now, jobId);
  const libId = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect,
      duration_seconds, audio, status, cost_estimate, inputs_json, vertex_operation, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    libId, row.project_id, jobId, row.mode, row.model, row.prompt, row.resolution, row.aspect,
    row.duration_seconds, row.audio, "succeeded", row.cost_estimate, row.inputs_json,
    row.vertex_operation, now, now,
  );
  log.info({ jobId, libId }, "job succeeded");
  fireWebhook(row.webhook_url, { jobId, status: "succeeded", libraryId: libId });
}

function failJob(jobId: string, error: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
  db.query("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?").run(error, nowIso(), jobId);
  log.error({ jobId, error }, "job failed");
  if (row?.webhook_url) fireWebhook(row.webhook_url, { jobId, status: "failed", error });
}

function fireWebhook(url: string, payload: Record<string, unknown>) {
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-veo-event": "job.completed" },
    body: JSON.stringify({ ...payload, at: nowIso() }),
  }).catch((e) => log.error({ url, err: String(e) }, "webhook delivery failed"));
}

export async function cancelJob(jobId: string): Promise<
  | { ok: true; status: "cancelled" | "already_done" }
  | { ok: false; code: string; message: string }
> {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
  if (!row) return { ok: false, code: "JOB_NOT_FOUND", message: `No job ${jobId}` };
  if (row.status === "succeeded" || row.status === "failed") {
    // Vertex race: already terminal locally. If a Vertex op exists, confirm.
    if (row.vertex_operation) {
      try {
        const r = await driver.cancel(row.vertex_operation);
        if (r.alreadyDone) return { ok: true, status: "already_done" };
      } catch { /* fall through */ }
    }
    return { ok: true, status: "already_done" };
  }
  if (row.vertex_operation) {
    try {
      const r = await driver.cancel(row.vertex_operation);
      if (r.alreadyDone) {
        succeedJob(jobId);
        return { ok: true, status: "already_done" };
      }
    } catch (e: any) {
      return { ok: false, code: "CANCEL_FAILED", message: e?.message ?? String(e) };
    }
  }
  db.query("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?").run(nowIso(), jobId);
  log.info({ jobId }, "job cancelled (no output => no per-second charge)");
  return { ok: true, status: "cancelled" };
}

export function getJob(jobId: string) {
  return getDb().query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
}
