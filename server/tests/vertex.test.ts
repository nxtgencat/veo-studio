import { describe, expect, test } from "bun:test";

import { vertexFetchOp, type VertexCtx } from "../src/vertex.ts";

const ctx: VertexCtx = { project: "p", location: "us-central1", token: "t" };

describe("vertex fetch", () => {
  test("submit maps UI values to Vertex wire format", async () => {
    const orig = globalThis.fetch;
    let seenBody = "";
    (globalThis as any).fetch = async (_url: unknown, init: any) => {
      seenBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ name: "operations/2" }), { status: 200 });
    };
    try {
      const { vertexSubmit } = await import("../src/vertex.ts");
      await vertexSubmit(
        {
          model: "veo-3.1-generate-001",
          prompt: "p",
          aspectRatio: "16:9",
          resolution: "4K",
          durationSeconds: 8,
          audio: true,
          sampleCount: 1,
          person: "dont_allow",
          negativePrompt: "blurry",
        },
        ctx,
      );
      const body = JSON.parse(seenBody) as { parameters: Record<string, unknown> };
      expect(body.parameters.resolution).toBe("4k");
      expect(body.parameters.personGeneration).toBe("dont_allow");
      expect(body.parameters.negativePrompt).toBe("blurry");
    } finally {
      (globalThis as any).fetch = orig;
    }
  });
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
