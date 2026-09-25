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
  sampleCount: number; seed?: number | null; status: string; progress: number; error: string;
  costEstimate: number; vertexOperation: string; inputsJson: string;
  elapsedMs: number; etaMs: number; etaSource: "measured" | "estimated";
  createdAt: string; updatedAt: string;
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
    maxImageMB: number; maxRefs: number; quotaRpm: number | null;
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
  bucketLocation: string | null;
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
    req<ServerSettings & { bucketCheck?: { location: string } | null }>(`/projects/${projectId}/settings`, { method: "PATCH", body: JSON.stringify(body) }),

  listElements: (projectId: string) =>
    req<{ elements: ServerElement[] }>(`/projects/${projectId}/elements`),
  createElement: (projectId: string, body: { category: string; name: string; imageUrl: string; note: string }) =>
    req<{ id: string; projectId: string; category: string; name: string; imageUrl: string; note: string; createdAt: string }>(`/projects/${projectId}/elements`, { method: "POST", body: JSON.stringify(body) }),
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
  setThumb: (id: string, thumbDataUrl: string) =>
    req(`/library/${id}`, { method: "PATCH", body: JSON.stringify({ thumbDataUrl }) }),
  importVideo: (body: { projectId: string; prompt: string; resolution: string; aspect: string; durationSeconds: number; audio: boolean; thumbDataUrl: string; mediaId?: string }) =>
    req<{ id: string }>("/library/import", { method: "POST", body: JSON.stringify(body) }),

  uploadMedia: async (file: File): Promise<{ id: string; url: string; bytes: number; mime: string }> => {
    let res: Response;
    try {
      const fd = new FormData();
      fd.append("file", file);
      res = await fetch(`${BASE}/media/upload`, { method: "POST", body: fd });
    } catch (e) {
      throw new ApiError(0, "SERVER_UNREACHABLE", `API server unreachable at ${BASE} — is it running?`, String(e));
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      id?: string;
      url?: string;
      bytes?: number;
      mime?: string;
    };
    if (!res.ok || !json.id || !json.url) {
      throw new ApiError(res.status, json.error?.code ?? "UPLOAD_FAILED", json.error?.message ?? `Upload failed (${res.status})`);
    }
    return { id: json.id, url: json.url, bytes: json.bytes ?? 0, mime: json.mime ?? "" };
  },

  downloadBackup: async (opts: { elements: boolean; generated: boolean; uploads: boolean }): Promise<{ blob: Blob; filename: string }> => {
    const q = new URLSearchParams({
      elements: opts.elements ? "1" : "0",
      generated: opts.generated ? "1" : "0",
      uploads: opts.uploads ? "1" : "0",
    }).toString();
    let res: Response;
    try {
      res = await fetch(`${BASE}/backup?${q}`);
    } catch (e) {
      throw new ApiError(0, "SERVER_UNREACHABLE", `API server unreachable at ${BASE} — is it running?`, String(e));
    }
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new ApiError(res.status, json.error?.code ?? "BACKUP_FAILED", json.error?.message ?? `Backup failed (${res.status})`);
    }
    const cd = res.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? "veo-backup.tar.gz";
    return { blob: await res.blob(), filename };
  },

  restoreBackup: async (file: File): Promise<Record<string, Record<string, number>>> => {
    let res: Response;
    try {
      const fd = new FormData();
      fd.append("file", file);
      res = await fetch(`${BASE}/restore`, { method: "POST", body: fd });
    } catch (e) {
      throw new ApiError(0, "SERVER_UNREACHABLE", `API server unreachable at ${BASE} — is it running?`, String(e));
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      imported?: Record<string, number>;
    };
    if (!res.ok) {
      throw new ApiError(res.status, json.error?.code ?? "RESTORE_FAILED", json.error?.message ?? `Restore failed (${res.status})`);
    }
    return json as Record<string, Record<string, number>>;
  },

  inspectBackup: async (file: File): Promise<{
    manifest: { exportedAt: string; includes: Record<string, boolean> };
    counts: Record<string, number>;
  }> => {
    let res: Response;
    try {
      const fd = new FormData();
      fd.append("file", file);
      res = await fetch(`${BASE}/restore/inspect`, { method: "POST", body: fd });
    } catch (e) {
      throw new ApiError(0, "SERVER_UNREACHABLE", `API server unreachable at ${BASE} — is it running?`, String(e));
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      manifest?: { exportedAt: string; includes: Record<string, boolean> };
      counts?: Record<string, number>;
    };
    if (!res.ok || !json.manifest || !json.counts) {
      throw new ApiError(res.status, json.error?.code ?? "INSPECT_FAILED", json.error?.message ?? `Could not read backup (${res.status})`);
    }
    return { manifest: json.manifest, counts: json.counts };
  },
};

export function apiBase(): string {
  return BASE;
}
