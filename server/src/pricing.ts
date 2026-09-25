// Official per-second rates. Source: KNOWLEDGE.md §6
// (Vertex pricing page; rows are per output second).

import type { Resolution, Tier } from "./capabilities.ts";

type Rate = { audio: number | null; silent: number | null };

const TABLE: Record<Tier, Partial<Record<Resolution, Rate>>> = {
  Standard: {
    "720p": { audio: 0.4, silent: 0.2 },
    "1080p": { audio: 0.4, silent: 0.2 },
    "4K": { audio: 0.6, silent: 0.4 },
  },
  Fast: {
    "720p": { audio: 0.1, silent: 0.08 },
    "1080p": { audio: 0.12, silent: 0.1 },
    "4K": { audio: 0.3, silent: 0.25 },
  },
  Lite: {
    "720p": { audio: 0.05, silent: 0.03 },
    "1080p": { audio: 0.08, silent: 0.05 },
  },
  Legacy: {
    "720p": { audio: null, silent: 0.5 },
  },
};

export function ratePerSecond(
  tier: Tier,
  modelId: string,
  resolution: Resolution,
  audio: boolean,
): number {
  // Veo 3 Standard/Fast have no 4K tier — matrix already prevents it,
  // but guard anyway.
  const row = TABLE[tier]?.[resolution];
  if (!row) throw new Error(`RATE_MISSING:${tier}/${resolution}`);
  if (modelId === "veo-2.0-generate-001") {
    if (audio) throw new Error("AUDIO_UNSUPPORTED:veo-2.0-generate-001 is silent-only");
    return row.silent!;
  }
  const rate = audio ? row.audio : row.silent;
  if (rate == null) throw new Error(`RATE_MISSING:${tier}/${resolution}/audio=${audio}`);
  return rate;
}

export function estimateCost(params: {
  tier: Tier;
  modelId: string;
  resolution: Resolution;
  audio: boolean;
  durationSeconds: number;
  sampleCount?: number;
}): number {
  const count = params.sampleCount ?? 1;
  const rate = ratePerSecond(params.tier, params.modelId, params.resolution, params.audio);
  return round2(rate * params.durationSeconds * count);
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function pricingTable() {
  return JSON.parse(JSON.stringify(TABLE)) as typeof TABLE;
}
