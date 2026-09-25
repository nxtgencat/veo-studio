// Typed client for the headless veo server. No mocks — every call hits HTTP.
// Base URL: NEXT_PUBLIC_API_URL (default http://localhost:8787 for `bun run dev`).

const BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787").replace(/\/$/, "");

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function req<T>(path: string, init?: RequestInit, idempotencyKey?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
    });
  } catch (e) {
    throw new ApiError(0, "SERVER_UNREACHABLE", `API server unreachable at ${BASE} — is it running?`, String(e));
  }
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!res.ok) {
    throw new ApiError(res.status, json.error?.code ?? "REQUEST_FAILED", json.error?.message ?? `Request failed (${res.status})`, json.error?.details);
  }
  return json as T;
}

export interface ServerProject { id: string; name: string; created_at: string; updated_at: string }
export interface ServerElement { id: string; project_id: string; category: string; name: string; image_url: string; note: string; created_at: string }
export interface ServerJob {
  id: string; projectId: string; mode: string; model: string; prompt: string;
  resolution: string; aspect: string; durationSeconds: number; audio: boolean;
  sampleCount: number; status: string; progress: number; error: string;
  costEstimate: number; vertexOperation: string; createdAt: string; updatedAt: string;
}
export interface ServerVideo {
  id: string; project_id: string; job_id: string; mode: string; model: string;
  prompt: string; resolution: string; aspect: string; duration_seconds: number;
  audio: number; status: string; cost_estimate: number; video_url: string;
  thumb_url: string; inputs_json: string; vertex_operation: string;
  created_at: string; updated_at: string;
}
export interface Capabilities {
  models: {
    id: string; label: string; tier: string; stage: string; retires: boolean;
    audio: boolean; modes: string[]; durations: number[]; r2vDurations: number[];
    resolutions: string[]; aspects: string[]; fps: number; maxOutputs: number;
    maxImageMB: number; maxRefs: number;
  }[];
  modes: { id: string; label: string; desc: string }[];
  extend: { secondsPerCall: number; totalCapSeconds: number };
  pricingPerSecond: Record<string, Record<string, { audio: number | null; silent: number | null }>>;
  defaults: { region: string; fps: number; model: string };
  retiring: string[];
}

export interface ServerSettings {
  projectId: string;
  bucket: string;
  useBucket: boolean;
  authMode: "service_account" | "env";
  hasSaJson: boolean;
  saEmail: string | null;
  saProjectId: string | null;
}

export const api = {
  health: () => req<{ ok: boolean }>("/health"),

  capabilities: () => req<Capabilities>("/models/capabilities"),

  listProjects: () => req<{ projects: ServerProject[] }>("/projects"),
  createProject: (name: string) =>
    req<ServerProject>("/projects", { method: "POST", body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) =>
    req<ServerProject>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteProject: (id: string) => req<{ deleted: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  getSettings: (projectId: string) => req<ServerSettings>(`/projects/${projectId}/settings`),
  saveSettings: (projectId: string, body: { saJson?: string; bucket?: string; useBucket?: boolean; authMode?: "service_account" | "env" }) =>
    req<ServerSettings>(`/projects/${projectId}/settings`, { method: "PATCH", body: JSON.stringify(body) }),

  listElements: (projectId: string) =>
    req<{ elements: ServerElement[] }>(`/projects/${projectId}/elements`),
  createElement: (projectId: string, body: { category: string; name: string; imageUrl: string; note: string }) =>
    req<ServerElement & { projectId: string }>(`/projects/${projectId}/elements`, { method: "POST", body: JSON.stringify(body) }),
  deleteElement: (id: string) => req<{ deleted: boolean }>(`/elements/${id}`, { method: "DELETE" }),

  createJob: (body: Record<string, unknown>, idempotencyKey: string) =>
    req<{ jobId: string; deduped: boolean }>("/composer/jobs", { method: "POST", body: JSON.stringify(body) }, idempotencyKey),
  getJob: (id: string) => req<ServerJob>(`/jobs/${id}`),
  listJobs: (projectId: string) => req<{ jobs: ServerJob[] }>(`/jobs?projectId=${encodeURIComponent(projectId)}`),
  cancelJob: (id: string) =>
    req<{ ok: boolean; status: string; costImplication: string }>(`/jobs/${id}/cancel`, { method: "POST" }),

  listLibrary: (projectId: string) =>
    req<{ videos: ServerVideo[] }>(`/library?projectId=${encodeURIComponent(projectId)}`),
  deleteVideo: (id: string) => req<{ deleted: boolean }>(`/library/${id}`, { method: "DELETE" }),
  importVideo: (body: { projectId: string; prompt: string; resolution: string; aspect: string; durationSeconds: number; audio: boolean; thumbDataUrl: string }) =>
    req<{ id: string }>("/library/import", { method: "POST", body: JSON.stringify(body) }),
};

export function apiBase(): string {
  return BASE;
}
