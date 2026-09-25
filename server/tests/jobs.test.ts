import { beforeEach, describe, expect, test } from "bun:test";

process.env.SQLITE_FILE = ":memory:";
process.env.JOB_POLL_MS = "10";
process.env.JOB_POLL_ATTEMPTS = "50";

import { getDb, resetDbForTests } from "../src/db.ts";
import { cancelJob, createJob, getJob, setDriverForTests } from "../src/jobs.ts";
import type { JobInput } from "../src/validation.ts";

const base: JobInput = {
  projectId: "prj_test",
  mode: "t2v",
  model: "veo-3.1-fast-generate-001",
  prompt: "test clip",
  resolution: "720p",
  aspect: "16:9",
  durationSeconds: 8,
  audio: true,
  sampleCount: 1,
  refAssetIds: [],
};

function seedProject() {
  getDb()
    .query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run("prj_test", "Test", new Date().toISOString(), new Date().toISOString());
}

beforeEach(() => {
  resetDbForTests();
  seedProject();
});

describe("async job flow", () => {
  test("create returns immediately, completes via driver, writes library row", async () => {
    let polls = 0;
    setDriverForTests({
      submit: async () => "operations/test-1",
      get: async () => (++polls >= 2 ? { name: "operations/test-1", done: true, videoUris: ["gs://b/veo/out.mp4"] } : { name: "operations/test-1", done: false, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const r = createJob(base, "key-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // immediate return: still queued/running, not yet succeeded
    const early = getJob(r.jobId) as any;
    expect(["queued", "running"]).toContain(early.status);

    // wait for background completion
    for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "succeeded"; i++) {
      await Bun.sleep(20);
    }
    const done = getJob(r.jobId) as any;
    expect(done.status).toBe("succeeded");
    expect(done.progress).toBe(100);
    const lib = getDb().query("SELECT * FROM library WHERE job_id=?").get(r.jobId) as any;
    expect(lib).toBeTruthy();
    expect(lib.cost_estimate).toBeGreaterThan(0);
    expect(lib.video_url).toBe("gs://b/veo/out.mp4");
    setDriverForTests(null);
  });

  test("idempotency-key dedupes", () => {
    setDriverForTests({
      submit: async () => "operations/dedupe",
      get: async () => ({ name: "operations/dedupe", done: false, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const a = createJob(base, "same-key");
    const b = createJob(base, "same-key");
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.jobId).toBe(b.jobId);
      expect(b.deduped).toBe(true);
    }
    setDriverForTests(null);
  });

  test("cancel before completion marks cancelled", async () => {
    setDriverForTests({
      submit: async () => {
        await Bun.sleep(50);
        return "operations/cancel-me";
      },
      get: async () => ({ name: "operations/cancel-me", done: false, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const r = createJob({ ...base, prompt: "cancel clip" }, "key-cancel");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = await cancelJob(r.jobId);
    expect(c.ok).toBe(true);
    if (c.ok) expect(["cancelled", "already_done"]).toContain(c.status);
    setDriverForTests(null);
  });

  test("i2v submit carries resolved image bytes", async () => {
    const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const now = new Date().toISOString();
    getDb()
      .query("INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)")
      .run("el_still", "prj_test", "frames", "Still", `data:image/png;base64,${PNG_1PX}`, "", now);
    let seen: any = null;
    setDriverForTests({
      submit: async (p) => {
        seen = p;
        return "operations/i2v";
      },
      get: async () => ({ name: "operations/i2v", done: true, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const { createJob, getJob } = await import("../src/jobs.ts");
    const r = createJob({ ...base, mode: "i2v", imageAssetId: "el_still" }, "key-i2v");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "succeeded"; i++) {
      await Bun.sleep(20);
    }
    expect((getJob(r.jobId) as any).status).toBe("succeeded");
    expect(seen?.imageBytes).toBe(PNG_1PX);
    expect(seen?.imageMimeType).toBe("image/png");
    setDriverForTests(null);
  });

  test("missing auth fails job with actionable error", async () => {
    setDriverForTests(null);
    delete process.env.VERTEX_ACCESS_TOKEN;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.VERTEXAI_PROJECT;
    const { resolveAuth } = await import("../src/auth.ts");
    // Default mode is service-account-only; nothing pasted → clear guidance.
    let code = "NO_THROW";
    try {
      await resolveAuth("prj_test");
    } catch (e: any) {
      code = String(e?.code ?? e?.message ?? e);
    }
    expect(code).toBe("E_SA_MISSING");
  });

  test("extend without GCS source fails with guidance", async () => {
    setDriverForTests({
      submit: async () => {
        throw new Error("must not submit without a GCS source");
      },
      get: async () => ({ name: "operations/x", done: false, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const { createJob, getJob } = await import("../src/jobs.ts");
    const r = createJob(
      {
        projectId: "prj_test",
        mode: "extend",
        model: "veo-3.1-generate-001",
        prompt: "continue",
        resolution: "720p",
        aspect: "16:9",
        durationSeconds: 7,
        audio: true,
        sampleCount: 1,
        refAssetIds: [],
        sourceVideoId: "vid_missing",
        sourceResolution: "720p",
      },
      "key-ext-nogcs",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 50 && (getJob(r.jobId) as any).status === "queued"; i++) {
      await Bun.sleep(20);
    }
    for (let i = 0; i < 50 && !((getJob(r.jobId) as any).status === "failed"); i++) {
      await Bun.sleep(20);
    }
    expect((getJob(r.jobId) as any).status).toBe("failed");
    expect((getJob(r.jobId) as any).error).toContain("EXTEND_NEEDS_SOURCE");
    setDriverForTests(null);
  });

  test("extend with inline bytes submits video bytes", async () => {
    let seen: any = null;
    setDriverForTests({
      submit: async (p) => {
        seen = p;
        return "operations/ext-bytes";
      },
      get: async () => ({ name: "operations/ext-bytes", done: true, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const { createJob, getJob } = await import("../src/jobs.ts");
    const r = createJob(
      {
        projectId: "prj_test",
        mode: "extend",
        model: "veo-3.1-generate-001",
        prompt: "continue",
        resolution: "720p",
        aspect: "16:9",
        durationSeconds: 7,
        audio: true,
        sampleCount: 1,
        refAssetIds: [],
        sourceVideoId: "vid_missing",
        sourceResolution: "720p",
        sourceVideoBytes: "AAAABBBB",
        sourceVideoMimeType: "video/mp4",
      },
      "key-ext-bytes",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "succeeded"; i++) {
      await Bun.sleep(20);
    }
    expect((getJob(r.jobId) as any).status).toBe("succeeded");
    expect(seen).toBeTruthy();
    expect(seen.sourceVideoBytes).toBe("AAAABBBB");
    expect(seen.sourceVideoGcsUri).toBeUndefined();
    setDriverForTests(null);
  });
});
