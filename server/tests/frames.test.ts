import { describe, expect, test } from "bun:test";
import { encodePngRgba } from "../src/frames.ts";

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

  test("no ffmpeg dependency anywhere in server", async () => {
    const pkg = await Bun.file("package.json").json();
    const all = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all).not.toMatch(/ffmpeg|fluent-ffmpeg/i);
  });
});
