import { z } from "zod";

// ---------- shared primitives ----------
export const generationModeSchema = z.enum(["t2v", "i2v", "frames", "r2v", "extend"]);
export const videoStatusSchema = z.enum(["pending", "success", "failed"]);
export const studioTabSchema = z.enum(["generate", "library", "elements", "settings"]);
export const elementCatSchema = z.enum(["characters", "locations", "assets", "frames"]);

export const genDraftSchema = z.object({
  mode: generationModeSchema,
  model: z.string().min(1),
  res: z.enum(["720p", "1080p", "4K"]),
  aspect: z.enum(["16:9", "9:16"]),
  dur: z.number().int().min(1).max(30),
  audio: z.boolean(),
  batch: z.number().int().min(1).max(4),
  seed: z.union([z.string(), z.number()]),
  person: z.enum(["allow_adult", "disallow"]),
  enhance: z.boolean(),
  negativePrompt: z.string().max(2000).default(""),
  prompt: z.string().max(5000),
  image: z.string().max(2000000),
  first: z.string().max(2000000),
  last: z.string().max(2000000),
  refs: z.array(z.string()).max(3),
  extendVideo: z.string(),
});

export const videoInputsSchema = z.object({
  image: z.string().optional(),
  first: z.string().optional(),
  last: z.string().optional(),
  refs: z.array(z.string()).optional(),
  extendVideo: z.string().optional(),
});

export const youtubeStateSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  privacy: z.string().optional(),
  videoId: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  uploadStatus: z.string().optional(),
  processingStatus: z.string().optional(),
  timeLeftMs: z.number().optional(),
  fail: z.string().optional(),
  views: z.number().nullable().optional(),
  likes: z.number().nullable().optional(),
  comments: z.number().nullable().optional(),
  pct: z.number().optional(),
  publishedAt: z.number().optional(),
  checkedAt: z.number().optional(),
});

export const videoItemSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().optional(),
  elapsedMs: z.number().optional(),
  etaMs: z.number().optional(),
  etaSource: z.enum(["measured", "estimated"]).optional(),
  mode: generationModeSchema,
  prompt: z.string(),
  model: z.string(),
  res: z.string(),
  aspect: z.string(),
  dur: z.number(),
  audio: z.boolean(),
  seed: z.union([z.string(), z.number()]),
  person: z.string(),
  enhance: z.boolean(),
  batch: z.number(),
  status: videoStatusSchema,
  progress: z.number(),
  cost: z.number(),
  createdAt: z.number(),
  thumb: z.string(),
  url: z.string(),
  imported: z.boolean().optional(),
  error: z.string(),
  inputs: videoInputsSchema,
  youtube: youtubeStateSchema.optional(),
  negativePrompt: z.string().optional(),
});

export const elementItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  img: z.string().min(1),
  note: z.string().max(200),
});

export const projectSettingsSchema = z.object({
  saJson: z.string(),
  bucket: z.string(),
  useBucket: z.boolean().default(true),
  authMode: z.enum(["service_account", "env"]).default("service_account"),
  ytClientId: z.string(),
  ytPrivacy: z.enum(["private", "unlisted", "public"]),
  ytCategory: z.string(),
});

export const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  createdAt: z.number(),
  gen: genDraftSchema,
  library: z.array(videoItemSchema),
  elements: z.object({
    characters: z.array(elementItemSchema),
    locations: z.array(elementItemSchema),
    assets: z.array(elementItemSchema),
    frames: z.array(elementItemSchema),
  }),
  settings: projectSettingsSchema,
});

// ---------- URL / query schemas (deep linking) ----------
export const projectIdSchema = z.string().min(1).max(64);

export const libraryQuerySchema = z.object({
  status: z.enum(["all", "pending", "success", "failed"]).default("all"),
  model: z.string().default("all"),
  res: z.string().default("all"),
  aspect: z.string().default("all"),
  dur: z.string().default("all"),
  audio: z.enum(["all", "on", "off"]).default("all"),
});

export const elementsQuerySchema = z.object({
  cat: elementCatSchema.default("characters"),
});

export const generateQuerySchema = z.object({
  mode: generationModeSchema.optional(),
  model: z.string().optional(),
  video: z.string().optional(),
  youtube: z.string().optional(),
  picker: z.enum(["image", "first", "last", "ref", "video"]).optional(),
  refIndex: z.coerce.number().int().min(0).max(2).optional(),
  advanced: z.enum(["0", "1"]).optional(),
});

export const projectNameSchema = z.string().trim().min(1, "Name is required").max(60);
export const elementFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  img: z.string().min(1, "Image is required"),
  note: z.string().max(200).default(""),
});
export const advancedFormSchema = z.object({
  seed: z.union([z.string(), z.number()]),
  person: z.enum(["allow_adult", "disallow"]),
  negativePrompt: z.string().max(2000).default(""),
});
export const ytPublishSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(100),
  description: z.string().max(5000).default(""),
  privacy: z.enum(["private", "unlisted", "public"]),
});

export type GenDraft = z.infer<typeof genDraftSchema>;
export type VideoItem = z.infer<typeof videoItemSchema>;
export type ElementItem = z.infer<typeof elementItemSchema>;
export type ElementCat = z.infer<typeof elementCatSchema>;
export type StudioTab = z.infer<typeof studioTabSchema>;
export type GenerationMode = z.infer<typeof generationModeSchema>;
export type Project = z.infer<typeof projectSchema>;
export type LibraryQuery = z.infer<typeof libraryQuerySchema>;
