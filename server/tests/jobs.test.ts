import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SQLITE_FILE = ":memory:";
process.env.JOB_POLL_MS = "10";
process.env.JOB_POLL_ATTEMPTS = "50";
process.env.MEDIA_DIR = join(tmpdir(), `veo-media-jobs-${process.pid}`);

import { getDb, resetDbForTests } from "../src/db.ts";
import { app } from "../src/routes.ts";
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

  test("RAI-filtered output fails loudly instead of succeeding empty", async () => {
    setDriverForTests({
      submit: async () => "operations/rai",
      get: async () => ({
        name: "operations/rai", done: true, videoUris: [],
        raiFiltered: { count: 2, reasons: ["body parts"] },
      }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const { createJob, getJob } = await import("../src/jobs.ts");
    const r = createJob(base, "key-rai");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "failed"; i++) {
      await Bun.sleep(20);
    }
    const row = getJob(r.jobId) as any;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("RAI_FILTERED");
    setDriverForTests(null);
  });

  test("crash recovery resumes ops and expires unsubmitted jobs", async () => {
    const { recoverInterrupted } = await import("../src/jobs.ts");
    const now = new Date().toISOString();
    const db = getDb();
    // Running WITH an op → resumed via driver (no resubmit).
    let submitted = 0;
    setDriverForTests({
      submit: async () => {
        submitted++;
        return "operations/recovered";
      },
      get: async () => ({ name: "operations/recovered", done: true, videoUris: [] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    db.query(
      `INSERT INTO jobs (id, project_id, idempotency_key, mode, model, prompt, resolution, aspect,
        duration_seconds, audio, sample_count, inputs_json, status, progress, cost_estimate, vertex_operation, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("job_crash_op", "prj_test", "k-crash-1", "t2v", "veo-3.1-fast-generate-001", "p", "720p", "16:9",
      8, 1, 1, "{}", "running", 15, 0.8, "operations/recovered", now, now);
    // Queued WITHOUT an op → expired, never submitted.
    db.query(
      `INSERT INTO jobs (id, project_id, idempotency_key, mode, model, prompt, resolution, aspect,
        duration_seconds, audio, sample_count, inputs_json, status, progress, cost_estimate, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("job_crash_noop", "prj_test", "k-crash-2", "t2v", "veo-3.1-fast-generate-001", "p", "720p", "16:9",
      8, 1, 1, "{}", "queued", 0, 0.8, now, now);
    const rec = await recoverInterrupted();
    expect(rec).toEqual({ resumed: 1, expired: 1 });
    expect(submitted).toBe(0);
    await settleBackground();
    expect((getJob("job_crash_op") as any).status).toBe("succeeded");
    const dead = getJob("job_crash_noop") as any;
    expect(dead.status).toBe("failed");
    expect(dead.error).toContain("SERVER_RESTARTED");
    setDriverForTests(null);
  });

  test("job payloads carry elapsed + eta timing", async () => {
    const r = createJob(base, "key-timing");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await app.request(`/jobs/${r.jobId}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      elapsedMs: number;
      etaMs: number;
      etaSource: string;
    };
    expect(typeof json.elapsedMs).toBe("number");
    // No successes recorded yet → tier fallback for Fast 720p.
    expect(json.etaMs).toBe(120_000);
    expect(json.etaSource).toBe("estimated");
    setDriverForTests(null);
  });

  test("repeated Vertex 404s fail fast with guidance", async () => {
    setDriverForTests({
      submit: async () => "operations/gone",
      get: async () => {
        throw Object.assign(new Error("Vertex returned an HTML 404 page"), {
          code: "E_VERTEX_GET",
          status: 404,
        });
      },
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    const { createJob, getJob } = await import("../src/jobs.ts");
    const r = createJob(base, "key-gone");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let i = 0; i < 100 && (getJob(r.jobId) as any).status !== "failed"; i++) {
      await Bun.sleep(20);
    }
    const failed = getJob(r.jobId) as any;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("VERTEX_OP_GONE");
    expect(failed.error).toContain("operations/gone");
    setDriverForTests(null);
  });

  test("success never shows without its library row (no vanish gap)", async () => {
    const { saveSettings } = await import("../src/auth.ts");
    saveSettings("prj_test", { saJson: await makeSaJson("gap@p.iam.gserviceaccount.com"), bucket: "test-bucket-1" });
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: unknown) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      // Slow archival widens the old race window on purpose.
      await Bun.sleep(300);
      return new Response(new Uint8Array([7, 7]), { status: 200, headers: { "Content-Type": "video/mp4" } });
    };
    setDriverForTests({
      submit: async () => "operations/gap",
      get: async () => ({ name: "operations/gap", done: true, videoUris: ["gs://test-bucket-1/veo/out.mp4"] }),
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    try {
      const { createJob, getJob } = await import("../src/jobs.ts");
      const r = createJob(base, "key-gap");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Tight poll: the web merges jobs+library exactly like this.
      let sawGap = false;
      for (let i = 0; i < 120; i++) {
        const job = getJob(r.jobId) as any;
        if (job.status === "succeeded") {
          const lib = getDb().query("SELECT id FROM library WHERE job_id=?").get(r.jobId);
          if (!lib) sawGap = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(sawGap).toBe(false);
      expect((getJob(r.jobId) as any).status).toBe("succeeded");
    } finally {
      (globalThis as any).fetch = orig;
      setDriverForTests(null);
    }
  });

  test("progress never steps backward", async () => {
    let polls = 0;
    setDriverForTests({
      submit: async () => "operations/mono",
      get: async () =>
        ++polls >= 8
          ? { name: "operations/mono", done: true, videoUris: [] }
          : { name: "operations/mono", done: false, videoUris: [] },
      cancel: async () => ({ cancelled: true, alreadyDone: false }),
    });
    try {
      const { createJob, getJob } = await import("../src/jobs.ts");
      const r = createJob(base, "key-mono");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const seen: number[] = [];
      for (let i = 0; i < 60; i++) {
        seen.push(Number((getJob(r.jobId) as any).progress) || 0);
        if ((getJob(r.jobId) as any).status === "succeeded") break;
        await Bun.sleep(5);
      }
      for (let i = 1; i < seen.length; i++) {
        expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!);
      }
      expect(seen[seen.length - 1]).toBe(100);
    } finally {
      setDriverForTests(null);
    }
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
