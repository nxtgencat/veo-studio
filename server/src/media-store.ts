// Server-side media file store (data/media/). Generated outputs,
// uploaded videos and other blobs persist here so they survive reloads,
// stay playable, and can feed Extend without a bucket.
// DB holds the index; bytes live on disk. Nothing here touches ffmpeg.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, nowIso } from "./db.ts";
import { childLogger } from "./logger.ts";

const log = childLogger({ module: "media" });

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

export function isUuidLike(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(id);
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
  const id = Bun.randomUUIDv7().replace(/-/g, "");
  const path = join(mediaDir(), `${id}.${extForMime(mime)}`);
  await Bun.write(path, bytes);
  getDb()
    .query("INSERT INTO media (id, mime, bytes, path, created_at) VALUES (?,?,?,?,?)")
    .run(id, mime, bytes.length, path, nowIso());
  log.info({ id, bytes: bytes.length, mime }, "media saved");
  return { id, mime, bytes: bytes.length, url: `/media/${id}` };
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
