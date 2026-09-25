"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Clock, Film, Play, RotateCcw, SearchX, Sparkles, Upload, X } from "lucide-react";
import { money } from "@/lib/format";
import { ago, fullTs } from "@/lib/format";
import { modelOf } from "@/lib/pricing";
import { captureVideo, fileToBase64 } from "@/lib/media";
import { useStudio } from "@/stores/use-studio";
import { useToasts } from "@/stores/use-ui";
import { useQueryState } from "@/hooks/use-studio-hooks";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton } from "@/components/slate/button";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";
import { PageHead, SlateEmpty, SlateProgress, SlateSegmented } from "@/components/slate/core";
import { ModeBadge, StatusBadge } from "@/components/studio/shared";
import type { VideoItem } from "@/lib/schemas";

export function LibraryView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const project = useStudio((s) => s.projects.find((x) => x.id === projectId));
  const importVideo = useStudio((s) => s.importVideo);
  const push = useToasts((s) => s.push);
  const { state, set, clear } = useQueryState({ status: "all", model: "all", res: "all", aspect: "all", dur: "all", audio: "all" });
  const [busy, setBusy] = useState(false);

  const models = useMemo(() => [...new Set((project?.library ?? []).map((v) => v.model))], [project?.library]);
  const reses = useMemo(() => [...new Set((project?.library ?? []).map((v) => v.res))], [project?.library]);
  const aspects = useMemo(() => [...new Set((project?.library ?? []).map((v) => v.aspect))], [project?.library]);
  const durs = useMemo(() => [...new Set((project?.library ?? []).map((v) => v.dur))].sort((a, b) => a - b), [project?.library]);

  if (!project) return null;
  const mLabel = (id: string) => (id === "import" ? "Upload" : modelOf(id).label);
  const list = project.library.filter(
    (v) =>
      (state.status === "all" ? true : v.status === state.status) &&
      (state.model === "all" ? true : v.model === state.model) &&
      (state.res === "all" ? true : v.res === state.res) &&
      (state.aspect === "all" ? true : v.aspect === state.aspect) &&
      (state.dur === "all" ? true : String(v.dur) === state.dur) &&
      (state.audio === "all" ? true : state.audio === "on" ? !!v.audio : !v.audio),
  );
  const nActive = [state.model, state.res, state.aspect, state.dur, state.audio].filter((x) => x !== "all").length;

  const onUpload = async (file: File) => {
    setBusy(true);
    push("Importing video…", { icon: "↑" });
    try {
      const { url, thumb, meta } = await captureVideo(file);
      const raw = await fileToBase64(file).catch(() => null);
      const r = await importVideo({
        prompt: (file.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Uploaded video",
        res: meta.res,
        aspect: meta.aspect,
        dur: meta.dur,
        thumbDataUrl: thumb,
        blobUrl: url,
        ...(raw ? { sourceBytes: raw.bytes, sourceMime: raw.mime } : {}),
      });
      if (!r.ok) push(r.error ?? "Import failed", { icon: "!", tone: "danger" });
      else push("Video imported to Library", { icon: "✓" });
    } catch {
      push("Could not read that video", { icon: "!", tone: "danger" });
    } finally {
      setBusy(false);
    }
  };

  const facet = (label: string, raw: string, disp: string, key: "model" | "res" | "aspect" | "dur" | "audio", opts: [string, string][]) => (
    <SlateDropdown
      key={label}
      label={`${label}: ${disp}`}
      menu={(close) => (
        <>
          <SlateOption active={raw === "all"} onPick={() => set({ [key]: "all" } as Record<string, string>)} onClose={close}>
            All
          </SlateOption>
          {opts.map(([id, l]) => (
            <SlateOption key={id} active={raw === id} onPick={() => set({ [key]: id } as Record<string, string>)} onClose={close}>
              {l}
            </SlateOption>
          ))}
        </>
      )}
    />
  );

  return (
    <>
      <PageHead
        title="Library"
        sub={`Every render in ${project.name}. Click a card for player, config, inputs and cost.`}
        actions={
          <label className="slate-btn slate-btn-primary slate-btn-sm cursor-pointer">
            <Upload className="size-3.5" /> {busy ? "Importing…" : "Upload video"}
            <input
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUpload(f);
                e.target.value = "";
              }}
            />
          </label>
        }
      />

      <SlateSegmented
        label="Filter by status"
        className="mb-4 capitalize"
        options={(["all", "pending", "success", "failed"] as const).map((k) => ({ id: k, label: k }))}
        value={state.status as "all" | "pending" | "success" | "failed"}
        onChange={(v) => set({ status: v })}
      />

      {project.library.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {facet("Model", state.model, state.model === "all" ? "All" : mLabel(state.model), "model", models.map((id) => [id, mLabel(id)] as [string, string]))}
          {facet("Res", state.res, state.res === "all" ? "All" : state.res, "res", reses.map((r) => [r, r] as [string, string]))}
          {facet("Aspect", state.aspect, state.aspect === "all" ? "All" : state.aspect, "aspect", aspects.map((a) => [a, a] as [string, string]))}
          {facet("Dur", state.dur, state.dur === "all" ? "All" : `${state.dur}s`, "dur", durs.map((d) => [String(d), `${d}s`] as [string, string]))}
          {facet("Audio", state.audio, state.audio === "all" ? "All" : state.audio === "on" ? "On" : "Off", "audio", [["on", "On"], ["off", "Off"]])}
          {nActive > 0 && (
            <button
              type="button"
              onClick={() => clear()}
              className="h-[30px] px-2.5 rounded-[8px] text-[12px] font-bold text-[#C9432E] hover:bg-surface2 inline-flex items-center gap-1"
            >
              <X className="size-3.5" /> Clear · {nActive}
            </button>
          )}
          <span className="ml-auto text-[11.5px] text-muted tabular-nums font-mono">
            {list.length} of {project.library.length}
          </span>
        </div>
      )}

      {!list.length ? (
        !project.library.length ? (
          <SlateEmpty
            icon={<Film className="size-6 text-[#1C7247]" />}
            title="No videos here yet"
            sub="Generate your first clip — it will land here with its full config, inputs and cost."
            action={
              <Link href={`/p/${projectId}/generate`} className="no-underline">
                <SlateButton variant="primary"><Sparkles className="size-3.5" /> Generate a video</SlateButton>
              </Link>
            }
          />
        ) : (
          <SlateEmpty
            icon={<SearchX className="size-6 text-[#1C7247]" />}
            title="No matches"
            sub="No videos fit this filter combination — loosen a filter."
            action={
              <SlateButton variant="ghost" onClick={() => clear()}>
                <RotateCcw className="size-3.5" /> Clear filters
              </SlateButton>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-2 xl:grid-cols-3 gap-2.5 sm:gap-3">
          {list.map((v) => (
            <Link
              key={v.id}
              href={`/p/${projectId}/library?status=${state.status}&video=${v.id}`}
              className="slate-card overflow-hidden cursor-pointer hover:border-[#3FA96D] no-underline text-inherit"
            >
              <div className="relative aspect-video bg-surface2">
                {v.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumb} className="absolute inset-0 w-full h-full object-cover" alt="" loading="lazy" />
                ) : null}
                {v.status === "success" && (
                  <span className="absolute inset-0 m-auto w-9 h-9 sm:w-11 sm:h-11 rounded-full bg-black/55 grid place-items-center">
                    <Play className="size-4 sm:size-5 text-white ml-0.5" />
                  </span>
                )}
                {v.status === "pending" && (
                  <div className="absolute inset-0 bg-black/45 p-2.5 sm:p-4 flex flex-col justify-end gap-1.5">
                    <SlateProgress value={v.progress || 5} />
                    <p className="text-white text-[10.5px] sm:text-[11px] font-bold tabular-nums">{v.progress || 5}% rendering…</p>
                  </div>
                )}
                <span className="absolute top-1.5 left-1.5 sm:top-2 sm:left-2 hidden min-[420px]:inline-flex">
                  <ModeBadge mode={v.mode} />
                </span>
                <SlateBadge tone="draft" className="absolute top-1.5 right-1.5 sm:top-2 sm:right-2 tabular-nums">
                  {v.dur}s · {v.res}
                </SlateBadge>
                {v.status !== "pending" && (
                  <SlateBadge tone="draft" className="absolute bottom-1.5 left-1.5 !h-[20px] !text-[10.5px] tabular-nums" title={fullTs(v.createdAt)}>
                    <Clock className="size-3" /> {ago(v.createdAt)}
                  </SlateBadge>
                )}
              </div>
              <div className="p-2 sm:p-3">
                <p className="text-[12px] sm:text-[13px] font-semibold leading-snug line-clamp-2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {v.prompt || "Untitled"}
                </p>
                <div className="mt-1.5 sm:mt-2 flex items-center justify-between gap-2">
                  <StatusBadge status={v.status} />
                  <span className="text-[11px] sm:text-[12px] font-mono text-fg2">
                    {v.status === "success" ? money(v.cost) : "$0.00"}
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
