// Typed client for the headless veo server. No mocks — every call hits HTTP.
// Defaults to same-origin /api (proxied to the backend); set
// NEXT_PUBLIC_API_URL to call a backend origin directly instead.

const REMOTE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
const apiPrefix = (path: string) => (REMOTE !== "" ? `${REMOTE}${path}` : `/api${path}`);
const apiOrigin = REMOTE === "" ? "same-origin /api" : REMOTE;

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

// Access password (server VEO_PASSWORD). localStorage, 72h expiry,
// cleared on logout or any 401. Never in the bundle.
const TOKEN_KEY = "veo-auth";
const TOKEN_TTL_MS = 72 * 3600 * 1000;

interface StoredToken {
  t: string;
  exp: number;
}

function readStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredToken>;
    const exp = typeof parsed.exp === "number" ? parsed.exp : NaN;
    if (typeof parsed.t !== "string" || !(exp > Date.now())) {
      window.localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return parsed.t;
  } catch {
    return null; // private mode — memory only
  }
}

function writeStoredToken(t: string | null) {
  try {
    if (typeof window === "undefined") return;
    if (t) window.localStorage.setItem(TOKEN_KEY, JSON.stringify({ t, exp: Date.now() + TOKEN_TTL_MS }));
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode — memory only */ }
}

export function getAuthToken(): string | null {
  return readStoredToken();
}

export function setAuthToken(t: string | null) {
  writeStoredToken(t);
}

/**
 * Browser media tags (<video src>, canvas capture) can't send Authorization
 * headers, so the server accepts ?token= on GET /media/:id. Append the stored
 * password here at render time (never baked into the store) so playback,
 * thumbnails and Range seeks stay authorized while the password gate is on.
 * No token / non-media URLs pass through untouched.
 */
export function authedMediaUrl(url: string): string {
  if (!url || !url.includes("/media/")) return url;
  const t = getAuthToken();
  if (!t) return url;
  if (url.includes("token=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(t)}`;
}

/**
 * Direct download URL for a stored backup (anchor href, not fetch): the
 * browser streams it with native progress instead of buffering a 1 GB blob
 * in RAM first. Appends ?token= when the password gate is on — the server
 * accepts it on this download-only route.
 */
export function backupFileUrl(id: string): string {
  const base = `${apiBase()}/backups/${encodeURIComponent(id)}/download`;
  const t = getAuthToken();
  return t ? `${base}?token=${encodeURIComponent(t)}` : base;
}

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

function authHeaders(init?: RequestInit): Record<string, string> {
  const token = getAuthToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((init?.headers ?? {}) as Record<string, string>),
  };
}

function handleUnauthorized(res: Response) {
  if (res.status === 401) {
    setAuthToken(null);
    unauthorizedHandler?.();
  }
}

async function req<T>(path: string, init?: RequestInit, idempotencyKey?: string): Promise<T> {
  const res = await fetchApi(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(init),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!res.ok) {
    handleUnauthorized(res);
    throw new ApiError(res.status, json.error?.code ?? "REQUEST_FAILED", json.error?.message ?? `Request failed (${res.status})`, json.error?.details);
  }
  return json as T;
}

export interface ServerProject { id: string; name: string; created_at: string; updated_at: string }
export interface ServerElement { id: string; project_id: string; category: string; name: string; image_url: string; note: string; created_at: string }
export interface ServerJob {
  id: string; projectId: string; mode: string; model: string; prompt: string;
  resolution: string; aspect: string; durationSeconds: number; audio: boolean;
  sampleCount: number; seed?: number | null; person: string; negativePrompt: string;
  status: string; progress: number; error: string;
  costEstimate: number; vertexOperation: string; inputsJson: string;
  elapsedMs: number; etaMs: number; etaSource: "measured" | "estimated";
  createdAt: string; updatedAt: string;
}
export interface ServerVideo {
  id: string; project_id: string; job_id: string; mode: string; model: string;
  prompt: string; resolution: string; aspect: string; duration_seconds: number;
  actual_duration_seconds: number | null;
  audio: number; status: string; cost_estimate: number; video_url: string;
  bytes: number | null;
  thumb_url: string; person: string; negative_prompt: string;
  inputs_json: string; vertex_operation: string;
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

export interface StoredBackup {
  id: string;
  filename: string;
  bytes: number;
  counts: Record<string, number>;
  created_at: string;
}

async function throwApiError(res: Response, fallbackCode: string, fallbackMsg: string): Promise<never> {
  handleUnauthorized(res);
  const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  throw new ApiError(res.status, json.error?.code ?? fallbackCode, json.error?.message ?? `${fallbackMsg} (${res.status})`);
}

/**
 * Single fetch core: auth headers + unreachable mapped once. Callers parse
 * their own body / check res.ok via throwApiError. (Plain fetch has no
 * upload progress or cancel semantics beyond AbortSignal — both upload
 * call sites pass a signal for their Cancel buttons.)
 */
async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${apiPrefix(path)}`, { ...init, headers: authHeaders(init) });
  } catch (e) {
    throw new ApiError(0, "SERVER_UNREACHABLE", `API server unreachable at ${apiOrigin} — is it running?`, String(e));
  }
}

/** One-line error text for toasts: Error.message or String(e), optionally truncated. */
export function errOf(e: unknown, max?: number): string {
  const msg = e instanceof Error ? e.message : String(e ?? "Request failed");
  return max == null ? msg : msg.slice(0, max);
}

/** 8 MiB parts: clears the 10 MB proxy default with headroom (server ceiling matches). */
const CHUNK_SIZE = 8 * 1024 * 1024;

async function putPart(uploadId: string, index: number, part: Blob, signal?: AbortSignal): Promise<void> {
  const res = await fetchApi(`/uploads/${encodeURIComponent(uploadId)}/part?index=${index}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: part,
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) await throwApiError(res, "UPLOAD_FAILED", `Part ${index} failed`);
}

/**
 * Chunked upload: init → sequential slices → complete. Each part retries
 * 3×; any failure or abort deletes the server session. Progress is
 * fractional by bytes. Blob.slice is zero-copy — the file is never
 * buffered client-side.
 */
async function uploadChunked(
  kind: "backup" | "media",
  file: Blob,
  opts: { filename?: string; mime?: string; signal?: AbortSignal; onProgress?: (frac: number) => void },
): Promise<unknown> {
  if (!file.size) throw new ApiError(400, "EMPTY_FILE", "Uploaded file is empty");
  const { uploadId } = await req<{ uploadId: string }>("/uploads", {
    method: "POST",
    body: JSON.stringify({
      kind,
      filename: opts.filename ?? "upload",
      mime: opts.mime ?? "application/octet-stream",
      size: file.size,
    }),
  });
  const fail = async (e: unknown): Promise<never> => {
    await fetchApi(`/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => {});
    throw e;
  };
  try {
    let sent = 0;
    for (let index = 0; sent < file.size; index++) {
      opts.signal?.throwIfAborted();
      const part = file.slice(sent, sent + CHUNK_SIZE);
      let last: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await putPart(uploadId, index, part, opts.signal);
          last = null;
          break;
        } catch (e) {
          last = e;
          if (opts.signal?.aborted) break;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      if (last) throw last;
      sent += part.size;
      opts.onProgress?.(file.size ? sent / file.size : 1);
    }
    return await req(`/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST" });
  } catch (e) {
    return fail(e);
  }
}

export const api = {
  health: () => req<{ ok: boolean }>("/health"),

  capabilities: () => req<Capabilities>("/models/capabilities"),

  stats: () => req<{
    projects: number; videos: number; delivered: number; spend: number;
    byProject: { projectId: string; videos: number; spend: number }[];
  }>("/stats"),

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
  updateElement: (id: string, body: { name?: string; note?: string }) =>
    req<{ id: string }>(`/elements/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  createJob: (body: Record<string, unknown>, idempotencyKey: string) =>
    req<{ jobId: string; deduped: boolean }>("/composer/jobs", { method: "POST", body: JSON.stringify(body) }, idempotencyKey),
  getJob: (id: string) => req<ServerJob>(`/jobs/${id}`),
  listJobs: (projectId: string) => req<{ jobs: ServerJob[] }>(`/jobs?projectId=${encodeURIComponent(projectId)}`),
  cancelJob: (id: string) =>
    req<{ ok: boolean; status: string; costImplication: string }>(`/jobs/${id}/cancel`, { method: "POST" }),

  listLibrary: (projectId: string) =>
    req<{ videos: ServerVideo[] }>(`/library?projectId=${encodeURIComponent(projectId)}`),
  deleteVideo: (id: string) => req<{ deleted: boolean }>(`/library/${id}`, { method: "DELETE" }),
  deleteJob: (id: string) => req<{ deleted: boolean }>(`/jobs/${id}`, { method: "DELETE" }),
  setThumb: (id: string, thumbDataUrl: string) =>
    req(`/library/${id}`, { method: "PATCH", body: JSON.stringify({ thumbDataUrl }) }),
  importVideo: (body: { projectId: string; prompt: string; resolution: string; aspect: string; durationSeconds: number; audio: boolean; thumbDataUrl: string; mediaId?: string }) =>
    req<{ id: string }>("/library/import", { method: "POST", body: JSON.stringify(body) }),

  uploadMedia: async (file: File, signal?: AbortSignal, onProgress?: (frac: number) => void): Promise<{ id: string; url: string; bytes: number; mime: string }> => {
    const json = (await uploadChunked("media", file, {
      filename: file.name || "upload",
      mime: file.type || "application/octet-stream",
      signal,
      onProgress,
    })) as { id?: string; url?: string; bytes?: number; mime?: string };
    if (!json.id || !json.url) {
      throw new ApiError(500, "UPLOAD_FAILED", "Upload completed without a file");
    }
    return { id: json.id, url: json.url, bytes: json.bytes ?? 0, mime: json.mime ?? "" };
  },

  listBackups: async (): Promise<{ backups: StoredBackup[] }> => {
    const res = await fetchApi("/backups");
    if (!res.ok) await throwApiError(res, "BACKUPS_FAILED", "Could not list backups");
    return (await res.json()) as { backups: StoredBackup[] };
  },

  buildBackup: async (): Promise<StoredBackup> => {
    const res = await fetchApi("/backups", { method: "POST" });
    if (!res.ok) await throwApiError(res, "BACKUP_FAILED", "Backup failed");
    return (await res.json()) as StoredBackup;
  },

  uploadBackup: async (file: File, signal?: AbortSignal, onProgress?: (frac: number) => void): Promise<StoredBackup> => {
    return (await uploadChunked("backup", file, {
      filename: file.name || "upload.tar",
      mime: "application/x-tar",
      signal,
      onProgress,
    })) as StoredBackup;
  },

  restoreBackup: async (id: string): Promise<Record<string, Record<string, number>>> => {
    const res = await fetchApi(`/backups/${encodeURIComponent(id)}/restore`, { method: "POST" });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
      imported?: Record<string, number>;
    };
    if (!res.ok) await throwApiError(res, json.error?.code ?? "RESTORE_FAILED", json.error?.message ?? "Restore failed");
    return json as Record<string, Record<string, number>>;
  },

  deleteBackup: async (id: string): Promise<void> => {
    const res = await fetchApi(`/backups/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) await throwApiError(res, "DELETE_FAILED", "Delete failed");
  },

  authStatus: async (): Promise<{ required: boolean }> => {
    const res = await fetch(`${apiPrefix("/auth/status")}`);
    if (!res.ok) throw new ApiError(res.status, "AUTH_STATUS", `Auth check failed (${res.status})`);
    return (await res.json()) as { required: boolean };
  },
};

export function apiBase(): string {
  return REMOTE === "" ? "/api" : REMOTE;
}

