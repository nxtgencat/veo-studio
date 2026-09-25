import { describe, expect, test } from "bun:test";
import { encodePngRgba, videoMetaToResAspect } from "../src/frames.ts";

function solidPng(w: number, h: number): string {
  return encodePngRgba(new Uint8Array(w * h * 4).fill(200), w, h).toBase64();
}

describe("frames", () => {
  test("hand-rolled PNG encoder emits valid signature + IHDR", () => {
    const w = 4;
    const h = 2;
    const rgba = new Uint8Array(w * h * 4).fill(255);
    const png = encodePngRgba(rgba, w, h);
    // PNG signature
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // IHDR width/height (big-endian at offset 16/20)
    const dv = new DataView(png.buffer, png.byteOffset);
    expect(dv.getUint32(16)).toBe(w);
    expect(dv.getUint32(20)).toBe(h);
    expect(png.length).toBeGreaterThan(50);
  });

  test("our PNGs decode via Bun.Image with correct dims", async () => {
    const land = await new Bun.Image(Uint8Array.fromBase64(solidPng(8, 4))).metadata();
    expect([land.width, land.height]).toEqual([8, 4]);
    const port = await new Bun.Image(Uint8Array.fromBase64(solidPng(4, 8))).metadata();
    expect([port.width, port.height]).toEqual([4, 8]);
  });

  test("videoMetaToResAspect buckets like the client", () => {
    expect(videoMetaToResAspect(1920, 1080)).toEqual({ res: "1080p", aspect: "16:9" });
    expect(videoMetaToResAspect(1080, 1920)).toEqual({ res: "1080p", aspect: "9:16" });
    expect(videoMetaToResAspect(3840, 2160)).toEqual({ res: "4K", aspect: "16:9" });
    expect(videoMetaToResAspect(1280, 720)).toEqual({ res: "720p", aspect: "16:9" });
  });

  test("no ffmpeg dependency anywhere in server", async () => {
    const pkg = await Bun.file("package.json").json();
    const all = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all).not.toMatch(/ffmpeg|fluent-ffmpeg/i);
  });
});
