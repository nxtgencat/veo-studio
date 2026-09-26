// Chunked upload sessions (8 MiB octet-stream parts, strictly in-order).
// Why chunks: single-POST file uploads exceed every default body cap
// (Next proxy 10 MB, Bun ~128 MB), which forced raised limits plus
// multi-GB transient RAM. Parts stay small so all defaults hold; the
// session file assembles on disk and finalizes per kind. Bonus: per-part
// retry, resume, and progress for free.
// Bun has no native append API — its own guide prescribes node:fs
// appendFile, used here per part. Stateless per request (no FD registry
// to leak): abandonment just leaves a file the mtime sweep reaps.

import { appendFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKUP_MAX_BYTES } from "./backup.ts";
import { MEDIA_MAX_BYTES } from "./media-store.ts";
import { logger } from "./logger.ts";

const log = logger.child({ module: "uploads" });

/** Part size: clears the 10 MB proxy default with headroom, tiny in RAM. */
export const PART_SIZE = 8 * 1024 * 1024;

export type UploadKind = "backup" | "media";
const KIND_CAPS: Record<UploadKind, number> = { backup: BACKUP_MAX_BYTES, media: MEDIA_MAX_BYTES };

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const STALE_MS = 60 * 60 * 1000;

export interface UploadSession {
  kind: UploadKind;
  filename: string;
  mime: string;
  size: number;
  received: number;
  expected: number;
  createdAt: number;
}

function coded(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function sessionsDir(): string {
  const d = process.env.UPLOADS_DIR ?? join(tmpdir(), "veo-uploads");
  mkdirSync(d, { recursive: true });
  return d;
}

function sessionPaths(id: string): { data: string; meta: string } {
  const dir = sessionsDir();
  return { data: join(dir, `${id}.part`), meta: join(dir, `${id}.json`) };
}

function newSessionId(): string {
  return `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function readSession(id: string): UploadSession | null {
  if (!ID_RE.test(id)) return null;
  try {
    const s = JSON.parse(readFileSync(sessionPaths(id).meta, "utf8")) as UploadSession;
    if (!s || (s.kind !== "backup" && s.kind !== "media")) return null;
    return s;
  } catch {
    return null;
  }
}

async function writeSession(id: string, s: UploadSession): Promise<void> {
  await Bun.write(sessionPaths(id).meta, JSON.stringify(s));
}

/** Best-effort reap of abandoned sessions (both files). */
export function sweepUploads(maxAgeMs = STALE_MS, ids?: string): void {
  try {
    const dir = sessionsDir();
    const now = Date.now();
    const names = ids ?? readdirSync(dir);
    for (const f of names) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -".json".length);
      if (!ID_RE.test(id)) continue;
      try {
        const age = now - statSync(join(dir, f)).mtimeMs;
        if (age > maxAgeMs) {
          rmSync(sessionPaths(id).data, { force: true });
          rmSync(sessionPaths(id).meta, { force: true });
        }
      } catch { /* racing delete */ }
    }
  } catch { /* tmp missing — nothing to do */ }
}

/** Start a session: kind/size/mime validated upfront so a doomed upload fails fast. */
export async function initUpload(kind: string, filename: string, mime: string, size: number): Promise<{ uploadId: string }> {
  if (kind !== "backup" && kind !== "media") {
    throw coded(422, "E_UPLOAD_KIND", `kind must be "backup" or "media", got ${kind || "none"}`);
  }
  if (!Number.isInteger(size) || size <= 0 || size > KIND_CAPS[kind]) {
    // Same codes/messages as the old single-POST endpoints.
    if (kind === "backup") throw coded(413, "BACKUP_TOO_LARGE", "Archive exceeds the 1 GB cap");
    throw coded(413, "MEDIA_TOO_LARGE", "Limit is 200 MB per file");
  }
  if (kind === "media" && !mime.startsWith("video/") && !mime.startsWith("image/")) {
    throw coded(415, "MEDIA_TYPE", `Only video/* and image/* uploads, got ${mime || "unknown"}`);
  }
  sweepUploads();
  const id = newSessionId();
  const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "upload";
  await writeSession(id, { kind, filename: safe, mime, size, received: 0, expected: 0, createdAt: Date.now() });
  return { uploadId: id };
}

/** Append one in-order part. Index must equal next-expected (retry re-sends it). */
export async function appendPart(id: string, index: number, bytes: Uint8Array): Promise<{ received: number; expected: number }> {
  const s = readSession(id);
  if (!s) throw coded(404, "UPLOAD_NOT_FOUND", "No such upload (expired or aborted?)");
  if (index !== s.expected) throw coded(409, "E_UPLOAD_ORDER", `Expected part ${s.expected}, got ${index}`);
  if (bytes.length === 0) throw coded(400, "E_UPLOAD_EMPTY", "Part is empty");
  if (bytes.length > PART_SIZE) {
    throw coded(400, "E_UPLOAD_PART", `Parts are capped at ${PART_SIZE / 1048576} MB, got ${(bytes.length / 1048576).toFixed(1)} MB`);
  }
  if (s.received + bytes.length > s.size) {
    throw coded(400, "E_UPLOAD_OVERFLOW", `Would exceed declared ${s.size} bytes`);
  }
  await appendFile(sessionPaths(id).data, bytes);
  s.received += bytes.length;
  s.expected += 1;
  await writeSession(id, s);
  return { received: s.received, expected: s.expected };
}

/** Verify a complete session and hand the assembled path to the finalizer. */
export async function completeUpload(id: string): Promise<{ path: string; session: UploadSession }> {
  const s = readSession(id);
  if (!s) throw coded(404, "UPLOAD_NOT_FOUND", "No such upload (expired or aborted?)");
  if (s.received !== s.size) {
    throw coded(422, "E_UPLOAD_SHORT", `Received ${s.received} of ${s.size} declared bytes`);
  }
  const { data } = sessionPaths(id);
  try {
    if (statSync(data).size !== s.size) throw new Error("size");
  } catch {
    await abortUpload(id);
    throw coded(422, "E_UPLOAD_CORRUPT", "Assembled file does not match declared size — re-upload");
  }
  return { path: data, session: s };
}

/** Drop a session (cancel button / finalize done / corrupt). True when it existed. */
export async function abortUpload(id: string): Promise<boolean> {
  if (!ID_RE.test(id)) return false;
  const { data, meta } = sessionPaths(id);
  let existed = false;
  try {
    statSync(meta);
    existed = true;
  } catch { /* no session */ }
  rmSync(data, { force: true });
  rmSync(meta, { force: true });
  if (existed) log.info({ id }, "upload aborted");
  return existed;
}
