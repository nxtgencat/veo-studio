// Async job manager: idempotent create, immediate return, background Vertex
// submission + polling. Driver is injectable so bun:test can verify the
// lifecycle without touching the network; production driver is real Vertex.

import { getDb, nowIso } from "./db.ts";
import { getModel } from "./capabilities.ts";
import { getSettings, resolveAuth } from "./auth.ts";
import { downloadGcsUri } from "./gcs.ts";
import { elementImageBytes, IMAGE_MAX_BYTES } from "./images.ts";
import { getMedia, MEDIA_MAX_BYTES, mediaIdFromUrl, saveMedia } from "./media-store.ts";
import { estimateCost } from "./pricing.ts";
import { validateJob, type JobInput } from "./validation.ts";
import { childLogger } from "./logger.ts";
import * as vertex from "./vertex.ts";

const log = childLogger({ module: "jobs" });

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type Driver = {
  submit: (p: vertex.VertexSubmitParams) => Promise<string>;
  get: (name: string) => Promise<{
    name: string;
    done: boolean;
    error?: string;
    videoUris: string[];
    videoBytes?: { base64: string; mime: string };
  }>;
  cancel: (name: string) => Promise<{ cancelled: boolean; alreadyDone: boolean }>;
};

let testDriver: Driver | null = null;

/** Test-only injection (bun:test). Production never calls this. */
export function setDriverForTests(d: Driver | null) {
  testDriver = d;
}

// In-flight background tasks. Tests await settleBackground() so no task
// outlives its test and trips over the next test's fresh database.
const inflight = new Set<Promise<unknown>>();

export async function settleBackground(): Promise<void> {
  while (inflight.size > 0) {
    await Promise.allSettled([...inflight]);
  }
}

/** Per-project driver: SA auth (default) or env creds, token minted per call (cached). */
async function driverFor(projectId: string): Promise<Driver> {
  const auth = await resolveAuth(projectId);
  const ctx = async (): Promise<vertex.VertexCtx> => ({
    project: auth.project,
    location: auth.location,
    token: await auth.getToken(),
  });
  return {
    submit: async (p) => vertex.vertexSubmit(p, await ctx()),
    get: async (n) => vertex.vertexGet(n, await ctx()),
    cancel: async (n) => vertex.vertexCancel(n, await ctx()),
  };
}

async function activeDriver(projectId: string): Promise<Driver | null> {
  if (testDriver) return testDriver;
  try {
    return await driverFor(projectId);
  } catch {
    return null;
  }
}

export type CreateResult =
  | { ok: true; jobId: string; deduped: boolean }
  | { ok: false; code: string; message: string; details?: unknown };

// Inline extend bytes ride in memory only (never persisted to sqlite):
// large Base64 blobs don't belong in job rows or provenance records.
const pendingBytes = new Map<string, { bytes: string; mime: string }>();

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
    sourceVideoGcsUri: input.sourceVideoGcsUri,
    hasSourceVideoBytes: !!input.sourceVideoBytes,
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
  if (input.mode === "extend" && input.sourceVideoBytes) {
    pendingBytes.set(id, { bytes: input.sourceVideoBytes, mime: input.sourceVideoMimeType ?? "video/mp4" });
  }
  // Never let a background crash surface as an unhandled rejection
  // (e.g. DB reset under test teardown while a poll is in flight).
  const task = runInBackground(id);
  inflight.add(task);
  void task
    .catch((e) => log.error({ jobId: id, err: String(e) }, "background task crashed"))
    .finally(() => inflight.delete(task));
  return { ok: true, jobId: id, deduped: false };
}

async function runInBackground(jobId: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!row || row.status !== "queued") return;
  const now = nowIso();
  db.query("UPDATE jobs SET status='running', progress=5, updated_at=? WHERE id=?").run(now, jobId);
  log.info({ jobId }, "job running");

  const d = await activeDriver(row.project_id);
  if (!d) {
    failJob(jobId, authErrorHint(row.project_id));
    return;
  }

  try {
    const params: vertex.VertexSubmitParams = {
      model: row.model,
      prompt: row.prompt,
      aspectRatio: row.aspect,
      resolution: row.resolution,
      durationSeconds: row.duration_seconds,
      audio: !!row.audio,
      sampleCount: row.sample_count,
      seed: row.seed ?? undefined,
    };
    const settings = getSettings(row.project_id);
    if (settings.useBucket && settings.bucket) {
      // Vertex writes output files straight to the bucket.
      params.storageUri = `gs://${settings.bucket}/veo/`;
    }
    if (row.mode === "i2v" || row.mode === "f2v" || row.mode === "r2v") {
      // Resolve element IDs to transmittable bytes (≤20 MB JPEG/PNG each).
      const inputs = JSON.parse(row.inputs_json || "{}") as {
        imageAssetId?: string;
        firstFrameAssetId?: string;
        lastFrameAssetId?: string;
        refAssetIds?: string[];
      };
      const need = [
        inputs.imageAssetId,
        inputs.firstFrameAssetId,
        inputs.lastFrameAssetId,
        ...(inputs.refAssetIds ?? []),
      ].filter(Boolean) as string[];
      const seen = new Map<string, { base64: string; mime: string }>();
      for (const id of need) {
        if (!seen.has(id)) seen.set(id, await elementImageBytes(id, row.project_id));
      }
      const get = (id?: string) => (id ? seen.get(id) : undefined);
      const first = get(inputs.imageAssetId ?? inputs.firstFrameAssetId);
      if (first) {
        params.imageBytes = first.base64;
        params.imageMimeType = first.mime;
      }
      const last = get(inputs.lastFrameAssetId);
      if (last) {
        params.lastFrameBytes = last.base64;
        params.lastFrameMimeType = last.mime;
      }
      const refs = (inputs.refAssetIds ?? [])
        .map((id) => seen.get(id))
        .filter((x): x is { base64: string; mime: string } => !!x);
      if (refs.length) {
        params.referenceImages = refs.map((r) => ({ bytes: r.base64, mimeType: r.mime }));
      }
    }
    if (row.mode === "extend") {
      const src = await resolveExtendSource(row);
      if (!src) {
        failJob(
          jobId,
          "EXTEND_NEEDS_SOURCE: extend needs the source video as sourceVideoGcsUri (gs://…, recommended), " +
            "a library video saved on this server, or inline sourceVideoBytes (≤20 MB).",
        );
        return;
      }
      if (src.diskTooBig) {
        failJob(
          jobId,
          `EXTEND_SOURCE_TOO_BIG: source is ${(src.diskTooBig / 1048576).toFixed(1)} MB on this server — ` +
            "inline extend caps at 20 MB. Put the file in your bucket and pass sourceVideoGcsUri.",
        );
        return;
      }
      if (src.gcsUri) params.sourceVideoGcsUri = src.gcsUri;
      else {
        params.sourceVideoBytes = src.bytes;
        params.sourceVideoMimeType = src.mime;
      }
    }
    const opName = await d.submit(params);
    db.query("UPDATE jobs SET vertex_operation=?, progress=15, updated_at=? WHERE id=?").run(
      opName, nowIso(), jobId,
    );
    await pollUntilDone(jobId, opName, d);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    log.error({ jobId, err: msg }, "job failed at submit");
    failJob(jobId, e?.code ? `${e.code}: ${msg}` : msg);
  }
}

function authErrorHint(projectId: string): string {
  try {
    const s = getSettings(projectId);
    if (s.authMode === "env") {
      return "E_VERTEX_NOT_CONFIGURED: environment auth selected but GOOGLE_CLOUD_PROJECT / VERTEX_ACCESS_TOKEN are missing";
    }
    return "E_SA_MISSING: No service account configured — paste service account JSON in Settings → Google Cloud connection";
  } catch (e: any) {
    return e?.code ? `${e.code}: ${e.message}` : String(e);
  }
}

/** Extend source: explicit GCS URI, chained output, on-disk bytes, inline bytes. */
async function resolveExtendSource(
  row: any,
): Promise<{ gcsUri?: string; bytes?: string; mime?: string; diskTooBig?: number } | null> {
  try {
    const inputs = JSON.parse(row.inputs_json || "{}") as { sourceVideoGcsUri?: string; sourceVideoId?: string };
    if (inputs.sourceVideoGcsUri?.startsWith("gs://")) return { gcsUri: inputs.sourceVideoGcsUri };
    const inline = pendingBytes.get(row.id);
    if (inline) {
      pendingBytes.delete(row.id);
      return { bytes: inline.bytes, mime: inline.mime };
    }
    if (inputs.sourceVideoId) {
      const src = getDb()
        .query("SELECT video_url, gcs_uri FROM library WHERE id=?")
        .get(inputs.sourceVideoId) as { video_url: string; gcs_uri: string } | null;
      const gcs = src?.gcs_uri?.startsWith("gs://")
        ? src.gcs_uri
        : src?.video_url?.startsWith("gs://")
          ? src.video_url
          : "";
      if (gcs) return { gcsUri: gcs };
      const mid = src?.video_url ? mediaIdFromUrl(src.video_url) : null;
      if (mid) {
        const file = getMedia(mid);
        if (file) {
          if (file.bytes > IMAGE_MAX_BYTES) return { diskTooBig: file.bytes };
          const raw = await Bun.file(file.path).bytes();
          return { bytes: raw.toBase64(), mime: file.mime };
        }
      }
    }
  } catch { /* fall through */ }
  return null;
}

async function pollUntilDone(jobId: string, opName: string, d: Driver) {
  const db = getDb();
  const maxAttempts = Number(process.env.JOB_POLL_ATTEMPTS ?? 120);
  const intervalMs = Number(process.env.JOB_POLL_MS ?? 5000);
  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(intervalMs);
    const cur = db.query("SELECT status FROM jobs WHERE id=?").get(jobId) as any;
    if (!cur || cur.status === "cancelled") return;
    try {
      const op = await d.get(opName);
      const progress = Math.min(15 + Math.round(((i + 1) / maxAttempts) * 80), 95);
      db.query("UPDATE jobs SET progress=?, updated_at=? WHERE id=?").run(progress, nowIso(), jobId);
      if (op.done) {
        if (op.error) failJob(jobId, op.error);
        else await succeedJob(jobId, op.videoUris ?? [], op.videoBytes);
        return;
      }
    } catch (e: any) {
      log.error({ jobId, err: e?.message }, "poll error (will retry)");
    }
  }
  failJob(jobId, "POLL_TIMEOUT: Vertex operation did not complete in time; poll GET /jobs/:id to retry later");
}

async function succeedJob(
  jobId: string,
  videoUris: string[] = [],
  inline?: { base64: string; mime: string },
) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
  if (!row) return;
  const now = nowIso();
  db.query("UPDATE jobs SET status='succeeded', progress=100, updated_at=? WHERE id=?").run(now, jobId);
  const gs = videoUris.find((u) => u.startsWith("gs://")) ?? "";
  const stored = await materializeOutput(row.project_id, gs, inline);
  const libId = Bun.randomUUIDv7();
  db.query(
    `INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect,
      duration_seconds, audio, status, cost_estimate, video_url, gcs_uri, inputs_json, vertex_operation, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    libId, row.project_id, jobId, row.mode, row.model, row.prompt, row.resolution, row.aspect,
    row.duration_seconds, row.audio, "succeeded", row.cost_estimate, stored.url, gs, row.inputs_json,
    row.vertex_operation, now, now,
  );
  log.info({ jobId, libId, videoUrl: stored.url }, "job succeeded");
  fireWebhook(row.webhook_url, { jobId, status: "succeeded", libraryId: libId, videoUris });
}

/**
 * Persist output bytes server-side so videos survive reloads, stay playable
 * and can feed Extend. Prefers the GCS object; falls back to the inline
 * payload. Never throws — archival must not fail a successful generation.
 */
async function materializeOutput(
  projectId: string,
  gsUri: string,
  inline?: { base64: string; mime: string },
): Promise<{ url: string }> {
  try {
    if (gsUri) {
      const token = await resolveAuth(projectId).then((a) => a.getToken());
      const { bytes, mime } = await downloadGcsUri(gsUri, token);
      return { url: (await saveMedia(bytes, mime)).url };
    }
    if (inline) {
      const raw = Uint8Array.fromBase64(inline.base64);
      if (raw.length > 0 && raw.length <= MEDIA_MAX_BYTES) {
        return { url: (await saveMedia(raw, inline.mime)).url };
      }
    }
  } catch (e: any) {
    log.error({ projectId, err: e?.message ?? String(e) }, "output archival skipped");
  }
  return { url: gsUri };
}

function failJob(jobId: string, error: string) {
  try {
    const db = getDb();
    const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
    db.query("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?").run(error, nowIso(), jobId);
    log.error({ jobId, error }, "job failed");
    if (row?.webhook_url) fireWebhook(row.webhook_url, { jobId, status: "failed", error });
  } catch (e) {
    log.error({ jobId, error, err: String(e) }, "failJob bookkeeping failed");
  }
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
  const d = testDriver ?? (await activeDriver(row.project_id));
  if (!d) {
    return {
      ok: false,
      code: "AUTH_UNCONFIGURED",
      message: `Cannot reach Vertex to cancel: ${authErrorHint(row.project_id)}`,
    };
  }
  if (row.status === "succeeded" || row.status === "failed") {
    // Vertex race: already terminal locally. If a Vertex op exists, confirm.
    if (row.vertex_operation) {
      try {
        const r = await d.cancel(row.vertex_operation);
        if (r.alreadyDone) return { ok: true, status: "already_done" };
      } catch { /* fall through */ }
    }
    return { ok: true, status: "already_done" };
  }
  if (row.vertex_operation) {
    try {
      const r = await d.cancel(row.vertex_operation);
      if (r.alreadyDone) {
        await succeedJob(jobId);
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
