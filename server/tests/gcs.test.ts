import { describe, expect, test } from "bun:test";

import { checkBucket } from "../src/gcs.ts";

describe("gcs", () => {
  test("testIamPermissions uses repeated params (comma-joined is a 400)", async () => {
    const orig = globalThis.fetch;
    let probeUrl = "";
    (globalThis as any).fetch = async (url: unknown) => {
      if (String(url).includes("testPermissions") && !probeUrl) probeUrl = String(url);
      return new Response(JSON.stringify({ permissions: ["storage.objects.get"] }), { status: 200 });
    };
    try {
      const check = await checkBucket("bkt", "tok");
      expect(check.bucket).toBe("bkt");
      expect(probeUrl).toContain("permissions=storage.objects.get&permissions=storage.objects.list");
      expect(probeUrl).not.toContain("storage.objects.get%2C");
      expect(probeUrl).not.toContain("storage.objects.get,");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
});
