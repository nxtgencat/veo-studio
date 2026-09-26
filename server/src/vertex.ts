// Real Vertex AI adapter. No mocks: every network call below hits Google.
// Auth (project + Bearer token) comes from the caller's ResolvedAuth —
// service-account JSON by default, env creds only when toggled per project.

import { logger } from "./logger.ts";

const log = logger.child({ module: "vertex" });

export interface VertexCtx {
  project: string;
  location: string;
  token: string;
}

export type VertexSubmitParams = {
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  durationSeconds: number;
  audio: boolean;
  sampleCount: number;
  seed?: number;
  person?: "allow_adult" | "dont_allow";
  negativePrompt?: string;
  /** Prompt rewriting (Veo "enhance prompt") — default on. */
  enhancePrompt?: boolean;
  /** First-frame still (i2v, or the start of an f2v pair). */
  imageBytes?: string;
  imageMimeType?: string;
  /** End-frame still (f2v only). */
  lastFrameBytes?: string;
  lastFrameMimeType?: string;
  /** Subject/style references (r2v, up to 3, type asset). */
  referenceImages?: { bytes: string; mimeType: string }[];
  /** Extend source already in Cloud Storage. */
  sourceVideoGcsUri?: string;
  /** Inline extend source (SDK-legal, fragile past a few MB — prefer GCS). */
  sourceVideoBytes?: string;
  sourceVideoMimeType?: string;
  /** gs://bucket/prefix/ — Vertex writes outputs here instead of returning bytes. */
  storageUri?: string;
};

export type VertexOperation = {
  name: string;
  done: boolean;
  error?: string;
  videoUris: string[];
  /** First inline payload found (no-bucket outputs), capped — may be absent. */
  videoBytes?: { base64: string; mime: string };
  /** Responsible-AI filtering: outputs blocked, nothing downloadable. */
  raiFiltered?: { count: number; reasons: string[] };
  /** Top-level response keys (diagnostics for unrecognized shapes). */
  responseKeys?: string[];
};

export const INLINE_RESPONSE_MAX = 100 * 1024 * 1024;

/** Shared non-OK mapping: first 500 chars of the body + status. */
async function vertexErr(res: Response, code: string, what: string): Promise<never> {
  const text = await res.text();
  throw Object.assign(new Error(`${what}: ${res.status} ${text.slice(0, 500)}`), { code, status: res.status });
}

export async function vertexSubmit(params: VertexSubmitParams, ctx: VertexCtx): Promise<string> {
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1/projects/${ctx.project}/locations/${ctx.location}/publishers/google/models/${params.model}:predictLongRunning`;
  const instances: Record<string, unknown>[] = [{ prompt: params.prompt }];
  const first = instances[0] as Record<string, unknown>;
  if (params.imageBytes) {
    first.image = {
      bytesBase64Encoded: params.imageBytes,
      mimeType: params.imageMimeType ?? "image/png",
    };
  }
  if (params.lastFrameBytes) {
    first.lastFrame = {
      bytesBase64Encoded: params.lastFrameBytes,
      mimeType: params.lastFrameMimeType ?? "image/png",
    };
  }
  if (params.referenceImages?.length) {
    first.referenceImages = params.referenceImages.map((r) => ({
      image: { bytesBase64Encoded: r.bytes, mimeType: r.mimeType },
      referenceType: "asset",
    }));
  }
  if (params.sourceVideoGcsUri) {
    first.video = { gcsUri: params.sourceVideoGcsUri, mimeType: "video/mp4" };
  } else if (params.sourceVideoBytes) {
    first.video = {
      bytesBase64Encoded: params.sourceVideoBytes,
      mimeType: params.sourceVideoMimeType ?? "video/mp4",
    };
  }
  const parameters: Record<string, unknown> = {
    aspectRatio: params.aspectRatio,
    durationSeconds: params.durationSeconds,
    sampleCount: params.sampleCount,
  };
  // Wire format is lowercase "4k" (docs list "720p"/"1080p"/"4k"); UI uses "4K".
  if (params.resolution) parameters.resolution = params.resolution === "4K" ? "4k" : params.resolution;
  if (typeof params.seed === "number") parameters.seed = params.seed;
  // Collected in the composer but previously never sent — now wired.
  parameters.personGeneration = params.person ?? "allow_adult";
  if (params.negativePrompt?.trim()) parameters.negativePrompt = params.negativePrompt.trim().slice(0, 2000);
  if (params.enhancePrompt != null) parameters.enhancePrompt = params.enhancePrompt;
  // generateAudio is accepted on Veo 3.1; Veo 2 ignores it (we block audio upstream).
  parameters.generateAudio = params.audio;
  if (params.storageUri) parameters.storageUri = params.storageUri;

  log.info({ model: params.model, project: ctx.project }, "vertex predictLongRunning");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ instances, parameters }),
  });
  if (!res.ok) {
    throw await vertexErr(res, "E_VERTEX_SUBMIT", "Vertex submit failed");
  }
  const json = (await res.json()) as { name?: string };
  if (!json.name) throw Object.assign(new Error("Vertex returned no operation name"), { code: "E_VERTEX_NO_OP" });
  return json.name;
}

/** Defensively collect output video URIs (gs:// or https) from an LRO payload. */
export function collectVideoUris(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number, key: string) => {
    if (out.size >= 16 || depth > 8) return;
    if (typeof v === "string") {
      if (v.startsWith("gs://")) out.add(v);
      // https outputs don't always end in .mp4 (e.g. storage.googleapis.com
      // download URLs) — trust them when the FIELD looks like a URI, not any
      // random link in the payload.
      else if (
        v.startsWith("https://") &&
        (/uri|url/i.test(key) || /^https?:\/\/\S+\.mp4(\?\S*)?$/.test(v))
      ) {
        out.add(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1, key);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, depth + 1, k);
    }
  };
  walk(payload, 0, "");
  return [...out];
}

/** First inline video payload (bytesBase64Encoded / videoBytes), capped. */
export function collectVideoBytes(payload: unknown): { base64: string; mime: string } | null {
  let found: { base64: string; mime: string } | null = null;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 8) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const b64 = o.bytesBase64Encoded ?? o.videoBytes;
      if (typeof b64 === "string" && b64.length > 1024 && b64.length <= INLINE_RESPONSE_MAX) {
        const mime = typeof o.mimeType === "string" ? o.mimeType : "video/mp4";
        found = { base64: b64, mime };
        return;
      }
      for (const x of Object.values(o)) walk(x, depth + 1);
    }
  };
  walk(payload, 0);
  return found;
}

export async function vertexFetchOp(
  model: string,
  opName: string,
  ctx: VertexCtx,
): Promise<VertexOperation> {
  // Publisher-model operations are NOT readable via generic GET /v1/{name}
  // (that 404s with an HTML page). The documented poll is fetchPredictOperation.
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1/projects/${ctx.project}/locations/${ctx.location}/publishers/google/models/${model}:fetchPredictOperation`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operationName: opName }),
  });
  if (!res.ok) {
    const text = await res.text();
    const isHtml = /<!DOCTYPE|<html/i.test(text.slice(0, 200));
    throw Object.assign(
      new Error(
        isHtml
          ? `Vertex returned an HTML ${res.status} page for ${opName} — check VERTEXAI_LOCATION matches the submit region and the project owns the operation`
          : `Vertex fetch failed: ${res.status} ${text.slice(0, 500)}`,
      ),
      { code: "E_VERTEX_GET", status: res.status },
    );
  }
  const json = (await res.json()) as {
    name?: string; done?: boolean; error?: { message?: string }; response?: unknown;
  };
  const uris = json.done ? collectVideoUris(json.response) : [];
  const inline = json.done ? collectVideoBytes(json.response) : null;
  const resp = json.done && json.response && typeof json.response === "object" && !Array.isArray(json.response)
    ? (json.response as Record<string, unknown>)
    : null;
  const responseKeys = resp ? Object.keys(resp).slice(0, 12) : [];
  // done + filtered + no outputs = blocked, not successful (Veo returns no
  // error in this case — the filter fields are the only signal).
  const raiCount = resp && typeof resp.raiMediaFilteredCount === "number" ? resp.raiMediaFilteredCount : 0;
  const raiReasons = resp && Array.isArray(resp.raiMediaFilteredReasons)
    ? (resp.raiMediaFilteredReasons as unknown[]).map(String).slice(0, 4)
    : [];
  return {
    name: json.name ?? opName,
    done: !!json.done,
    error: json.error?.message,
    videoUris: uris,
    ...(inline ? { videoBytes: inline } : {}),
    ...(raiCount > 0 ? { raiFiltered: { count: raiCount, reasons: raiReasons } } : {}),
    responseKeys,
  };
}

export async function vertexCancel(
  name: string,
  ctx: VertexCtx,
  model?: string,
): Promise<{ cancelled: boolean; alreadyDone: boolean }> {
  // Best effort: success is not guaranteed, and publisher-model operations
  // have no documented cancel RPC — the generic :cancel is attempted as-is.
  if (model) {
    try {
      const cur = await vertexFetchOp(model, name, ctx);
      if (cur.done) return { cancelled: false, alreadyDone: true };
    } catch {
      // Fall through to the cancel attempt.
    }
  }
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1/${name}:cancel`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 404) {
    throw await vertexErr(res, "E_VERTEX_CANCEL", "Vertex cancel failed");
  }
  return { cancelled: true, alreadyDone: false };
}
