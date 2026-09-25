import { z } from "zod";
import {
  EXTEND_SECONDS,
  EXTEND_TOTAL_CAP,
  getModel,
  type Aspect,
  type GenerationMode,
  type Resolution,
} from "./capabilities.ts";

export const jobInputSchema = z.object({
  projectId: z.string().min(1),
  mode: z.enum(["t2v", "i2v", "f2v", "r2v", "extend"]),
  model: z.string().min(1),
  prompt: z.string().min(1).max(4000),
  resolution: z.enum(["720p", "1080p", "4K"]),
  aspect: z.enum(["16:9", "9:16"]),
  durationSeconds: z.number().int().min(1).max(60),
  audio: z.boolean().default(true),
  sampleCount: z.number().int().min(1).max(4).default(1),
  seed: z.number().int().min(0).max(4294967295).optional(),
  person: z.enum(["allow_adult", "disallow"]).optional(),
  negativePrompt: z.string().max(2000).optional(),
  imageAssetId: z.string().optional(),
  firstFrameAssetId: z.string().optional(),
  lastFrameAssetId: z.string().optional(),
  refAssetIds: z.array(z.string()).max(3).default([]),
  sourceVideoId: z.string().optional(),
  sourceVideoGcsUri: z.string().regex(/^gs:\/\/[^/]+\/.+/, "must be a gs://bucket/object URI").optional(),
  // Inline source bytes: schema-legal per the GenAI SDK Video type, but Base64
  // inflates ~33% — capped at 20 MB like input images. Prefer GCS for real clips.
  sourceVideoBytes: z.string().max(28_000_000).optional(),
  sourceVideoMimeType: z.string().max(100).optional(),
  sourceDurationSeconds: z.number().optional(),
  sourceResolution: z.string().optional(),
  sourceAspect: z.string().optional(),
  webhookUrl: z.string().url().optional(),
});

export type JobInput = z.infer<typeof jobInputSchema>;

export type ValidationError = { code: string; message: string };

export function validateJob(input: JobInput): ValidationError | null {
  const model = getModel(input.model);
  if (!model) return { code: "UNKNOWN_MODEL", message: `Unknown model ${input.model}` };

  const mode = input.mode as GenerationMode;
  if (!(model.modes as readonly string[]).includes(mode)) {
    return { code: "MODE_UNSUPPORTED", message: `${model.id} does not support mode ${mode}` };
  }
  if (!(model.resolutions as readonly string[]).includes(input.resolution)) {
    return {
      code: "RESOLUTION_UNSUPPORTED",
      message: `${model.id} does not support ${input.resolution}`,
    };
  }
  if (!(model.aspects as readonly string[]).includes(input.aspect)) {
    return { code: "ASPECT_UNSUPPORTED", message: `${model.id} does not support ${input.aspect}` };
  }

  if (mode === "extend" && input.durationSeconds !== EXTEND_SECONDS) {
    return {
      code: "EXTEND_DURATION_FIXED",
      message: `extend always generates exactly ${EXTEND_SECONDS}s`,
    };
  }
  if (mode !== "extend") {
    const allowed: number[] =
      mode === "r2v" && model.r2vDurations.length > 0
        ? [...model.r2vDurations]
        : [...model.durations];
    if (!allowed.includes(input.durationSeconds)) {
      return {
        code: "DURATION_UNSUPPORTED",
        message: `${model.id}/${mode} allows durations [${allowed.join(",")}], got ${input.durationSeconds}`,
      };
    }
    // 1080p/4K support 8s only (Vertex rejects shorter high-res renders).
    if (input.resolution !== "720p" && input.durationSeconds !== 8) {
      return {
        code: "DURATION_UNSUPPORTED",
        message: `${input.resolution} supports only 8s duration, got ${input.durationSeconds}s`,
      };
    }
  }

  if (input.audio && !model.audio) {
    return { code: "AUDIO_UNSUPPORTED", message: `${model.id} is silent-only` };
  }
  if (input.sampleCount > model.maxOutputs) {
    return {
      code: "SAMPLE_COUNT_EXCEEDED",
      message: `${model.id} allows max ${model.maxOutputs} outputs per prompt`,
    };
  }

  // Mode-specific input requirements
  // Slots are mutually exclusive (one slot per request): image | first+last |
  // references | video. Stale fields from another mode are rejected, not ignored.
  const hasImage = !!input.imageAssetId;
  const hasFrames = !!input.firstFrameAssetId || !!input.lastFrameAssetId;
  const hasRefs = input.refAssetIds.length > 0;
  const hasVideo =
    !!input.sourceVideoId || !!input.sourceVideoGcsUri || !!input.sourceVideoBytes;
  const mixed = (allowed: string, offenders: string[]) => ({
    code: "MIXED_INPUTS",
    message: `${mode} accepts only ${allowed} — remove ${offenders.join(", ")}`,
  });
  if (mode === "t2v" && (hasImage || hasFrames || hasRefs || hasVideo)) {
    const o = [
      hasImage && "imageAssetId",
      hasFrames && "frame asset(s)",
      hasRefs && "refAssetIds",
      hasVideo && "video source",
    ].filter(Boolean) as string[];
    return mixed("a prompt", o);
  }
  if (mode === "i2v" && (hasFrames || hasRefs || hasVideo)) {
    const o = [
      hasFrames && "frame asset(s)",
      hasRefs && "refAssetIds",
      hasVideo && "video source",
    ].filter(Boolean) as string[];
    return mixed("one imageAssetId", o);
  }
  if (mode === "f2v" && (hasImage || hasRefs || hasVideo)) {
    const o = [
      hasImage && "imageAssetId",
      hasRefs && "refAssetIds",
      hasVideo && "video source",
    ].filter(Boolean) as string[];
    return mixed("firstFrameAssetId + lastFrameAssetId", o);
  }
  if (mode === "r2v" && (hasImage || hasFrames || hasVideo)) {
    const o = [
      hasImage && "imageAssetId",
      hasFrames && "frame asset(s)",
      hasVideo && "video source",
    ].filter(Boolean) as string[];
    return mixed("refAssetIds (1–3)", o);
  }
  if (mode === "extend" && (hasImage || hasFrames || hasRefs)) {
    const o = [
      hasImage && "imageAssetId",
      hasFrames && "frame asset(s)",
      hasRefs && "refAssetIds",
    ].filter(Boolean) as string[];
    return mixed("a video source", o);
  }
  if (mode === "i2v" && !input.imageAssetId) {
    return { code: "IMAGE_REQUIRED", message: "i2v requires imageAssetId" };
  }
  if (mode === "f2v" && (!input.firstFrameAssetId || !input.lastFrameAssetId)) {
    return {
      code: "FRAMES_REQUIRED",
      message: "f2v requires firstFrameAssetId and lastFrameAssetId",
    };
  }
  if (mode === "r2v") {
    if (model.maxRefs === 0 || input.refAssetIds.length === 0) {
      return { code: "REFS_REQUIRED", message: "r2v requires 1–3 refAssetIds" };
    }
    if (input.refAssetIds.length > model.maxRefs) {
      return { code: "REFS_EXCEEDED", message: `max ${model.maxRefs} reference images` };
    }
  }
  if (mode === "extend") {
    if (!input.sourceVideoId) {
      return { code: "SOURCE_REQUIRED", message: "extend requires sourceVideoId" };
    }
    if (input.sourceResolution && input.sourceResolution !== input.resolution) {
      return {
        code: "EXTEND_RESOLUTION_MISMATCH",
        message: `extend must keep source resolution (${input.sourceResolution}); cannot switch to ${input.resolution}`,
      };
    }
    if (input.sourceAspect && input.sourceAspect !== input.aspect) {
      return {
        code: "EXTEND_ASPECT_MISMATCH",
        message: `extend must keep source aspect (${input.sourceAspect}); cannot switch to ${input.aspect}`,
      };
    }
    if (
      typeof input.sourceDurationSeconds === "number" &&
      input.sourceDurationSeconds + EXTEND_SECONDS > EXTEND_TOTAL_CAP
    ) {
      return {
        code: "EXTEND_CAP_EXCEEDED",
        message: `extend would reach ${input.sourceDurationSeconds + EXTEND_SECONDS}s, cap is ${EXTEND_TOTAL_CAP}s total`,
      };
    }
  }
  return null;
}

export function zodDetails(e: z.ZodError) {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export type { Resolution, Aspect };
