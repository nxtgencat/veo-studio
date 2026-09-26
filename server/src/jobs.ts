// Async job manager: idempotent create, immediate return, background Vertex
// submission + polling. Driver is injectable so bun:test can verify the
// lifecycle without touching the network; production driver is real Vertex.

import { getDb, nowIso } from "./db.ts";
import { getModel } from "./capabilities.ts";
import { getSettings, resolveAuth } from "./auth.ts";
import { downloadGcsUri } from "./gcs.ts";
import { elementImageBytes, IMAGE_MAX_BYTES } from "./images.ts";
import { fallbackEtaMs, measuredEtaMs } from "./pricing.ts";
import { getMedia, MEDIA_MAX_BYTES, mediaIdFromUrl, saveMedia } from "./media-store.ts";
import { probeVideoMetadata } from "./frames.ts";
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
async function driverFor(projectId: string, model: string): Promise<Driver> {
  const auth = await resolveAuth(projectId);
  const ctx = async (): Promise<vertex.VertexCtx> => ({
    project: auth.project,
    location: auth.location,
    token: await auth.getToken(),
  });
  return {
    submit: async (p) => vertex.vertexSubmit(p, await ctx()),
    get: async (n) => vertex.vertexFetchOp(model, n, await ctx()),
    cancel: async (n) => vertex.vertexCancel(n, await ctx(), model || undefined),
  };
}

async function activeDriver(projectId: string, model?: string): Promise<Driver | null> {
  if (testDriver) return testDriver;
  try {
    return await driverFor(projectId, model ?? "");
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
    enhancePrompt: input.enhancePrompt ?? true,
  };
  db.query(
    `INSERT INTO jobs (id, project_id, idempotency_key, mode, model, prompt, resolution, aspect,
      duration_seconds, audio, sample_count, seed, inputs_json, status, progress, cost_estimate,
      webhook_url, person, negative_prompt, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.projectId, idempotencyKey, input.mode, input.model, input.prompt,
    input.resolution, input.aspect, input.durationSeconds, input.audio ? 1 : 0,
    input.sampleCount, input.seed ?? null, JSON.stringify(inputs), "queued", 0,
    cost, input.webhookUrl ?? "", input.person ?? "allow_adult", input.negativePrompt ?? "", now, now,
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

async function runInBackground(jobId: string, resumeOp?: string) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id = ?").get(jobId) as any;
  if (!row || row.status !== "queued") return;
  const now = nowIso();
  db.query("UPDATE jobs SET status='running', progress=5, updated_at=? WHERE id=?").run(now, jobId);
  log.info({ jobId }, "job running");

  const d = await activeDriver(row.project_id, row.model);
  if (!d) {
    failJob(jobId, authErrorHint(row.project_id));
    return;
  }

  try {
    if (resumeOp) {
      // Crash recovery: the Vertex operation already exists — poll it,
      // never resubmit (resubmitting would double-spend).
      await pollUntilDone(jobId, resumeOp, d);
      return;
    }
    const params: vertex.VertexSubmitParams = {
      model: row.model,
      prompt: row.prompt,
      aspectRatio: row.aspect,
      resolution: row.resolution,
      durationSeconds: row.duration_seconds,
      audio: !!row.audio,
      sampleCount: row.sample_count,
      seed: row.seed ?? undefined,
      person: row.person === "disallow" ? "disallow" : "allow_adult",
      negativePrompt: row.negative_prompt ?? undefined,
      enhancePrompt: (JSON.parse(row.inputs_json || "{}") as { enhancePrompt?: boolean }).enhancePrompt ?? true,
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
    if (row.mode === "f2v" && params.imageBytes && params.lastFrameBytes) {
      const bad = await framesAspectMismatch(params.imageBytes, params.lastFrameBytes, row.aspect);
      if (bad) {
        failJob(
          jobId,
          `FRAMES_ASPECT_MISMATCH: both stills must match the ${row.aspect} output — one still is ${bad}.`,
        );
        return;
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
    db.query("UPDATE jobs SET vertex_operation=?, submitted_at=?, progress=15, updated_at=? WHERE id=?").run(
      opName, nowIso(), nowIso(), jobId,
    );
    await pollUntilDone(jobId, opName, d);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    log.error({ jobId, err: msg }, "job failed at submit");
    failJob(jobId, e?.code ? `${e.code}: ${msg}` : msg);
  }
}

/**
 * Crash recovery, called once at boot. Jobs interrupted mid-flight:
 * - with a Vertex operation → resume polling it (never resubmit: no double spend).
 * - without one → failed/SERVER_RESTARTED (Vertex was never called: no charge).
 * Returns counts for the boot log.
 */
export async function recoverInterrupted(): Promise<{ resumed: number; expired: number }> {
  const db = getDb();
  const rows = db.query("SELECT id, vertex_operation FROM jobs WHERE status IN ('queued','running')").all() as {
    id: string;
    vertex_operation: string;
  }[];
  let resumed = 0;
  let expired = 0;
  for (const r of rows) {
    if (r.vertex_operation) {
      db.query("UPDATE jobs SET status='queued', updated_at=? WHERE id=?").run(nowIso(), r.id);
      log.info({ jobId: r.id, op: r.vertex_operation }, "resuming interrupted job");
      const task = runInBackground(r.id, r.vertex_operation);
      inflight.add(task);
      void task
        .catch((e) => log.error({ jobId: r.id, err: String(e) }, "recovered task crashed"))
        .finally(() => inflight.delete(task));
      resumed++;
    } else {
      failJob(
        r.id,
        "SERVER_RESTARTED: server restarted before this job reached Vertex — nothing was generated, no charge. Resubmit to try again.",
      );
      expired++;
    }
  }
  return { resumed, expired };
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

/** Frames pairing via Bun.Image header metadata (no full decode). Lenient: unreadable stills skip. */
async function framesAspectMismatch(
  firstB64: string,
  lastB64: string,
  aspect: string,
): Promise<"portrait" | "landscape" | null> {
  const landscape = aspect === "16:9";
  try {
    for (const b64 of [firstB64, lastB64]) {
      const meta = await new Bun.Image(Uint8Array.fromBase64(b64)).metadata();
      if (!meta.width || !meta.height || meta.width === meta.height) continue;
      const isLandscape = meta.width > meta.height;
      if (isLandscape !== landscape) return isLandscape ? "landscape" : "portrait";
    }
  } catch {
    return null;
  }
  return null;
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
  let notFoundStreak = 0;
  for (let i = 0; i < maxAttempts; i++) {
    await Bun.sleep(intervalMs);
    const cur = db.query("SELECT status, progress, model, resolution, submitted_at FROM jobs WHERE id=?").get(jobId) as any;
    if (!cur || cur.status === "cancelled") return;
    // Progress is elapsed-vs-ETA and monotonic: it advances even when
    // individual polls fail, and never steps back below a shown value.
    const { etaMs } = jobEta(cur.model, cur.resolution);
    const elapsed = cur.submitted_at ? Math.max(0, Date.now() - Date.parse(cur.submitted_at)) : 0;
    const computed = etaMs > 0 ? Math.min(95, 5 + Math.round((elapsed / etaMs) * 90)) : 15;
    const progress = Math.max(Number(cur.progress) || 0, computed);
    db.query("UPDATE jobs SET progress=?, updated_at=? WHERE id=?").run(progress, nowIso(), jobId);
    try {
      const op = await d.get(opName);
      notFoundStreak = 0;
      if (op.done) {
        if (op.error) failJob(jobId, op.error);
        else await succeedJob(jobId, op.videoUris ?? [], op.videoBytes);
        return;
      }
    } catch (e: any) {
      if ((e as { status?: number })?.status === 404) {
        // Google doesn't transiently 404 existing resources: the operation is gone.
        notFoundStreak++;
        log.error({ jobId, opName, streak: notFoundStreak }, "operation not found on Vertex");
        if (notFoundStreak >= 5) {
          failJob(
            jobId,
            `VERTEX_OP_GONE: Vertex reports operation ${opName} as not found (404 ×5). ` +
              "It may have expired — otherwise check VERTEXAI_LOCATION matches the submit region " +
              "and the service-account project owns the operation. No output was produced, no charge.",
          );
          return;
        }
      } else {
        notFoundStreak = 0;
        log.error({ jobId, err: e?.message }, "poll error (will retry)");
      }
    }
  }
  failJob(jobId, "POLL_TIMEOUT: Vertex operation did not complete in time; poll GET /jobs/:id to retry later");
}

/** Elapsed ms since submit — folded into terminal UPDATEs so success/failure cost one write. */
function terminalMs(submittedAt: string): number {
  return submittedAt ? Math.max(0, Date.now() - Date.parse(submittedAt)) : 0;
}

async function succeedJob(
  jobId: string,
  videoUris: string[] = [],
  inline?: { base64: string; mime: string },
) {
  const db = getDb();
  const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
  if (!row) return;
  // Materialize FIRST: the status flip + duration stamp + library insert below
  // are synchronous back-to-back, so pollers never observe succeeded-without-
  // a-row (the vanish gap). Archival stays best-effort, never fails the job.
  const gs = videoUris.find((u) => u.startsWith("gs://")) ?? "";
  const stored = await materializeOutput(row.project_id, gs, inline);
  const now = nowIso();
  const libId = Bun.randomUUIDv7();  // Extend appends +7s to the source: the library row must carry the TOTAL
  // (8s source -> 15s row, chained 15s -> 22s), not just the 7s chunk.
  // Resolved from the DB so chains stay correct even if the client sent a
  // stale duration. Falls back to the job chunk when the source is gone.
  let durTotal = row.duration_seconds;
  if (row.mode === "extend") {
    try {
      const inputs = JSON.parse(row.inputs_json || "{}") as { sourceVideoId?: string };
      if (inputs.sourceVideoId) {
        const src = db.query("SELECT duration_seconds FROM library WHERE id=?").get(inputs.sourceVideoId) as {
          duration_seconds: number;
        } | null;
        if (src && Number.isFinite(src.duration_seconds)) durTotal = src.duration_seconds + 7;
      }
    } catch { /* keep chunk duration */ }
  }
  db.query("UPDATE jobs SET status='succeeded', progress=100, duration_ms=?, updated_at=? WHERE id=?").run(
    terminalMs(row.submitted_at), now, jobId,
  );
  db.query(
    `INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect,
      duration_seconds, actual_duration_seconds, audio, status, cost_estimate, video_url, gcs_uri, person, negative_prompt, inputs_json, vertex_operation, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    libId, row.project_id, jobId, row.mode, row.model, row.prompt, row.resolution, row.aspect,
    durTotal, stored.actualDuration, row.audio, "succeeded", row.cost_estimate, stored.url, gs,
    row.person ?? "allow_adult", row.negative_prompt ?? "", row.inputs_json,
    row.vertex_operation, now, now,
  );
  log.info({ jobId, libId, videoUrl: stored.url }, "job succeeded");
  fireWebhook(row.webhook_url, { jobId, status: "succeeded", libraryId: libId, videoUris });
}

/**
 * Persist output bytes server-side so videos survive reloads, stay playable
 * and can feed Extend. Prefers the GCS object; falls back to the inline
 * payload. Probes the container (demux-only, no decode) for the DELIVERED
 * duration — Vertex routinely returns less than requested, so requested ≠ got.
 * Never throws — archival must not fail a successful generation.
 */
async function materializeOutput(
  projectId: string,
  gsUri: string,
  inline?: { base64: string; mime: string },
): Promise<{ url: string; actualDuration: number | null }> {
  const probe = async (bytes: Uint8Array, mime: string): Promise<number | null> => {
    try {
      const meta = await probeVideoMetadata(bytes, mime);
      return meta.durationSeconds > 0 ? Math.round(meta.durationSeconds * 10) / 10 : null;
    } catch {
      return null;
    }
  };
  try {
    if (gsUri) {
      const token = await resolveAuth(projectId).then((a) => a.getToken());
      const { bytes, mime } = await downloadGcsUri(gsUri, token);
      const saved = await saveMedia(bytes, mime);
      return { url: saved.url, actualDuration: await probe(bytes, mime) };
    }
    if (inline) {
      const raw = Uint8Array.fromBase64(inline.base64);
      if (raw.length > 0 && raw.length <= MEDIA_MAX_BYTES) {
        const saved = await saveMedia(raw, inline.mime);
        return { url: saved.url, actualDuration: await probe(raw, inline.mime) };
      }
    }
  } catch (e: any) {
    log.error({ projectId, err: e?.message ?? String(e) }, "output archival skipped");
  }
  return { url: gsUri, actualDuration: null };
}

function failJob(jobId: string, error: string) {
  try {
    const db = getDb();
    const row = db.query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
    db.query("UPDATE jobs SET status='failed', error=?, duration_ms=?, updated_at=? WHERE id=?").run(
      error, terminalMs(row?.submitted_at ?? ""), nowIso(), jobId,
    );
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
  const d = testDriver ?? (await activeDriver(row.project_id, row.model));
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

/** ETA for a model: measured median of recent successes, else tier fallback. */
export function jobEta(modelId: string, resolution: string): { etaMs: number; source: "measured" | "estimated" } {
  const model = getModel(modelId);
  const rows = getDb()
    .query("SELECT duration_ms FROM jobs WHERE model=? AND status='succeeded' AND duration_ms > 0 ORDER BY created_at DESC LIMIT 20")
    .all(modelId) as { duration_ms: number }[];
  const measured = measuredEtaMs(rows.map((r) => r.duration_ms));
  if (measured) return { etaMs: measured, source: "measured" };
  const tier = (model?.tier ?? "Fast") as "Standard" | "Fast" | "Lite" | "Legacy";
  const res = (resolution === "4K" ? "4K" : resolution === "1080p" ? "1080p" : "720p") as "720p" | "1080p" | "4K";
  return { etaMs: fallbackEtaMs(tier, res), source: "estimated" };
}

/** Elapsed ms since Vertex submit (0 before submit / for legacy rows). */
export function jobElapsedMs(row: { submitted_at?: string; status: string; duration_ms?: number }): number {
  if ((row.status === "succeeded" || row.status === "failed") && row.duration_ms) return row.duration_ms;
  if (!row.submitted_at) return 0;
  return Math.max(0, Date.now() - Date.parse(row.submitted_at));
}

export function getJob(jobId: string) {
  return getDb().query("SELECT * FROM jobs WHERE id=?").get(jobId) as any;
}
