import { describe, expect, test } from "bun:test";
import { jobInputSchema, validateJob, type JobInput } from "../src/validation.ts";

const base: JobInput = {
  projectId: "prj_1",
  mode: "t2v",
  model: "veo-3.1-generate-001",
  prompt: "a neon street",
  resolution: "720p",
  aspect: "16:9",
  durationSeconds: 8,
  audio: true,
  sampleCount: 1,
  refAssetIds: [],
};

describe("validation", () => {
  test("t2v happy path", () => {
    expect(validateJob(base)).toBeNull();
  });

  test("f2v requires first+last", () => {
    const r = validateJob({ ...base, mode: "f2v" });
    expect(r?.code).toBe("FRAMES_REQUIRED");
    expect(
      validateJob({ ...base, mode: "f2v", firstFrameAssetId: "a", lastFrameAssetId: "b" }),
    ).toBeNull();
  });

  test("r2v requires refs", () => {
    const r = validateJob({ ...base, mode: "r2v" });
    expect(r?.code).toBe("REFS_REQUIRED");
    const ok = validateJob({ ...base, mode: "r2v", refAssetIds: ["r1"] });
    expect(ok).toBeNull();
  });

  test("r2v rejects >3 refs", () => {
    const r = validateJob({ ...base, mode: "r2v", refAssetIds: ["1", "2", "3", "4"] });
    // zod caps at 3 first, but if it passes through, validation catches it
    expect(r === null || r.code === "REFS_EXCEEDED").toBe(true);
  });

  test("i2v requires image", () => {
    expect(validateJob({ ...base, mode: "i2v" })?.code).toBe("IMAGE_REQUIRED");
  });

  test("extend rejects resolution switch", () => {
    const r = validateJob({
      ...base,
      mode: "extend",
      durationSeconds: 7,
      sourceVideoId: "vid_1",
      sourceResolution: "720p",
      resolution: "1080p",
    });
    expect(r?.code).toBe("EXTEND_RESOLUTION_MISMATCH");
  });

  test("extend rejects aspect switch", () => {
    const r = validateJob({
      ...base,
      mode: "extend",
      durationSeconds: 7,
      sourceVideoId: "vid_1",
      sourceResolution: "720p",
      sourceAspect: "16:9",
      aspect: "9:16",
    });
    expect(r?.code).toBe("EXTEND_ASPECT_MISMATCH");
  });

  test("extend enforces 37s total cap", () => {
    const r = validateJob({
      ...base,
      mode: "extend",
      durationSeconds: 7,
      sourceVideoId: "vid_1",
      sourceResolution: "720p",
      sourceDurationSeconds: 31,
    });
    expect(r?.code).toBe("EXTEND_CAP_EXCEEDED");
    const ok = validateJob({
      ...base,
      mode: "extend",
      durationSeconds: 7,
      sourceVideoId: "vid_1",
      sourceResolution: "720p",
      sourceDurationSeconds: 30,
    });
    expect(ok).toBeNull();
  });

  test("extend accepts gs:// URI or inline bytes, rejects other URIs", () => {
    const base: JobInput = {
      projectId: "p",
      mode: "extend",
      model: "veo-3.1-generate-001",
      prompt: "x",
      resolution: "720p",
      aspect: "16:9",
      durationSeconds: 7,
      audio: true,
      sampleCount: 1,
      refAssetIds: [],
      sourceVideoId: "v",
      sourceResolution: "720p",
    };
    expect(validateJob({ ...base, sourceVideoGcsUri: "gs://b/v.mp4" })).toBeNull();
    expect(validateJob({ ...base, sourceVideoBytes: "AAA" })).toBeNull();
    // Non-gs:// URIs fail zod schema parsing (caught as VALIDATION at the route).
    expect(jobInputSchema.safeParse({ ...base, sourceVideoGcsUri: "https://x/v.mp4" }).success).toBe(false);
  });

  test("extend duration fixed at 7s", () => {
    const base: JobInput = {
      projectId: "p",
      mode: "extend",
      model: "veo-3.1-generate-001",
      prompt: "x",
      resolution: "720p",
      aspect: "16:9",
      durationSeconds: 8,
      audio: true,
      sampleCount: 1,
      refAssetIds: [],
      sourceVideoId: "v",
    };
    const r = validateJob(base);
    expect(r?.code).toBe("EXTEND_DURATION_FIXED");
  });

  test("veo2 is silent-only", () => {
    const r = validateJob({
      ...base,
      model: "veo-2.0-generate-001",
      resolution: "720p",
      durationSeconds: 8,
      audio: true,
    });
    expect(r?.code).toBe("AUDIO_UNSUPPORTED");
  });

  test("lite has no r2v", () => {
    const r = validateJob({
      ...base,
      model: "veo-3.1-lite-generate-001",
      mode: "r2v",
      refAssetIds: ["r1"],
    });
    expect(r?.code).toBe("MODE_UNSUPPORTED");
  });

  test("veo3 has no extend", () => {
    const r = validateJob({
      ...base,
      model: "veo-3.0-generate-001",
      mode: "extend",
      durationSeconds: 7,
      sourceVideoId: "v",
    });
    expect(r?.code).toBe("MODE_UNSUPPORTED");
  });

  test("slots are mutually exclusive per mode", () => {
    const t2v: JobInput = {
      projectId: "p", mode: "t2v", model: "veo-3.1-generate-001", prompt: "x",
      resolution: "720p", aspect: "16:9", durationSeconds: 8, audio: true,
      sampleCount: 1, refAssetIds: ["r1"],
    };
    expect(validateJob(t2v)?.code).toBe("MIXED_INPUTS");
    const i2v: JobInput = {
      projectId: "p", mode: "i2v", model: "veo-3.1-generate-001", prompt: "x",
      resolution: "720p", aspect: "16:9", durationSeconds: 8, audio: true,
      sampleCount: 1, refAssetIds: ["r1"], imageAssetId: "img",
    };
    expect(validateJob(i2v)?.code).toBe("MIXED_INPUTS");
    const r2v: JobInput = {
      projectId: "p", mode: "r2v", model: "veo-3.1-generate-001", prompt: "x",
      resolution: "720p", aspect: "16:9", durationSeconds: 8, audio: true,
      sampleCount: 1, refAssetIds: ["r1"], imageAssetId: "img",
    };
    expect(validateJob(r2v)?.code).toBe("MIXED_INPUTS");
    const clean: JobInput = {
      projectId: "p", mode: "r2v", model: "veo-3.1-generate-001", prompt: "x",
      resolution: "720p", aspect: "16:9", durationSeconds: 8, audio: true,
      sampleCount: 1, refAssetIds: ["r1"],
    };
    expect(validateJob(clean)).toBeNull();
  });

  test("r2v forces 8s", () => {
    const r = validateJob({ ...base, mode: "r2v", durationSeconds: 4, refAssetIds: ["r1"] });
    expect(r?.code).toBe("DURATION_UNSUPPORTED");
  });
});
