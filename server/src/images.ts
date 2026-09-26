// Image-input handling for Veo slots (first frame, last frame, references).
// Per published Vertex limits: ≤20 MB each, JPEG/PNG only. Elements may hold
// data-URLs (decoded locally) or remote URLs (fetched with a hard cap).

import { getDb } from "./db.ts";

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** Browser-captured thumbnails/posters ride inline in JSON — smaller cap. */
export const THUMB_MAX_BYTES = 2_000_000;
export const ALLOWED_IMAGE_MIMES = ["image/jpeg", "image/png"] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export function isAllowedImageMime(m: string): m is AllowedImageMime {
  return (ALLOWED_IMAGE_MIMES as readonly string[]).includes(m.toLowerCase());
}

export interface ParsedDataUrl {
  mime: string;
  bytes: Uint8Array;
}

/** Strict data-URL parse (base64 only). Null when not a data-URL at all. */
export function parseDataUrl(url: string): ParsedDataUrl | null {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(url.trim());
  if (!m) return null;
  const mime = (m[1] ?? "").toLowerCase();
  const bytes = Uint8Array.fromBase64((m[2] ?? "").replace(/\s+/g, ""));
  return { mime, bytes };
}

/** Magic-byte sniff — authoritative over any claimed Content-Type. */
export function sniffImageMime(bytes: Uint8Array): AllowedImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/**
 * Validate an inline data-URL image (JPEG/PNG magic bytes + size cap).
 * Remote URLs pass (checked at submit time). Null when fine, else the
 * coded error for err(). `required` rejects non-data-URLs (thumbnails).
 */
export function validateInlineImage(
  url: string,
  maxBytes: number,
  what: string,
  required = false,
): { code: string; message: string } | null {
  const inline = parseDataUrl(url);
  if (!inline) {
    return required ? { code: "E_IMAGE_TYPE", message: `${what} must be JPEG or PNG, got unknown` } : null;
  }
  if (!isAllowedImageMime(inline.mime) || !sniffImageMime(inline.bytes)) {
    return { code: "E_IMAGE_TYPE", message: `${what} must be JPEG or PNG, got ${inline.mime || "unknown"}` };
  }
  if (inline.bytes.length > maxBytes) {
    const cap = maxBytes >= 1048576 ? `${Math.round(maxBytes / 1048576)} MB` : `${Math.round(maxBytes / 1000)} KB`;
    return { code: "E_IMAGE_TOO_LARGE", message: `${what} exceeds ${cap}` };
  }
  return null;
}

function tooLarge(size: number, max = IMAGE_MAX_BYTES): never {
  throw Object.assign(
    new Error(`Payload is ${(size / 1048576).toFixed(1)} MB — limit is ${(max / 1048576).toFixed(0)} MB`),
    { code: max === IMAGE_MAX_BYTES ? "E_IMAGE_TOO_LARGE" : "E_MEDIA_TOO_LARGE" },
  );
}

export async function readCapped(res: Response, maxBytes = IMAGE_MAX_BYTES): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) tooLarge(len, maxBytes);
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) tooLarge(buf.length, maxBytes);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        tooLarge(total, maxBytes);
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export interface ImageBytes {
  base64: string;
  mime: AllowedImageMime;
}

/**
 * Resolve an element to transmittable bytes. Data-URLs decode locally;
 * remote URLs are fetched with a 20 MB cap. Rejects non-JPEG/PNG.
 */
export async function elementImageBytes(elementId: string, projectId: string): Promise<ImageBytes> {
  const row = getDb()
    .query("SELECT image_url FROM elements WHERE id=? AND project_id=?")
    .get(elementId, projectId) as { image_url: string } | null;
  if (!row) {
    throw Object.assign(new Error(`Element ${elementId} not found in this project`), {
      code: "ELEMENT_NOT_FOUND",
    });
  }
  const url = (row.image_url ?? "").trim();
  if (!url) throw Object.assign(new Error("Element has no image"), { code: "E_IMAGE_EMPTY" });

  const data = parseDataUrl(url);
  if (data) {
    if (!isAllowedImageMime(data.mime)) {
      throw Object.assign(new Error(`Image must be JPEG or PNG, got ${data.mime}`), { code: "E_IMAGE_TYPE" });
    }
    if (data.bytes.length > IMAGE_MAX_BYTES) tooLarge(data.bytes.length);
    const sniffed = sniffImageMime(data.bytes);
    if (!sniffed) throw Object.assign(new Error("Image bytes are not valid JPEG/PNG"), { code: "E_IMAGE_TYPE" });
    return { base64: data.bytes.toBase64(), mime: sniffed };
  }

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow" });
  } catch (e) {
    throw Object.assign(new Error(`Could not fetch image: ${String(e)}`), { code: "E_IMAGE_FETCH" });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`Image fetch failed (${res.status})`), {
      code: "E_IMAGE_FETCH",
      status: res.status,
    });
  }
  const bytes = await readCapped(res);
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    throw Object.assign(
      new Error(`Image must be JPEG or PNG (Content-Type said ${res.headers.get("content-type") ?? "unknown"})`),
      { code: "E_IMAGE_TYPE" },
    );
  }
  return { base64: bytes.toBase64(), mime: sniffed };
}
