// Real Vertex AI adapter. No mocks: every network call below hits Google.
// Without credentials it throws E_VERTEX_NOT_CONFIGURED — jobs surface that
// as a failed status with a remediation hint, never a fake video.

import { childLogger } from "./logger.ts";

const log = childLogger({ module: "vertex" });

export type VertexSubmitParams = {
  model: string;
  prompt: string;
  aspectRatio: string;
  resolution?: string;
  durationSeconds: number;
  audio: boolean;
  sampleCount: number;
  seed?: number;
  imageBytes?: string;
  imageMimeType?: string;
  firstFrameBytes?: string;
  lastFrameBytes?: string;
  referenceImages?: { bytes: string; mimeType: string }[];
  sourceVideoGcsUri?: string;
};

export type VertexOperation = { name: string; done: boolean; error?: string };

function vertexBase(): { project: string; location: string; token: string } {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.VERTEXAI_PROJECT ?? "";
  const location = process.env.VERTEXAI_LOCATION ?? "us-central1";
  // ADC access token provided by the operator (gcloud auth print-access-token).
  const token = process.env.VERTEX_ACCESS_TOKEN ?? "";
  if (!project || !token) {
    throw Object.assign(new Error("Vertex credentials missing"), {
      code: "E_VERTEX_NOT_CONFIGURED",
      hint: "Set GOOGLE_CLOUD_PROJECT and VERTEX_ACCESS_TOKEN (or wire ADC) before submitting to Vertex.",
    });
  }
  return { project, location, token };
}

export async function vertexSubmit(params: VertexSubmitParams): Promise<string> {
  const { project, location, token } = vertexBase();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google/models/${params.model}:predictLongRunning`;
  const instances: Record<string, unknown>[] = [{ prompt: params.prompt }];
  const first = instances[0];
  if (!first) throw Object.assign(new Error("unreachable"), { code: "E_VERTEX_INTERNAL" });
  if (params.imageBytes) {
    first.image = {
      bytesBase64Encoded: params.imageBytes,
      mimeType: params.imageMimeType ?? "image/png",
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

  log.info({ model: params.model, url: url.split("?")[0] }, "vertex predictLongRunning");
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

export async function vertexGet(name: string): Promise<VertexOperation> {
  const { location, token } = vertexBase();
  const url = `https://${location}-aiplatform.googleapis.com/v1/${name}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Vertex get failed: ${res.status} ${text.slice(0, 500)}`), {
      code: "E_VERTEX_GET",
      status: res.status,
    });
  }
  const json = (await res.json()) as { done?: boolean; error?: { message?: string } };
  return { name, done: !!json.done, error: json.error?.message };
}

export async function vertexCancel(name: string): Promise<{ cancelled: boolean; alreadyDone: boolean }> {
  const { location, token } = vertexBase();
  // Best effort per docs: success is not guaranteed.
  const getUrl = `https://${location}-aiplatform.googleapis.com/v1/${name}`;
  const cur = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (cur.ok) {
    const j = (await cur.json()) as { done?: boolean };
    if (j.done) return { cancelled: false, alreadyDone: true };
  }
  const url = `https://${location}-aiplatform.googleapis.com/v1/${name}:cancel`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
    vertexBase();
    return true;
  } catch {
    return false;
  }
}
