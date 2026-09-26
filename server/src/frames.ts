// Server-side video probing with MediaBunny (no ffmpeg): demux-only
// metadata (duration, dimensions, codec) that works headless in Bun,
// plus a hand-rolled PNG encoder (zero native deps) kept for tests.

import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
// NOTE: PNG IDAT needs zlib-wrapped deflate. Bun.deflateSync emits raw
// deflate (verified: node inflateSync rejects it, even with windowBits),
// so node:zlib stays here deliberately — correctness over API purity.
import { deflateSync } from "node:zlib";

function crc32(buf: Uint8Array): number {
  // Standard ISO-HDLC CRC32 (verified: Bun.hash.crc32("123456789") === 0xcbf43926).
  return Bun.hash.crc32(buf);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(4 + data.length);
  body.set(typeBytes, 0);
  body.set(data, 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  const out = new Uint8Array(4 + body.length + 4);
  out.set(len, 0);
  out.set(body, 4);
  out.set(crc, 4 + body.length);
  return out;
}

export function encodePngRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(raw);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(idat)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string | null;
}

/** Pure-demux probe (no decoder needed — works headless in Bun). */
export async function probeVideoMetadata(bytes: Uint8Array, _mimeType: string): Promise<VideoMetadata> {
  // BufferSource reads the bytes in place — no Blob copy.
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("NO_VIDEO_TRACK: input contains no decodable video track");
    const duration = await input.computeDuration();
    return {
      durationSeconds: Math.round(duration * 100) / 100,
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
      codec: (await track.getCodec()) ?? null,
    };
  } finally {
    input.dispose();
  }
}

/** Delivered-duration probe (demux-only, 0.1s). Null when undecodable — never throws. */
export async function probeDuration(bytes: Uint8Array, mime: string): Promise<number | null> {
  try {
    const meta = await probeVideoMetadata(bytes, mime);
    return meta.durationSeconds > 0 ? Math.round(meta.durationSeconds * 10) / 10 : null;
  } catch {
    return null;
  }
}

export function videoMetaToResAspect(width: number, height: number): { res: "720p" | "1080p" | "4K"; aspect: "16:9" | "9:16" } {
  const long = Math.max(width, height);
  return {
    res: long >= 3000 ? "4K" : long >= 1500 ? "1080p" : "720p",
    aspect: width >= height ? "16:9" : "9:16",
  };
}
