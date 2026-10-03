// Pure server-row → UI mapping. No store imports — derivation happens at
// read time inside memoized hooks, so there is nothing to rebuild or diff.
import { apiBase } from "@/lib/api";
import type { ServerElement, ServerJob, ServerVideo } from "@/lib/api";
import type { ElementItem, Project, VideoItem } from "@/lib/schemas";

const toWebMode = (m: string): VideoItem["mode"] => (m === "f2v" ? "frames" : (m as VideoItem["mode"]));

function elementImg(elements: ServerElement[], id: string | undefined): string {
  if (!id) return "";
  return elements.find((e) => e.id === id)?.image_url ?? "";
}

interface RawInputs {
  imageAssetId?: string;
  firstFrameAssetId?: string;
  lastFrameAssetId?: string;
  refAssetIds?: string[];
  sourceVideoId?: string;
  enhancePrompt?: boolean;
}

export function parseRawInputs(json: string): RawInputs {
  try {
    return JSON.parse(json || "{}") as RawInputs;
  } catch {
    return {};
  }
}

function mapInputs(raw: RawInputs, elements: ServerElement[]): VideoItem["inputs"] {
  const inputs: VideoItem["inputs"] = {
    image: elementImg(elements, raw.imageAssetId) || undefined,
    first: elementImg(elements, raw.firstFrameAssetId) || undefined,
    last: elementImg(elements, raw.lastFrameAssetId) || undefined,
    refs: (raw.refAssetIds ?? []).map((id) => elementImg(elements, id)).filter(Boolean),
    extendVideo: raw.sourceVideoId,
  };
  if (!inputs.refs?.length) delete inputs.refs;
  return inputs;
}

export type YoutubeRec = Record<string, NonNullable<VideoItem["youtube"]>>;

export function toVideoItem(
  v: ServerVideo,
  elements: ServerElement[],
  youtube: YoutubeRec,
): VideoItem {
  const raw = parseRawInputs(v.inputs_json);
  const inputs: VideoItem["inputs"] = mapInputs(raw, elements);
  return {
    id: v.id,
    jobId: v.job_id,
    mode: toWebMode(v.mode),
    prompt: v.prompt,
    model: v.model,
    res: v.resolution,
    aspect: v.aspect,
    dur: v.duration_seconds,
    durActual: v.actual_duration_seconds ?? null,
    size: v.bytes ?? null,
    audio: !!v.audio,
    seed: "",
    person: v.person === "dont_allow" ? "dont_allow" : "allow_adult",
    enhance: raw.enhancePrompt ?? true,
    batch: 1,
    status: "success",
    progress: 100,
    cost: v.cost_estimate ?? 0,
    createdAt: Date.parse(v.created_at) || Date.now(),
    thumb: v.thumb_url || "",
    // Playable only when the server hosts the bytes (/media/…) or the URL is
    // direct http(s). gs:// URIs and empty strings are not browser-playable.
    url: v.video_url.startsWith("/media/")
      ? `${apiBase()}${v.video_url}`
      : v.video_url.startsWith("http")
        ? v.video_url
        : "",
    imported: v.model === "import" ? true : undefined,
    error: "",
    inputs,
    youtube: youtube[v.id],
    negativePrompt: v.negative_prompt || undefined,
  };
}

export function jobToVideoItem(
  j: ServerJob,
  elements: ServerElement[],
): VideoItem {
  const raw = parseRawInputs(j.inputsJson ?? "{}");
  const inputs = mapInputs(raw, elements);
  return {
    id: j.id,
    jobId: j.id,
    mode: toWebMode(j.mode),
    prompt: j.prompt,
    model: j.model,
    res: j.resolution,
    aspect: j.aspect,
    dur: j.durationSeconds,
    durActual: undefined,
    size: undefined,
    audio: j.audio,
    seed: typeof j.seed === "number" ? j.seed : "",
    person: j.person === "dont_allow" ? "dont_allow" : "allow_adult",
    enhance: raw.enhancePrompt ?? true,
    batch: 1,
    negativePrompt: j.negativePrompt || undefined,
    elapsedMs: j.elapsedMs ?? 0,
    etaMs: j.etaMs,
    etaSource: j.etaSource,
    status: j.status === "failed" ? "failed" : j.status === "cancelled" ? "failed" : "pending",
    progress: j.status === "failed" || j.status === "cancelled" ? 100 : j.progress || 5,
    cost: j.status === "succeeded" ? j.costEstimate : j.status === "failed" || j.status === "cancelled" ? 0 : j.costEstimate,
    createdAt: Date.parse(j.createdAt) || Date.now(),
    thumb: "",
    url: "",
    error: j.status === "cancelled" ? "Cancelled before completion — not billed." : j.error || "",
    inputs,
    youtube: undefined,
  };
}

/** Derived library for one project: successes + live/failed job rows, newest first. */
export function buildLibrary(
  projectId: string,
  videos: ServerVideo[],
  jobs: ServerJob[],
  elements: ServerElement[],
  youtube: YoutubeRec,
): VideoItem[] {
  const els = elements.filter((e) => e.project_id === projectId);
  return [
    ...videos
      .filter((v) => v.project_id === projectId)
      .map((v) => toVideoItem(v, els, youtube)),
    ...jobs
      .filter((j) =>
        j.projectId === projectId &&
        (j.status === "queued" || j.status === "running" || j.status === "failed" || j.status === "cancelled"),
      )
      .map((j) => jobToVideoItem(j, els)),
  ].sort((a, b) => b.createdAt - a.createdAt);
}

/** Derived grouped elements for one project. */
export function groupElements(projectId: string, elements: ServerElement[]): Project["elements"] {
  const grouped: Project["elements"] = { characters: [], locations: [], assets: [], frames: [] };
  for (const e of elements) {
    if (e.project_id !== projectId) continue;
    const item: ElementItem = { id: e.id, name: e.name, img: e.image_url, note: e.note };
    if (e.category === "characters" || e.category === "locations" || e.category === "assets" || e.category === "frames") {
      grouped[e.category].push(item);
    }
  }
  return grouped;
}
