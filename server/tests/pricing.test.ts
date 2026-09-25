import { describe, expect, test } from "bun:test";
import { estimateCost, fallbackEtaMs, measuredEtaMs, ratePerSecond } from "../src/pricing.ts";

describe("pricing", () => {
  test("standard 1080p audio 8s = 3.20", () => {
    expect(ratePerSecond("Standard", "veo-3.1-generate-001", "1080p", true)).toBe(0.4);
    expect(
      estimateCost({
        tier: "Standard",
        modelId: "veo-3.1-generate-001",
        resolution: "1080p",
        audio: true,
        durationSeconds: 8,
      }),
    ).toBe(3.2);
  });

  test("fast 1080p audio 8s = 0.96", () => {
    expect(
      estimateCost({
        tier: "Fast",
        modelId: "veo-3.1-fast-generate-001",
        resolution: "1080p",
        audio: true,
        durationSeconds: 8,
      }),
    ).toBe(0.96);
  });

  test("disabling audio halves standard cost", () => {
    const withAudio = estimateCost({
      tier: "Standard",
      modelId: "veo-3.1-generate-001",
      resolution: "720p",
      audio: true,
      durationSeconds: 8,
    });
    const silent = estimateCost({
      tier: "Standard",
      modelId: "veo-3.1-generate-001",
      resolution: "720p",
      audio: false,
      durationSeconds: 8,
    });
    expect(withAudio).toBe(3.2);
    expect(silent).toBe(1.6);
  });

  test("lite 720p silent 6s = 0.18", () => {
    expect(
      estimateCost({
        tier: "Lite",
        modelId: "veo-3.1-lite-generate-001",
        resolution: "720p",
        audio: false,
        durationSeconds: 6,
      }),
    ).toBe(0.18);
  });

  test("veo2 silent 8s = 4.00, audio throws", () => {
    expect(
      estimateCost({
        tier: "Legacy",
        modelId: "veo-2.0-generate-001",
        resolution: "720p",
        audio: false,
        durationSeconds: 8,
      }),
    ).toBe(4.0);
    expect(() => ratePerSecond("Legacy", "veo-2.0-generate-001", "720p", true)).toThrow();
  });

  test("sampleCount multiplies", () => {
    expect(
      estimateCost({
        tier: "Fast",
        modelId: "veo-3.1-fast-generate-001",
        resolution: "720p",
        audio: false,
        durationSeconds: 4,
        sampleCount: 4,
      }),
    ).toBe(1.28);
  });
});

describe("eta", () => {
  test("measuredEtaMs takes the median of recent durations", () => {
    expect(measuredEtaMs([])).toBeNull();
    expect(measuredEtaMs([100_000])).toBe(100_000);
    expect(measuredEtaMs([60_000, 120_000, 90_000])).toBe(90_000);
    expect(measuredEtaMs([60_000, 120_000])).toBe(90_000);
    expect(measuredEtaMs([-5, 0, NaN])).toBeNull();
  });

  test("fallbackEtaMs scales 4K and tiers", () => {
    expect(fallbackEtaMs("Fast", "720p")).toBe(120_000);
    expect(fallbackEtaMs("Standard", "1080p")).toBe(180_000);
    expect(fallbackEtaMs("Standard", "4K")).toBe(270_000);
    expect(fallbackEtaMs("Lite", "720p")).toBe(90_000);
  });
});
