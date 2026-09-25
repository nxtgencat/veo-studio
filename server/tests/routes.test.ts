import { beforeEach, describe, expect, test } from "bun:test";

process.env.SQLITE_FILE = ":memory:";
process.env.JOB_POLL_MS = "5";
process.env.JOB_POLL_ATTEMPTS = "10";

import { getDb, resetDbForTests } from "../src/db.ts";
import { app } from "../src/routes.ts";
import { setDriverForTests } from "../src/jobs.ts";

// Real RSA keys so the live key check exercises the true signing path.
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

// Settle background tasks inside this file's lifetime so they never bleed
// into other test files' databases.
setDriverForTests({
  submit: async () => "operations/routes-test",
  get: async () => ({ name: "operations/routes-test", done: true, videoUris: [] }),
  cancel: async () => ({ cancelled: true, alreadyDone: false }),
});

function seedProject(id = "prj_routes") {
  const now = new Date().toISOString();
  getDb()
    .query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run(id, "Routes", now, now);
}

beforeEach(() => {
  resetDbForTests();
  seedProject();
});

async function postJob() {
  const res = await app.request(
    "/composer/jobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `k-${Math.random()}` },
      body: JSON.stringify({
        projectId: "prj_routes",
        mode: "t2v",
        model: "veo-3.1-fast-generate-001",
        prompt: "a test",
        resolution: "720p",
        aspect: "16:9",
        durationSeconds: 8,
        audio: true,
      }),
    },
  );
  return res;
}

describe("routes", () => {
  test("element upload rejects non-JPEG/PNG inline images", async () => {
    const gif = "data:image/gif;base64,R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=";
    const r = await app.request("/projects/prj_routes/elements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "assets", name: "Bad", imageUrl: gif, note: "" }),
    });
    expect(r.status).toBe(422);
    const json = (await r.json()) as { error: { code: string } };
    expect(json.error.code).toBe("E_IMAGE_TYPE");
  });

  test("GET /jobs lists created jobs", async () => {
    const r = await postJob();
    expect(r.status).toBe(202);
    const list = await app.request("/jobs?projectId=prj_routes");
    expect(list.status).toBe(200);
    const json = (await list.json()) as { jobs: unknown[] };
    expect(json.jobs.length).toBe(1);
  });

  test("import + delete library round-trip", async () => {
    const imp = await app.request("/library/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "prj_routes", prompt: "upload", durationSeconds: 5 }),
    });
    expect(imp.status).toBe(201);
    const { id } = (await imp.json()) as { id: string };
    const get = await app.request(`/library/${id}`);
    expect(get.status).toBe(200);
    const del = await app.request(`/library/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await app.request(`/library/${id}`)).status).toBe(404);
  });

  test("import rejects unknown project", async () => {
    const imp = await app.request("/library/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "nope" }),
    });
    expect(imp.status).toBe(404);
  });

  test("settings round-trip hides the private key", async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: unknown) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("testPermissions")) {
        return new Response(
          JSON.stringify({ permissions: ["storage.objects.get", "storage.objects.list", "storage.objects.create"] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ name: "my-veo-out-1", location: "US-CENTRAL1" }), { status: 200 });
    };
    try {
      const bad = await app.request("/projects/prj_routes/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ saJson: '{"type":"nope"}', bucket: "b" }),
      });
      expect(bad.status).toBe(422);
      const good = await app.request("/projects/prj_routes/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saJson: await makeSaJson("e@p.iam.gserviceaccount.com"),
          bucket: "my-veo-out-1",
          useBucket: true,
          authMode: "service_account",
        }),
      });
      expect(good.status).toBe(200);
      const goodJson = (await good.json()) as Record<string, unknown>;
      expect((goodJson.bucketCheck as { location: string }).location).toBe("US-CENTRAL1");
      const got = (await (await app.request("/projects/prj_routes/settings")).json()) as Record<string, unknown>;
      expect(got.hasSaJson).toBe(true);
      expect(got.saEmail).toBe("e@p.iam.gserviceaccount.com");
      expect(got).not.toHaveProperty("saJson");
      expect(got).not.toHaveProperty("private_key");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("object-user without bucket-metadata access still saves", async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: unknown) => {
      const u = String(url);
      if (u.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      }
      if (u.includes("testPermissions")) {
        // Storage Object User: object read+write, but NO storage.buckets.get.
        return new Response(
          JSON.stringify({ permissions: ["storage.objects.get", "storage.objects.list", "storage.objects.create"] }),
          { status: 200 },
        );
      }
      return new Response("forbidden", { status: 403 });
    };
    try {
      const r = await app.request("/projects/prj_routes/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saJson: await makeSaJson("objuser@p.iam.gserviceaccount.com"),
          bucket: "ou-bucket",
        }),
      });
      expect(r.status).toBe(200);
      const got = (await (await app.request("/projects/prj_routes/settings")).json()) as Record<string, unknown>;
      expect(got.bucket).toBe("ou-bucket");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("unreachable bucket is rejected and never saved", async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: unknown) =>
      String(url).includes("oauth2.googleapis.com/token")
        ? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    try {
      const r = await app.request("/projects/prj_routes/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          saJson: await makeSaJson("ghost@p.iam.gserviceaccount.com"),
          bucket: "ghost-bucket-xyz",
        }),
      });
      expect(r.status).toBe(422);
      const json = (await r.json()) as { error: { code: string } };
      expect(json.error.code).toBe("E_BUCKET_NOT_FOUND");
      // Previous attempt must not have persisted the SA either (all-or-nothing).
      const got = (await (await app.request("/projects/prj_routes/settings")).json()) as Record<string, unknown>;
      expect(got.bucket).toBe("");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("dead service-account key is rejected before saving", async () => {
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    try {
      const r = await app.request("/projects/prj_routes/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Fresh email so no cached token masks the stubbed 400.
        body: JSON.stringify({
          saJson: JSON.stringify({ type: "service_account", project_id: "p", private_key: "k", client_email: "dead@p.iam.gserviceaccount.com" }),
        }),
      });
      expect(r.status).toBe(422);
      const got = (await (await app.request("/projects/prj_routes/settings")).json()) as Record<string, unknown>;
      expect(got.hasSaJson).toBe(false);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("extend resolution switch rejected with code", async () => {
    const r = await app.request("/composer/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "k-ext" },
      body: JSON.stringify({
        projectId: "prj_routes",
        mode: "extend",
        model: "veo-3.1-generate-001",
        prompt: "continue",
        resolution: "1080p",
        aspect: "16:9",
        durationSeconds: 7,
        audio: true,
        sourceVideoId: "vid_x",
        sourceResolution: "720p",
      }),
    });
    expect(r.status).toBe(422);
    const json = (await r.json()) as { error: { code: string } };
    expect(json.error.code).toBe("EXTEND_RESOLUTION_MISMATCH");
  });
});
