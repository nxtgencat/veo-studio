import { describe, expect, test } from "bun:test";

import { vertexFetchOp, type VertexCtx } from "../src/vertex.ts";

const ctx: VertexCtx = { project: "p", location: "us-central1", token: "t" };

describe("vertex fetch", () => {
  test("polls via fetchPredictOperation, not generic GET", async () => {
    const orig = globalThis.fetch;
    let seenUrl = "";
    let seenBody = "";
    (globalThis as any).fetch = async (url: unknown, init: any) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          name: "operations/1",
          done: true,
          response: { videos: [{ gcsUri: "gs://b/v.mp4" }] },
        }),
        { status: 200 },
      );
    };
    try {
      const op = await vertexFetchOp("veo-3.1-fast-generate-001", "operations/1", ctx);
      expect(seenUrl).toBe(
        "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001:fetchPredictOperation",
      );
      const body = JSON.parse(seenBody) as { operationName?: string };
      expect(body.operationName).toBe("operations/1");
      expect(op.done).toBe(true);
      expect(op.videoUris).toEqual(["gs://b/v.mp4"]);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
});
