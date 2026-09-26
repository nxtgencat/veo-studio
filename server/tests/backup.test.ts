import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_FILE = ":memory:";
process.env.MEDIA_DIR = join(tmpdir(), `veo-media-backup-${process.pid}`);
process.env.BACKUPS_DIR = join(tmpdir(), `veo-backups-test-${process.pid}`);

import { getDb, resetDbForTests } from "../src/db.ts";
import { nowIso } from "../src/db.ts";
import { mediaDir } from "../src/media-store.ts";
import { app } from "../src/routes.ts";
import { chunkedUpload } from "./helpers.ts";

function seedAll() {
  const db = getDb();
  const now = nowIso();
  db.query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)").run("prj_bk", "Bk", now, now);
  db.query("INSERT INTO project_settings (project_id, sa_json, bucket, use_bucket, auth_mode, updated_at) VALUES (?,?,?,?,?,?)").run(
    "prj_bk", "", "bkt", 1, "service_account", now,
  );
  db.query("INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)").run(
    "el1", "prj_bk", "assets", "E", "https://example.com/a.png", "", now,
  );
  db.query(
    `INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect, duration_seconds,
      audio, status, cost_estimate, video_url, gcs_uri, thumb_url, inputs_json, vertex_operation, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("vid_gen", "prj_bk", "job1", "t2v", "m", "p", "720p", "16:9", 8, 1, "succeeded", 1, "", "", "", "{}", "", now, now);
  db.query(
    `INSERT INTO library (id, project_id, job_id, mode, model, prompt, resolution, aspect, duration_seconds,
      audio, status, cost_estimate, video_url, gcs_uri, thumb_url, inputs_json, vertex_operation, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("vid_up", "prj_bk", "import-x", "t2v", "import", "up", "720p", "16:9", 5, 1, "succeeded", 0, "/media/med1abcd", "", "", "{}", "", now, now);
  db.query(
    `INSERT INTO jobs (id, project_id, idempotency_key, mode, model, prompt, resolution, aspect, duration_seconds,
      audio, sample_count, seed, inputs_json, status, progress, error, cost_estimate, vertex_operation, webhook_url, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("job1", "prj_bk", "k1", "t2v", "m", "p", "720p", "16:9", 8, 1, 1, null, "{}", "succeeded", 100, "", 1, "", "", now, now);
}

async function seedMedia() {
  // Fixed id so the upload row can reference it.
  const db = getDb();
  const path = join(mediaDir(), `med1abcd.mp4`);
  await Bun.write(path, new Uint8Array([1, 2, 3]));
  db.query("INSERT INTO media (id, mime, bytes, path, created_at) VALUES (?,?,?,?,?)").run(
    "med1abcd", "video/mp4", 3, path, nowIso(),
  );
}

beforeEach(() => {
  resetDbForTests();
  seedAll();
});

describe("backups", () => {
  test("build packs everything and lists it", async () => {
    await seedMedia();
    const res = await app.request("/backups", { method: "POST" });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; filename: string; counts: Record<string, number> };
    expect(row.filename).toMatch(/^veo-backup-.*\.tar$/);
    expect(row.counts).toMatchObject({ projects: 1, elements: 1, library: 2, jobs: 1, media: 1 });
    const list = (await (await app.request("/backups")).json()) as { backups: { id: string }[] };
    expect(list.backups.map((b) => b.id)).toEqual([row.id]);
  });

  test("download streams the stored file", async () => {
    await seedMedia();
    const row = (await (await app.request("/backups", { method: "POST" })).json()) as { id: string; filename: string };
    const dl = await app.request(`/backups/${row.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toContain(row.filename);
    const files = await new Bun.Archive(new Uint8Array(await dl.arrayBuffer())).files();
    const lib = JSON.parse(await files.get("library.json")!.text()) as { id: string }[];
    expect(lib.map((v) => v.id).sort()).toEqual(["vid_gen", "vid_up"]);
    const media = files.get("media/med1abcd.mp4");
    expect(media).toBeTruthy();
    expect(new Uint8Array(await media!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await app.request("/backups/nope/download")).status).toBe(404);
  });

  test("upload + restore round-trips into a fresh db", async () => {
    await seedMedia();
    const row = (await (await app.request("/backups", { method: "POST" })).json()) as { id: string };
    const bytes = new Uint8Array(await (await app.request(`/backups/${row.id}/download`)).arrayBuffer());
    resetDbForTests();
    const up = await chunkedUpload(app, "backup", bytes, { filename: "b.tar", mime: "application/x-tar" });
    expect(up.status).toBe(201);
    const stored = (await up.json()) as { id: string; counts: Record<string, number> };
    expect(stored.counts).toMatchObject({ projects: 1, library: 2, media: 1 });
    const res = await app.request(`/backups/${stored.id}/restore`, { method: "POST" });
    expect(res.status).toBe(200);
    const rep = (await res.json()) as { imported: Record<string, number>; skipped: Record<string, number> };
    expect(rep.imported).toMatchObject({ projects: 1, elements: 1, library: 2, jobs: 1, media: 1 });
    expect((await app.request("/media/med1abcd")).status).toBe(200);

    // Second restore skips everything (merge, no dupes).
    const res2 = await app.request(`/backups/${stored.id}/restore`, { method: "POST" });
    const rep2 = (await res2.json()) as { imported: Record<string, number> };
    expect(Object.values(rep2.imported).every((n) => n === 0)).toBe(true);
  });

  test("upload rejects garbage", async () => {
    const up = await chunkedUpload(app, "backup", new TextEncoder().encode("hello"), { filename: "b.tar" });
    expect(up.status).toBe(422);
  });

  test("delete removes row and file", async () => {
    const row = (await (await app.request("/backups", { method: "POST" })).json()) as { id: string };
    expect((await app.request(`/backups/${row.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/backups/${row.id}`, { method: "DELETE" })).status).toBe(404);
    const list = (await (await app.request("/backups")).json()) as { backups: unknown[] };
    expect(list.backups).toEqual([]);
  });

  test("delete project removes children and hosted files", async () => {
    await seedMedia();
    expect(getDb().query("SELECT id FROM elements WHERE project_id='prj_bk'").all().length).toBe(1);
    const del = await app.request("/projects/prj_bk", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(getDb().query("SELECT id FROM elements WHERE project_id='prj_bk'").all().length).toBe(0);
    expect(getDb().query("SELECT id FROM library WHERE project_id='prj_bk'").all().length).toBe(0);
    expect(getDb().query("SELECT id FROM media WHERE id='med1abcd'").get()).toBeNull();
    expect((await app.request("/media/med1abcd")).status).toBe(404);
    expect((await app.request("/projects/prj_bk")).status).toBe(404);
  });
});
