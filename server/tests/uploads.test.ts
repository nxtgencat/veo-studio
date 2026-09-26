import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_FILE = ":memory:";
process.env.MEDIA_DIR = join(tmpdir(), `veo-media-uploads-${process.pid}`);
process.env.UPLOADS_DIR = join(tmpdir(), `veo-uploads-test-${process.pid}`);

import { getDb, resetDbForTests } from "../src/db.ts";
import { nowIso } from "../src/db.ts";
import { app } from "../src/routes.ts";
import { chunkedUpload } from "./helpers.ts";

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function init(kind: string, size: number, extra?: Record<string, unknown>) {
  return app.request("/uploads", json({ kind, filename: "t.bin", mime: "video/mp4", size, ...extra }));
}

beforeEach(() => {
  resetDbForTests();
  const now = nowIso();
  getDb().query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)").run("p1", "t", now, now);
});

describe("chunked uploads", () => {
  test("init validates kind, size, and mime upfront", async () => {
    expect((await init("nope", 10)).status).toBe(422);
    expect((await init("backup", 0)).status).toBe(422);
    expect((await init("backup", 2 * 1024 * 1024 * 1024)).status).toBe(413);
    expect((await init("media", 10, { mime: "text/plain" })).status).toBe(415);
    const ok = await init("media", 10);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { uploadId: string }).uploadId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  test("parts enforce order, size, and declared total", async () => {
    const { uploadId } = (await (await init("media", 10)).json()) as { uploadId: string };
    const part = (i: number, bytes: Uint8Array) =>
      app.request(`/uploads/${uploadId}/part?index=${i}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
    expect((await part(1, new Uint8Array([1]))).status).toBe(409);
    expect((await part(0, new Uint8Array(0))).status).toBe(400);
    expect((await part(0, new Uint8Array(9 * 1024 * 1024))).status).toBe(400);
    expect((await part(0, new Uint8Array([1, 2, 3]))).status).toBe(200);
    expect((await part(1, new Uint8Array(8))).status).toBe(400);
    expect((await app.request(`/uploads/nope/part?index=0`, { method: "PUT", body: new Uint8Array([1]) })).status).toBe(404);
    expect((await app.request(`/uploads/${uploadId}/part`, { method: "PUT", body: new Uint8Array([1]) })).status).toBe(400);
  });

  test("complete requires the full declared size, then finalizes", async () => {
    const { uploadId } = (await (await init("media", 4, { mime: "video/mp4" })).json()) as { uploadId: string };
    await app.request(`/uploads/${uploadId}/part?index=0`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1, 2]),
    });
    const short = await app.request(`/uploads/${uploadId}/complete`, { method: "POST" });
    expect(short.status).toBe(422);
    await app.request(`/uploads/${uploadId}/part?index=1`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([3, 4]),
    });
    const done = await app.request(`/uploads/${uploadId}/complete`, { method: "POST" });
    expect(done.status).toBe(201);
    const saved = (await done.json()) as { id: string; url: string; bytes: number };
    expect(saved.bytes).toBe(4);
    expect((await app.request(saved.url)).status).toBe(200);
    // Session is gone after finalize.
    expect((await app.request(`/uploads/${uploadId}/complete`, { method: "POST" })).status).toBe(404);
  });

  test("byte-level parts assemble a valid backup tar", async () => {
    const files = {
      "manifest.json": JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), counts: { projects: 1 } }),
      "projects.json": JSON.stringify([{ id: "p1", name: "t", created_at: "x", updated_at: "x" }]),
      "settings.json": "[]",
      "elements.json": "[]",
      "library.json": "[]",
      "jobs.json": "[]",
      "media.json": "{}",
    };
    const bytes = new Uint8Array(await new Bun.Archive(files).bytes());
    const up = await chunkedUpload(app, "backup", bytes, { filename: "tiny.tar", part: 7 });
    expect(up.status).toBe(201);
    const stored = (await up.json()) as { id: string; counts: Record<string, number> };
    expect(stored.counts).toMatchObject({ projects: 1 });
    const list = (await (await app.request("/backups")).json()) as { backups: { id: string }[] };
    expect(list.backups.map((b) => b.id)).toContain(stored.id);
  });

  test("abort drops the session", async () => {
    const { uploadId } = (await (await init("media", 100)).json()) as { uploadId: string };
    await app.request(`/uploads/${uploadId}/part?index=0`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array([1]),
    });
    expect((await app.request(`/uploads/${uploadId}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/uploads/${uploadId}`, { method: "DELETE" })).status).toBe(404);
    expect((await app.request(`/uploads/${uploadId}/part?index=1`, { method: "PUT", body: new Uint8Array([2]) })).status).toBe(404);
  });

  test("removed single-POST endpoints are gone", async () => {
    const fd = new FormData();
    fd.append("file", new File(["x"], "x.tar"));
    expect((await app.request("/media/upload", { method: "POST", body: fd })).status).toBe(404);
    expect((await app.request("/backups/upload", { method: "POST", body: fd })).status).toBe(404);
    expect((await app.request("/frames/extract", { method: "POST", body: fd })).status).toBe(404);
  });
});
