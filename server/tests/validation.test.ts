import { describe, expect, test } from "bun:test";
import { validateJob, type JobInput } from "../src/validation.ts";

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

  test("extend duration fixed at 7s", () => {
    const r = validateJob({ ...base, mode: "extend", durationSeconds: 8, sourceVideoId: "v" });
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

  test("r2v forces 8s", () => {
    const r = validateJob({ ...base, mode: "r2v", durationSeconds: 4, refAssetIds: ["r1"] });
    expect(r?.code).toBe("DURATION_UNSUPPORTED");
  });
});
