// Cloud Storage bucket access checks (GCS JSON API, Bearer token).
// Used to validate a bucket ID before it is ever saved: only buckets that
// exist AND are reachable with the configured credentials persist.
//
// Check method: `testIamPermissions` for the exact object permissions the
// pipeline needs. A plain bucket-metadata GET would demand
// `storage.buckets.get`, which the recommended Storage Object User role does
// NOT include — so metadata GET is only a best-effort extra for display.

import { childLogger } from "./logger.ts";

const log = childLogger({ module: "gcs" });

const NEED_READ = ["storage.objects.get", "storage.objects.list"];
const PROBE = [...NEED_READ, "storage.objects.create"];

export interface BucketCheck {
  bucket: string;
  location: string;
  granted: string[];
  canWrite: boolean;
}

export async function checkBucket(bucket: string, token: string): Promise<BucketCheck> {
  const probeUrl =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}` +
    `/iam/testPermissions?permissions=${PROBE.join(",")}`;
  let probe: Response;
  try {
    probe = await fetch(probeUrl, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw Object.assign(new Error(`Bucket check unreachable: ${String(e)}`), { code: "E_BUCKET_UNREACHABLE" });
  }
  if (probe.status === 404) {
    throw Object.assign(new Error(`Bucket gs://${bucket} not found`), { code: "E_BUCKET_NOT_FOUND" });
  }
  if (!probe.ok) {
    const text = await probe.text().catch(() => "");
    throw Object.assign(new Error(`Bucket check failed (${probe.status}): ${text.slice(0, 200)}`), {
      code: "E_BUCKET_UNREACHABLE",
      status: probe.status,
    });
  }
  const granted = (((await probe.json()) as { permissions?: string[] }).permissions ?? []).filter((p) =>
    PROBE.includes(p),
  );
  const canRead = NEED_READ.some((p) => granted.includes(p));
  if (!canRead) {
    throw Object.assign(
      new Error(
        `No read access to gs://${bucket}: grant the service account Storage Object User ` +
          `(roles/storage.objectUser — read+write objects, no bucket admin needed). ` +
          `Note: Vertex's own service agent separately needs Storage Object Creator for outputs.`,
      ),
      { code: "E_BUCKET_FORBIDDEN" },
    );
  }
  // Best-effort location for display; Object User has no buckets.get, so 403 here is fine.
  let location = "unknown";
  try {
    const meta = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}?fields=location`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (meta.ok) location = ((await meta.json()) as { location?: string }).location ?? "unknown";
  } catch { /* display-only */ }
  const check = { bucket, location, granted, canWrite: granted.includes("storage.objects.create") };
  log.info(check, "bucket reachable");
  return check;
}
