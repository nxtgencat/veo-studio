// Service-account auth for Vertex AI (and future GCS use).
// The operator pastes one SA JSON key in Settings — it carries project_id,
// client_email and private_key, so no other credential config is needed.
// Flow (per Google's server-to-server OAuth docs): RS256-signed JWT
// assertion → POST https://oauth2.googleapis.com/token → cached Bearer
// access token (scope: cloud-platform). Signed with Bun WebCrypto, zero deps.

import { getDb, nowIso } from "./db.ts";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

export type AuthMode = "service_account" | "env";

export interface SaCreds {
  type: string;
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
}

export interface StoredSettings {
  bucket: string;
  useBucket: boolean;
  authMode: AuthMode;
  saJson: string;
}

export function parseSaJson(raw: string): SaCreds {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Service account JSON does not parse"), { code: "E_SA_INVALID" });
  }
  const o = j as Record<string, unknown>;
  if (o.type !== "service_account") {
    throw Object.assign(new Error("JSON is valid but type is not service_account"), { code: "E_SA_INVALID" });
  }
  for (const k of ["project_id", "private_key", "client_email"] as const) {
    if (typeof o[k] !== "string" || !(o[k] as string).trim()) {
      throw Object.assign(new Error(`Service account JSON is missing ${k}`), { code: "E_SA_INVALID" });
    }
  }
  return o as unknown as SaCreds;
}

export function getSettings(projectId: string): StoredSettings {
  const row = getDb()
    .query("SELECT sa_json, bucket, use_bucket, auth_mode FROM project_settings WHERE project_id=?")
    .get(projectId) as { sa_json: string; bucket: string; use_bucket: number; auth_mode: string } | null;
  if (!row) return { bucket: "", useBucket: true, authMode: "service_account", saJson: "" };
  return {
    bucket: row.bucket ?? "",
    useBucket: !!row.use_bucket,
    authMode: row.auth_mode === "env" ? "env" : "service_account",
    saJson: row.sa_json ?? "",
  };
}

export function saveSettings(
  projectId: string,
  patch: { saJson?: string; bucket?: string; useBucket?: boolean; authMode?: AuthMode },
): void {
  const cur = getSettings(projectId);
  const next = {
    saJson: patch.saJson !== undefined ? patch.saJson : cur.saJson,
    bucket: patch.bucket !== undefined ? patch.bucket : cur.bucket,
    useBucket: patch.useBucket !== undefined ? patch.useBucket : cur.useBucket,
    authMode: patch.authMode !== undefined ? patch.authMode : cur.authMode,
  };
  if (next.saJson.trim()) parseSaJson(next.saJson);
  if (next.bucket.trim() && !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(next.bucket.trim())) {
    throw Object.assign(new Error("Bucket name looks invalid"), { code: "E_BUCKET_INVALID" });
  }
  getDb()
    .query(
      `INSERT INTO project_settings (project_id, sa_json, bucket, use_bucket, auth_mode, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET sa_json=excluded.sa_json, bucket=excluded.bucket,
         use_bucket=excluded.use_bucket, auth_mode=excluded.auth_mode, updated_at=excluded.updated_at`,
    )
    .run(projectId, next.saJson, next.bucket.trim(), next.useBucket ? 1 : 0, next.authMode, nowIso());
}

function b64url(data: Uint8Array): string {
  return data
    .toBase64()
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array {
  return Uint8Array.fromBase64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
}

export async function signAssertion(sa: SaCreds, scope = CLOUD_SCOPE): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (sa.private_key_id) header.kid = sa.private_key_id;
  const claims = {
    iss: sa.client_email,
    scope,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const enc = new TextEncoder();
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(sa.private_key).buffer as ArrayBuffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw Object.assign(new Error("private_key is not a valid PKCS#8 RSA key"), { code: "E_SA_INVALID" });
  }
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

const tokenCache = new Map<string, { token: string; expMs: number }>();

/** Test hook: clear the in-memory token cache. */
export function clearTokenCache() {
  tokenCache.clear();
}

export async function saAccessToken(sa: SaCreds, scope = CLOUD_SCOPE): Promise<string> {
  const cacheKey = `${sa.client_email} ${scope}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expMs > Date.now()) return hit.token;
  const assertion = await signAssertion(sa, scope);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`Token exchange failed (${res.status}): ${text.slice(0, 200)}`), {
      code: "E_SA_TOKEN",
      status: res.status,
    });
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw Object.assign(new Error("Token endpoint returned no access_token"), { code: "E_SA_TOKEN" });
  }
  tokenCache.set(cacheKey, {
    token: json.access_token,
    expMs: Date.now() + ((json.expires_in ?? 3600) - 60) * 1000,
  });
  return json.access_token;
}

export interface ResolvedAuth {
  project: string;
  location: string;
  source: "service_account" | "env";
  getToken: () => Promise<string>;
}

/** Default is service-account-only; env creds apply only when toggled per project. */
export async function resolveAuth(projectId: string): Promise<ResolvedAuth> {
  const location = process.env.VERTEXAI_LOCATION ?? "us-central1";
  const s = getSettings(projectId);
  if (s.authMode === "env") {
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.VERTEXAI_PROJECT ?? "";
    const token = process.env.VERTEX_ACCESS_TOKEN ?? "";
    if (!project || !token) {
      throw Object.assign(
        new Error("Environment auth selected but GOOGLE_CLOUD_PROJECT / VERTEX_ACCESS_TOKEN are missing"),
        { code: "E_VERTEX_NOT_CONFIGURED" },
      );
    }
    return { project, location, source: "env", getToken: async () => token };
  }
  if (!s.saJson.trim()) {
    throw Object.assign(
      new Error("No service account configured — paste service account JSON in Settings → Google Cloud connection"),
      { code: "E_SA_MISSING" },
    );
  }
  const sa = parseSaJson(s.saJson);
  return { project: sa.project_id, location, source: "service_account", getToken: () => saAccessToken(sa) };
}
