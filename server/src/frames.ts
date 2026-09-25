// Server-side frame handling with MediaBunny (no ffmpeg).
// Headless reality: Bun has no WebCodecs VideoDecoder, so pixel decoding
// (VideoSampleSink) only works in runtimes that provide it. Demuxing +
// metadata + keyframe index (EncodedPacketSink) works everywhere, and this
// endpoint always returns that. Pixel thumbnails are best-effort: when a
// decoder exists we return base64 PNGs (hand-rolled encoder, zero native
// deps); otherwise `thumbnailStatus` explains why `thumbnails` is empty.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSample, VideoSampleSink } from "mediabunny";
// NOTE: PNG IDAT needs zlib-wrapped deflate. Bun.deflateSync emits raw
// deflate (verified: node inflateSync rejects it, even with windowBits),
// so node:zlib stays here deliberately — correctness over API purity.
import { deflateSync } from "node:zlib";

export type ExtractOptions = {
  timestamps?: number[];
  count?: number;
};

export type FrameIndexEntry = {
  timestamp: number;
  type: string;
  byteSize: number;
};

export type ExtractResult = {
  durationSeconds: number;
  width: number;
  height: number;
  codec: string | null;
  keyframeCount: number;
  frames: FrameIndexEntry[];
  thumbnails: { timestamp: number; pngBase64: string; width: number; height: number }[];
  thumbnailStatus: "ok" | "decoder-unavailable-in-this-runtime" | "no-samples";
};

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

export async function extractFrames(
  bytes: Uint8Array,
  mimeType: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const owned = Uint8Array.from(bytes);
  const blob = new Blob([owned.buffer as ArrayBuffer], { type: mimeType || "video/mp4" });
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("NO_VIDEO_TRACK: input contains no decodable video track");
    const duration = await input.computeDuration();
    const width = track.codedWidth ?? track.displayWidth ?? 0;
    const height = track.codedHeight ?? track.displayHeight ?? 0;

    // Keyframe/packet index — pure demux, works headless.
    const packetSink = new EncodedPacketSink(track);
    const frames: FrameIndexEntry[] = [];
    let keyframes = 0;
    for await (const p of packetSink.packets(undefined, undefined, { metadataOnly: true })) {
      if (p.type === "key") keyframes++;
      frames.push({ timestamp: Math.round(p.timestamp * 1000) / 1000, type: p.type, byteSize: p.byteLength });
      if (frames.length >= 200) break;
    }

    // Pixel thumbnails — needs WebCodecs; degrade gracefully.
    let timestamps = opts.timestamps;
    if (!timestamps || timestamps.length === 0) {
      const n = Math.min(Math.max(opts.count ?? 3, 1), 10);
      timestamps = Array.from({ length: n }, (_, i) =>
        duration > 0 ? (duration * (i + 0.5)) / n : i,
      );
    }
    const thumbnails: ExtractResult["thumbnails"] = [];
    let thumbnailStatus: ExtractResult["thumbnailStatus"] = "no-samples";
    try {
      const sink = new VideoSampleSink(track);
      for await (const sample of sink.samplesAtTimestamps(timestamps)) {
        try {
          if (!sample) continue;
          const w = sample.displayWidth ?? sample.codedWidth;
          const h = sample.displayHeight ?? sample.codedHeight;
          type CopyOpts = Parameters<VideoSample["copyTo"]>[1];
          const rgbaOpts = { format: "RGBA" } as unknown as CopyOpts;
          const size = sample.allocationSize(rgbaOpts);
          const rgba = new Uint8Array(size);
          await sample.copyTo(rgba, rgbaOpts);
          const png = encodePngRgba(rgba, w, h);
          thumbnails.push({
            timestamp: sample.timestamp,
            pngBase64: png.toBase64(),
            width: w,
            height: h,
          });
        } finally {
          sample?.close();
        }
      }
      thumbnailStatus = thumbnails.length > 0 ? "ok" : "no-samples";
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      thumbnailStatus = msg.includes("VideoDecoder is not available")
        ? "decoder-unavailable-in-this-runtime"
        : "no-samples";
    }

    return {
      durationSeconds: Math.round(duration * 100) / 100,
      width,
      height,
      codec: (track.codec as string | null) ?? null,
      keyframeCount: keyframes,
      frames,
      thumbnails,
      thumbnailStatus,
    };
  } finally {
    input.dispose();
  }
}
