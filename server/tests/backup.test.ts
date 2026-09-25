import { beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_FILE = ":memory:";
process.env.MEDIA_DIR = join(tmpdir(), `veo-media-backup-${process.pid}`);

import { getDb, resetDbForTests } from "../src/db.ts";
import { nowIso } from "../src/db.ts";
import { mediaDir } from "../src/media-store.ts";
import { app } from "../src/routes.ts";

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

describe("backup", () => {
  test("defaults export projects+settings only", async () => {
    await seedMedia();
    const res = await app.request("/backup");
    expect(res.status).toBe(200);
    const files = await new Bun.Archive(new Uint8Array(await res.arrayBuffer())).files();
    expect([...files.keys()].sort()).toEqual(
      ["manifest.json", "media.json", "projects.json", "settings.json"].sort(),
    );
    const manifest = JSON.parse(await files.get("manifest.json")!.text()) as { counts: Record<string, number> };
    expect(manifest.counts.projects).toBe(1);
    expect(manifest.counts.elements).toBe(0);
    expect(manifest.counts.library).toBe(0);
  });

  test("scoped export includes selected data + media bytes", async () => {
    await seedMedia();
    const res = await app.request("/backup?elements=1&generated=1&uploads=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("veo-backup-");
    const files = await new Bun.Archive(new Uint8Array(await res.arrayBuffer())).files();
    expect(files.has("elements.json")).toBe(true);
    expect(files.has("library.json")).toBe(true);
    expect(files.has("jobs.json")).toBe(true);
    const lib = JSON.parse(await files.get("library.json")!.text()) as { id: string }[];
    expect(lib.map((v) => v.id).sort()).toEqual(["vid_gen", "vid_up"]);
    const media = files.get("media/med1abcd.mp4");
    expect(media).toBeTruthy();
    expect(new Uint8Array(await media!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("generated-only excludes uploads and elements", async () => {
    const res = await app.request("/backup?generated=1");
    const files = await new Bun.Archive(new Uint8Array(await res.arrayBuffer())).files();
    expect(files.has("elements.json")).toBe(false);
    const lib = JSON.parse(await files.get("library.json")!.text()) as { id: string }[];
    expect(lib.map((v) => v.id)).toEqual(["vid_gen"]);
  });

  test("restore round-trips into a fresh db", async () => {
    await seedMedia();
    const full = new Uint8Array(await (await app.request("/backup?elements=1&generated=1&uploads=1")).arrayBuffer());
    resetDbForTests();
    const fd = new FormData();
    fd.append("file", new File([full.buffer as ArrayBuffer], "b.tar.gz", { type: "application/gzip" }));
    const res = await app.request("/restore", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const rep = (await res.json()) as { imported: Record<string, number>; skipped: Record<string, number> };
    expect(rep.imported).toMatchObject({ projects: 1, elements: 1, library: 2, jobs: 1, media: 1 });
    const lib = await app.request("/library?projectId=prj_bk");
    const videos = ((await lib.json()) as { videos: unknown[] }).videos;
    expect(videos.length).toBe(2);
    const media = await app.request("/media/med1abcd");
    expect(media.status).toBe(200);

    // Second restore skips everything (merge, no dupes).
    const fd2 = new FormData();
    fd2.append("file", new File([full.buffer as ArrayBuffer], "b.tar.gz", { type: "application/gzip" }));
    const res2 = await app.request("/restore", { method: "POST", body: fd2 });
    const rep2 = (await res2.json()) as { imported: Record<string, number> };
    expect(Object.values(rep2.imported).every((n) => n === 0)).toBe(true);
  });

  test("restore rejects garbage", async () => {
    const fd = new FormData();
    fd.append("file", new File(["hello"], "b.tar.gz", { type: "application/gzip" }));
    const res = await app.request("/restore", { method: "POST", body: fd });
    expect(res.status).toBe(422);
  });

  test("inspect reports contents without importing", async () => {
    await seedMedia();
    const full = new Uint8Array(await (await app.request("/backup?elements=1&generated=1&uploads=1")).arrayBuffer());
    const fd = new FormData();
    fd.append("file", new File([full.buffer as ArrayBuffer], "b.tar.gz", { type: "application/gzip" }));
    const res = await app.request("/restore/inspect", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { manifest: { version: number }; counts: Record<string, number> };
    expect(json.manifest.version).toBe(1);
    expect(json.counts).toMatchObject({ projects: 1, elements: 1, library: 2, jobs: 1, media: 1 });
    // Nothing imported by inspecting.
    expect(getDb().query("SELECT id FROM library WHERE project_id='prj_bk'").all().length).toBe(2);

    const bad = new FormData();
    bad.append("file", new File(["nope"], "b.tar.gz", { type: "application/gzip" }));
    expect((await app.request("/restore/inspect", { method: "POST", body: bad })).status).toBe(422);
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
