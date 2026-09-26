// Shared bun:test helpers (fake SA keys, background-job polling).
import { getJob } from "../src/jobs.ts";

/** Throwaway service-account JSON (fresh RSA key, Bun-first base64). */
export async function makeSaJson(email: string): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return JSON.stringify({
    type: "service_account",
    project_id: "p",
    private_key: `-----BEGIN PRIVATE KEY-----\n${der.toBase64()}\n-----END PRIVATE KEY-----\n`,
    client_email: email,
  });
}

/** Poll a background job until it reaches `want` (2s budget, 20ms steps). */
export async function waitForJob(jobId: string, want: string): Promise<void> {
  for (let i = 0; i < 100 && (getJob(jobId) as any).status !== want; i++) {
    await Bun.sleep(20);
  }
}

type TestApp = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

/**
 * Drive the chunked upload protocol end-to-end (init → parts → complete),
 * returning the first non-OK response or the complete response. `part`
 * forces small slices to exercise multi-part assembly.
 */
export async function chunkedUpload(
  app: TestApp,
  kind: string,
  bytes: Uint8Array,
  opts?: { filename?: string; mime?: string; part?: number },
): Promise<Response> {
  const partSize = opts?.part ?? 8 * 1024 * 1024;
  const init = await app.request("/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind,
      filename: opts?.filename ?? "t.bin",
      mime: opts?.mime ?? "application/octet-stream",
      size: bytes.length,
    }),
  });
  if (init.status !== 201) return init;
  const { uploadId } = (await init.json()) as { uploadId: string };
  for (let off = 0, i = 0; off < bytes.length; off += partSize, i++) {
    const r = await app.request(`/uploads/${uploadId}/part?index=${i}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes.slice(off, off + partSize),
    });
    if (r.status !== 200) return r;
  }
  return app.request(`/uploads/${uploadId}/complete`, { method: "POST" });
}
