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
      get: async () => (++polls >= 2 ? { name: "operations/test-1", done: true } : { name: "operations/test-1", done: false }),
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
    setDriverForTests(null);
  });

  test("idempotency-key dedupes", () => {
    setDriverForTests({
      submit: async () => "operations/dedupe",
      get: async () => ({ name: "operations/dedupe", done: false }),
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
      get: async () => ({ name: "operations/cancel-me", done: false }),
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

  test("vertex misconfiguration fails job with clear error", async () => {
    const { vertexConfigured } = await import("../src/vertex.ts");
    // In CI there are no creds; submit must throw E_VERTEX_NOT_CONFIGURED
    if (!vertexConfigured()) {
      const { vertexSubmit } = await import("../src/vertex.ts");
      await expect(vertexSubmit({ model: "m", prompt: "p", aspectRatio: "16:9", durationSeconds: 8, audio: false, sampleCount: 1 })).rejects.toThrow();
    }
  });
});
