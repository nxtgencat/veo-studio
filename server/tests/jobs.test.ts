import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_FILE = ":memory:";
process.env.JOB_POLL_MS = "10";
process.env.JOB_POLL_ATTEMPTS = "50";
process.env.MEDIA_DIR = join(tmpdir(), `veo-media-jobs-${process.pid}`);

import { getDb, resetDbForTests } from "../src/db.ts";
import { cancelJob, createJob, getJob, setDriverForTests, settleBackground } from "../src/jobs.ts";
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

async function makeSaJson(email: string): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  return JSON.stringify({
    type: "service_account",
    project_id: "p",
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`,
    client_email: email,
  });
}

beforeEach(() => {
  resetDbForTests();
  seedProject();
});

afterEach(async () => {
  // Drain background tasks so none spill into the next test's database.
  await settleBackground();
  setDriverForTests(null);
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

  test("succeeded bucket output is archived server-side", async () => {
    const { saveSettings } = await import("../src/auth.ts");
    saveSettings("prj_test", { saJson: await makeSaJson("arc@p.iam.gserviceaccount.com"), bucket: "test-bucket-1" });
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: unknown) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      return new Response(new Uint8Array([9, 9, 9, 9]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
    };
    setDriverForTests({
      submit: async () => "operations/arc",
      get: async () => ({ name: "operations/arc", done: true, videoUris: ["gs://b/veo/out.mp4"] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    try {
      const { createJob, getJob } = await import("../src/jobs.ts");
      const r = createJob(base, "key-arc");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "succeeded"; i++) {
        await Bun.sleep(20);
      }
      const lib = getDb().query("SELECT * FROM library WHERE job_id=?").get(r.jobId) as any;
      expect(lib.video_url.startsWith("/media/")).toBe(true);
      expect(lib.gcs_uri).toBe("gs://b/veo/out.mp4");
    } finally {
      (globalThis as any).fetch = orig;
      setDriverForTests(null);
    }
  });

  test("f2v aspect mismatch fails server-side", async () => {
    const { encodePngRgba } = await import("../src/frames.ts");
    const land = encodePngRgba(new Uint8Array(8 * 4 * 4).fill(10), 8, 4).toBase64();
    const port = encodePngRgba(new Uint8Array(4 * 8 * 4).fill(10), 4, 8).toBase64();
    const now = new Date().toISOString();
    getDb()
      .query("INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)")
      .run("el_first", "prj_test", "frames", "First", `data:image/png;base64,${land}`, "", now);
    getDb()
      .query("INSERT INTO elements (id, project_id, category, name, image_url, note, created_at) VALUES (?,?,?,?,?,?,?)")
      .run("el_last", "prj_test", "frames", "Last", `data:image/png;base64,${port}`, "", now);
    setDriverForTests({
      submit: async () => {
        throw new Error("must not submit mismatched frames");
      },
      get: async () => ({ name: "operations/f2v", done: false, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const { createJob, getJob } = await import("../src/jobs.ts");
    const r = createJob(
      {
        projectId: "prj_test", mode: "f2v", model: "veo-3.1-generate-001", prompt: "x",
        resolution: "720p", aspect: "16:9", durationSeconds: 8, audio: true,
        sampleCount: 1, refAssetIds: [], firstFrameAssetId: "el_first", lastFrameAssetId: "el_last",
      },
      "key-f2v-aspect",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "failed"; i++) {
      await Bun.sleep(20);
    }
    expect((getJob(r.jobId) as any).status).toBe("failed");
    expect((getJob(r.jobId) as any).error).toContain("FRAMES_ASPECT_MISMATCH");
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
