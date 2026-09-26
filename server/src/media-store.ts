// Server-side media file store (data/media/). Generated outputs,
// uploaded videos and other blobs persist here so they survive reloads,
// stay playable, and can feed Extend without a bucket.
// DB holds the index; bytes live on disk. Nothing here touches ffmpeg.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, nowIso } from "./db.ts";
import { logger } from "./logger.ts";

const log = logger.child({ module: "media" });

export const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

export function mediaDir(): string {
  const dir = process.env.MEDIA_DIR ?? "data/media";
  mkdirSync(dir, { recursive: true });
  return dir;
}

const EXT_FOR_MIME: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function extForMime(mime: string): string {
  return EXT_FOR_MIME[mime.toLowerCase()] ?? "bin";
}

function isUuidLike(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(id);
}

function newMediaId(): string {
  return Bun.randomUUIDv7().replace(/-/g, "");
}

function mediaPath(id: string, mime: string): string {
  return join(mediaDir(), `${id}.${extForMime(mime)}`);
}

function insertMediaRow(id: string, mime: string, bytes: number, path: string): void {
  getDb()
    .query("INSERT INTO media (id, mime, bytes, path, created_at) VALUES (?,?,?,?,?)")
    .run(id, mime, bytes, path, nowIso());
}

/**
 * Blob-first save (multipart upload path): Bun.write streams the Blob
 * straight to disk with the fastest syscall available — no arrayBuffer /
 * Uint8Array copies in userland RAM first. (Hono's formData parse still
 * holds one copy; Bun exposes no streaming multipart parser, so this is
 * the leanest shape available.)
 */
export async function saveMediaBlob(data: Blob, mime: string): Promise<MediaRecord> {
  if (data.size > MEDIA_MAX_BYTES) {
    throw Object.assign(new Error("File exceeds the 200 MB media limit"), { code: "E_MEDIA_TOO_LARGE" });
  }
  const id = newMediaId();
  const path = mediaPath(id, mime);
  await Bun.write(path, data);
  insertMediaRow(id, mime, data.size, path);
  log.info({ id, bytes: data.size, mime }, "media saved");
  return { id, mime, bytes: data.size, url: `/media/${id}` };
}

export interface MediaRecord {
  id: string;
  mime: string;
  bytes: number;
  url: string;
}

export async function saveMedia(bytes: Uint8Array, mime: string): Promise<MediaRecord> {
  if (bytes.length > MEDIA_MAX_BYTES) {
    throw Object.assign(new Error("File exceeds the 200 MB media limit"), { code: "E_MEDIA_TOO_LARGE" });
  }
  const id = newMediaId();
  const path = mediaPath(id, mime);
  await Bun.write(path, bytes);
  insertMediaRow(id, mime, bytes.length, path);
  log.info({ id, bytes: bytes.length, mime }, "media saved");
  return { id, mime, bytes: bytes.length, url: `/media/${id}` };
}

/**
 * Path-first import (restore path): the bytes are already on disk (an
 * extracted archive), so Bun.write copies file→file kernel-side
 * (copy_file_range/sendfile) — never reloaded into userland RAM.
 * False when the id is taken or the source is missing/empty.
 */
export async function importMediaPath(id: string, srcPath: string, mime: string): Promise<boolean> {
  if (!isUuidLike(id)) return false;
  if (getDb().query("SELECT id FROM media WHERE id=?").get(id)) return false;
  const src = Bun.file(srcPath);
  if (!src.size) return false;
  if (src.size > MEDIA_MAX_BYTES) {
    throw Object.assign(new Error("File exceeds the 200 MB media limit"), { code: "E_MEDIA_TOO_LARGE" });
  }
  const path = mediaPath(id, mime);
  await Bun.write(path, src);
  insertMediaRow(id, mime, src.size, path);
  return true;
}

export function getMedia(id: string): { path: string; mime: string; bytes: number } | null {
  if (!isUuidLike(id)) return null;
  const row = getDb().query("SELECT mime, bytes, path FROM media WHERE id=?").get(id) as {
    mime: string;
    bytes: number;
    path: string;
  } | null;
  if (!row) return null;
  const f = Bun.file(row.path);
  if (!f.size) return null;
  return row;
}

export async function deleteMedia(id: string): Promise<boolean> {
  if (!isUuidLike(id)) return false;
  const row = getDb().query("SELECT path FROM media WHERE id=?").get(id) as { path: string } | null;
  getDb().query("DELETE FROM media WHERE id=?").run(id);
  if (row) {
    try {
      await Bun.file(row.path).delete();
    } catch { /* already gone */ }
  }
  return !!row;
}

/** Extract a /media/:id reference from a stored video_url, if any. */
export function mediaIdFromUrl(url: string): string | null {
  const m = /^\/media\/([A-Za-z0-9_-]{8,64})$/.exec(url.trim());
  return m?.[1] ?? null;
}
