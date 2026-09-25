import { beforeEach, describe, expect, test } from "bun:test";

process.env.SQLITE_FILE = ":memory:";

import {
  elementImageBytes,
  IMAGE_MAX_BYTES,
  parseDataUrl,
  sniffImageMime,
} from "../src/images.ts";
import { getDb, resetDbForTests } from "../src/db.ts";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_1PX = "R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=";
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

function seedElement(id: string, imageUrl: string) {
  const now = new Date().toISOString();
  getDb()
    .query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run("prj_img", "Img", now, now);
  getDb()
    .query("INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, "prj_img", "assets", "E", imageUrl, "", now);
}

beforeEach(() => {
  resetDbForTests();
});

describe("images", () => {
  test("parseDataUrl handles data URLs only", () => {
    const p = parseDataUrl(`data:image/png;base64,${PNG_1PX}`);
    expect(p?.mime).toBe("image/png");
    expect(p!.bytes.length).toBeGreaterThan(0);
    expect(parseDataUrl("https://example.com/a.png")).toBeNull();
    expect(parseDataUrl("not a url")).toBeNull();
  });

  test("sniffImageMime trusts magic bytes", () => {
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull();
    expect(JPEG_MAGIC.length).toBeGreaterThan(0);
    expect(IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  test("elementImageBytes resolves data URLs", async () => {
    seedElement("el_png", `data:image/png;base64,${PNG_1PX}`);
    const r = await elementImageBytes("el_png", "prj_img");
    expect(r.mime).toBe("image/png");
    expect(r.base64).toBe(PNG_1PX);
  });

  test("elementImageBytes rejects GIF data URLs", async () => {
    seedElement("el_gif", `data:image/gif;base64,${GIF_1PX}`);
    let code = "";
    try {
      await elementImageBytes("el_gif", "prj_img");
    } catch (e: any) {
      code = String(e?.code ?? "");
    }
    expect(code).toBe("E_IMAGE_TYPE");
  });

  test("elementImageBytes rejects cross-project access", async () => {
    seedElement("el_other", `data:image/png;base64,${PNG_1PX}`);
    let code = "";
    try {
      await elementImageBytes("el_other", "prj_nope");
    } catch (e: any) {
      code = String(e?.code ?? "");
    }
    expect(code).toBe("ELEMENT_NOT_FOUND");
  });
});
