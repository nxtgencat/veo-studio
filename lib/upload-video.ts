// Shared video upload: thumb/meta capture runs alongside the server upload,
// then the library record is imported. Callers keep their own toasts and
// navigation — this returns everything they need to decide those.
"use client";

import { api, errOf } from "@/lib/api";
import { captureVideo } from "@/lib/media";

export interface VideoImport {
  prompt: string;
  res: string;
  aspect: string;
  dur: number;
  thumbDataUrl: string;
  mediaId?: string;
}

export interface UploadedVideo {
  ok: boolean;
  id?: string;
  /** Duration from the local container probe (drives extend messaging). */
  dur: number;
  /** False when the bytes never reached the server (record-only import). */
  stored: boolean;
  /** Upload failure text (for the record-only warning). */
  uploadDetail: string;
  error?: string;
}

export async function uploadVideoFile(
  file: File,
  importFn: (a: VideoImport) => Promise<{ ok: boolean; error?: string; id?: string }>,
  signal?: AbortSignal,
  onProgress?: (frac: number) => void,
): Promise<UploadedVideo> {
  // Thumb/meta locally, bytes to the server store — the library record
  // then plays and extends from the server, surviving reloads.
  let uploadDetail = "";
  const [{ thumb, meta }, uploaded] = await Promise.all([
    captureVideo(file),
    api.uploadMedia(file, signal, onProgress).catch((e) => {
      if (!signal?.aborted) uploadDetail = errOf(e, 120);
      return null;
    }),
  ]);
  if (signal?.aborted) return { ok: false, dur: meta.dur, stored: false, uploadDetail: "", error: "cancelled" };
  const r = await importFn({
    prompt: (file.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Uploaded video",
    res: meta.res,
    aspect: meta.aspect,
    dur: meta.dur,
    thumbDataUrl: thumb,
    ...(uploaded ? { mediaId: uploaded.id } : {}),
  });
  if (!r.ok || !r.id) {
    return { ok: false, dur: meta.dur, stored: !!uploaded, uploadDetail, error: r.error ?? "Import failed" };
  }
  return { ok: true, id: r.id, dur: meta.dur, stored: !!uploaded, uploadDetail };
}
