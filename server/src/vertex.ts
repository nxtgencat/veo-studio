// Real Vertex AI adapter. No mocks: every network call below hits Google.
// Auth (project + Bearer token) comes from the caller's ResolvedAuth —
// service-account JSON by default, env creds only when toggled per project.

import { childLogger } from "./logger.ts";

const log = childLogger({ module: "vertex" });

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
};

export const INLINE_RESPONSE_MAX = 100 * 1024 * 1024;

export function vertexEnvCtx(): VertexCtx {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.VERTEXAI_PROJECT ?? "";
  const location = process.env.VERTEXAI_LOCATION ?? "us-central1";
  const token = process.env.VERTEX_ACCESS_TOKEN ?? "";
  if (!project || !token) {
    throw Object.assign(new Error("Vertex credentials missing"), {
      code: "E_VERTEX_NOT_CONFIGURED",
      hint: "Paste service account JSON in Settings, or switch auth to Environment and set GOOGLE_CLOUD_PROJECT + VERTEX_ACCESS_TOKEN.",
    });
  }
  return { project, location, token };
}

export async function vertexSubmit(params: VertexSubmitParams, ctx: VertexCtx): Promise<string> {
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1/projects/${ctx.project}/locations/${ctx.location}/publishers/google/models/${params.model}:predictLongRunning`;
  const instances: Record<string, unknown>[] = [{ prompt: params.prompt }];
  const first = instances[0];
  if (!first) throw Object.assign(new Error("unreachable"), { code: "E_VERTEX_INTERNAL" });
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
  if (params.resolution) parameters.resolution = params.resolution;
  if (typeof params.seed === "number") parameters.seed = params.seed;
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
    const text = await res.text();
    throw Object.assign(new Error(`Vertex submit failed: ${res.status} ${text.slice(0, 500)}`), {
      code: "E_VERTEX_SUBMIT",
      status: res.status,
    });
  }
  const json = (await res.json()) as { name?: string };
  if (!json.name) throw Object.assign(new Error("Vertex returned no operation name"), { code: "E_VERTEX_NO_OP" });
  return json.name;
}

/** Defensively collect output video URIs (gs:// or https) from an LRO payload. */
export function collectVideoUris(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (out.size >= 16 || depth > 8) return;
    if (typeof v === "string") {
      if (v.startsWith("gs://") || /^https?:\/\/\S+\.mp4(\?\S*)?$/.test(v)) out.add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  walk(payload, 0);
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

export async function vertexGet(name: string, ctx: VertexCtx): Promise<VertexOperation> {
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1/${name}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}` } });
  if (!res.ok) {
    const text = await res.text();
    const isHtml = /<!DOCTYPE|<html/i.test(text.slice(0, 200));
    throw Object.assign(
      new Error(
        isHtml
          ? `Vertex returned an HTML ${res.status} page for ${name} — usually a wrong region in the operation URL or an expired/deleted operation`
          : `Vertex get failed: ${res.status} ${text.slice(0, 500)}`,
      ),
      {
        code: "E_VERTEX_GET",
        status: res.status,
      },
    );
  }
  const json = (await res.json()) as { done?: boolean; error?: { message?: string }; response?: unknown };
  const uris = json.done ? collectVideoUris(json.response) : [];
  const inline = json.done ? collectVideoBytes(json.response) : null;
  return {
    name,
    done: !!json.done,
    error: json.error?.message,
    videoUris: uris,
    ...(inline ? { videoBytes: inline } : {}),
  };
}

export async function vertexCancel(name: string, ctx: VertexCtx): Promise<{ cancelled: boolean; alreadyDone: boolean }> {
  // Best effort per docs: success is not guaranteed.
  const getUrl = `https://${ctx.location}-aiplatform.googleapis.com/v1/${name}`;
  const cur = await fetch(getUrl, { headers: { Authorization: `Bearer ${ctx.token}` } });
  if (cur.ok) {
    const j = (await cur.json()) as { done?: boolean };
    if (j.done) return { cancelled: false, alreadyDone: true };
  }
  const url = `https://${ctx.location}-aiplatform.googleapis.com/v1/${name}:cancel`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw Object.assign(new Error(`Vertex cancel failed: ${res.status} ${text.slice(0, 500)}`), {
      code: "E_VERTEX_CANCEL",
      status: res.status,
    });
  }
  return { cancelled: true, alreadyDone: false };
}

export function vertexConfigured(): boolean {
  try {
    vertexEnvCtx();
    return true;
  } catch {
    return false;
  }
}
