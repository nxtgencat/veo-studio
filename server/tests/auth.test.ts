import { beforeEach, describe, expect, test } from "bun:test";

process.env.SQLITE_FILE = ":memory:";

import {
  clearTokenCache,
  getSettings,
  parseSaJson,
  resolveAuth,
  saAccessToken,
  saveSettings,
  signAssertion,
  type SaCreds,
} from "../src/auth.ts";
import { getDb, resetDbForTests } from "../src/db.ts";

function seedProject(id = "prj_auth") {
  const now = new Date().toISOString();
  getDb()
    .query("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?,?,?,?)")
    .run(id, "Auth", now, now);
}

beforeEach(() => {
  resetDbForTests();
  clearTokenCache();
  seedProject();
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e: any) {
    return String(e?.code ?? e?.message ?? e);
  }
  return "NO_THROW";
}

async function syncCodeOf(fn: () => unknown): Promise<string> {
  try {
    fn();
  } catch (e: any) {
    return String(e?.code ?? e?.message ?? e);
  }
  return "NO_THROW";
}

async function makeSa(): Promise<SaCreds> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----\n`;
  return {
    type: "service_account",
    project_id: "demo-proj-123",
    private_key_id: "kid1",
    private_key: pem,
    client_email: "svc@demo-proj-123.iam.gserviceaccount.com",
  };
}

describe("auth", () => {
  test("parseSaJson rejects garbage", async () => {
    expect(await syncCodeOf(() => parseSaJson("not json"))).toBe("E_SA_INVALID");
    expect(await syncCodeOf(() => parseSaJson('{"type":"oauth2"}'))).toBe("E_SA_INVALID");
    expect(await syncCodeOf(() => parseSaJson('{"type":"service_account"}'))).toBe("E_SA_INVALID");
  });

  test("signAssertion builds a verifiable RS256 JWT", async () => {
    const sa = await makeSa();
    const jwt = await signAssertion(sa);
    const [h, p, s] = jwt.split(".");
    expect([h, p, s].every(Boolean)).toBe(true);
    const header = JSON.parse(atob(h!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe("kid1");
    const claims = JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.iss).toBe(sa.client_email);
    expect(claims.aud).toContain("oauth2.googleapis.com/token");
    expect(claims.exp - claims.iat).toBe(3600);
  });

  test("saAccessToken caches until expiry", async () => {
    const sa = await makeSa();
    const orig = globalThis.fetch;
    let calls = 0;
    let lastBody = "";
    (globalThis as any).fetch = async (_url: unknown, init: any) => {
      calls++;
      lastBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "tok123", expires_in: 3600 }), { status: 200 });
    };
    try {
      const t1 = await saAccessToken(sa);
      const t2 = await saAccessToken(sa);
      expect(t1).toBe("tok123");
      expect(t2).toBe("tok123");
      expect(calls).toBe(1);
      expect(lastBody).toContain("urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  test("resolveAuth defaults to service-account and demands SA JSON", async () => {
    expect(await codeOf(resolveAuth("prj_auth"))).toBe("E_SA_MISSING");
  });

  test("resolveAuth env mode reads env creds", async () => {
    saveSettings("prj_auth", { authMode: "env" });
    delete process.env.VERTEX_ACCESS_TOKEN;
    expect(await codeOf(resolveAuth("prj_auth"))).toBe("E_VERTEX_NOT_CONFIGURED");
    process.env.GOOGLE_CLOUD_PROJECT = "env-proj";
    process.env.VERTEX_ACCESS_TOKEN = "env-token";
    try {
      const a = await resolveAuth("prj_auth");
      expect(a.source).toBe("env");
      expect(a.project).toBe("env-proj");
      expect(await a.getToken()).toBe("env-token");
    } finally {
      delete process.env.GOOGLE_CLOUD_PROJECT;
      delete process.env.VERTEX_ACCESS_TOKEN;
    }
  });

  test("saveSettings validates bucket and round-trips", async () => {
    expect(await syncCodeOf(() => saveSettings("prj_auth", { bucket: "BAD NAME!" }))).toBe("E_BUCKET_INVALID");
    saveSettings("prj_auth", { bucket: "my-veo-out-1", useBucket: true });
    const s = getSettings("prj_auth");
    expect(s.bucket).toBe("my-veo-out-1");
    expect(s.useBucket).toBe(true);
    expect(s.authMode).toBe("service_account");
  });
});
