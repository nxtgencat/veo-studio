"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Calendar, Check, CircleX, MonitorPlay, RefreshCw, RotateCcw, SkipBack, SkipForward, StretchHorizontal,
  Trash2,
} from "lucide-react";
import { EL_CATS, YT_PRIVS } from "@/lib/catalog";
import { ago, expectedDur, fmtBytes, fmtCountdown, fmtDurPair, fmtElapsed, fullTs, money } from "@/lib/format";
import { modelOf } from "@/lib/pricing";
import { captureAt, captureVideo, fileToImage, INLINE_VIDEO_MAX } from "@/lib/media";
import { api, authedMediaUrl } from "@/lib/api";
import { ytConnect, ytUploadVideo, ytVideoState } from "@/lib/youtube";
import { advancedFormSchema, ytPublishSchema } from "@/lib/schemas";
import { useStudio } from "@/stores/use-studio";
import { useToasts, useYtAuth } from "@/stores/use-ui";
import { useQueryState } from "@/hooks/use-studio-hooks";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton, SlateCloseButton } from "@/components/slate/button";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";
import { SlateField, SlateLabel, SlateProgress, SlateSearchField, SlateTextarea, SlateUploadCard } from "@/components/slate/core";
import { SlateDialog, SlateModal, SlateModalHead } from "@/components/slate/overlays";
import { ModeBadge, StatusBadge } from "@/components/studio/shared";

/**
 * URL-driven dialogs — single place for every ?video= ?youtube= ?picker= ?advanced=
 * Deep-linkable, no prop drilling: any view mounts <StudioDialogs/> and dialogs follow the URL.
 * (Mode switching is an anchored dropdown in the composer, not a dialog.)
 */
export function StudioDialogs() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const project = useStudio((s) => s.projects.find((x) => x.id === projectId));
  const { state, set } = useQueryState({ video: "", youtube: "", picker: "", refIndex: "0", advanced: "", confirmDel: "" });
  const close = (patch: Record<string, string>) => set(patch);

  if (!project) return null;
  const video = state.video ? project.library.find((v) => v.id === state.video) : undefined;
  const ytVideo = state.youtube ? project.library.find((v) => v.id === state.youtube) : undefined;
  const delVideo = state.confirmDel ? project.library.find((v) => v.id === state.confirmDel) : undefined;

  return (
    <>
      {(state.picker === "image" || state.picker === "first" || state.picker === "last") && (
        <ImagePickerDialog slotKey={state.picker} close={() => close({ picker: "", refIndex: "" })} />
      )}
      {state.picker === "ref" && (
        <ImagePickerDialog slotKey="ref" refIndex={Number(state.refIndex || 0)} close={() => close({ picker: "", refIndex: "" })} />
      )}
      {state.picker === "video" && <VideoPickerDialog close={() => close({ picker: "" })} />}
      {state.advanced === "1" && <AdvancedDialog close={() => close({ advanced: "" })} />}
      {video && <VideoDetailDialog videoId={video.id} close={() => close({ video: "" })} />}
      {ytVideo && <YoutubeDialog videoId={ytVideo.id} close={() => close({ youtube: "" })} />}
      {delVideo && <DeleteVideoConfirm videoId={delVideo.id} close={() => close({ confirmDel: "" })} />}
    </>
  );
}

// ---------- image picker ----------
function ImagePickerDialog({ slotKey, refIndex, close }: { slotKey: string; refIndex?: number; close: () => void }) {
  const project = useStudio((s) => s.projects.find((x) => x.id === s.activeId) ?? s.projects[0]);
  const updateActive = useStudio((s) => s.updateActive);
  const addElement = useStudio((s) => s.addElement);
  const push = useToasts((s) => s.push);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  if (!project) return null;
  const ql = q.trim().toLowerCase();
  const total = EL_CATS.reduce((a, c) => a + ((project.elements[c.id as keyof typeof project.elements] || []).length), 0);
  const cats = EL_CATS.map((c) => ({
    ...c,
    items: (project.elements[c.id as keyof typeof project.elements] || []).filter(
      (el) => !ql || el.name.toLowerCase().includes(ql) || el.note.toLowerCase().includes(ql),
    ),
  })).filter((g) => g.items.length);

  const pick = (img: string) => {
    updateActive((d) => {
      if (slotKey === "ref") {
        const r = d.gen.refs.filter(Boolean);
        r[refIndex ?? 0] = img;
        d.gen.refs = r.slice(0, 3);
        d.gen.dur = 8;
      } else {
        (d.gen as Record<string, unknown>)[slotKey] = img;
      }
    });
    close();
  };

  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <span className="text-[14px] font-bold">Choose image</span>
          <SlateCloseButton onClick={close} />
        </>
      }
    >
      <SlateUploadCard
        className="mb-1"
        title="Upload new image"
        sub="JPG / PNG — auto-resized, saved to Elements"
        accept="image/*"
        busy={busy}
        onFile={(f) => {
          setBusy(true);
          fileToImage(f)
            .then(async (url) => {
              const r = await addElement(slotKey === "ref" ? "assets" : "frames", {
                name: (f.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "Upload",
                imageUrl: url,
                note: "Uploaded in picker",
              });
              if (!r.ok) push(r.error ?? "Could not save image", { icon: "!", tone: "danger" });
              else pick(url);
            })
            .catch(() => push("Could not read that image", { icon: "!", tone: "danger" }))
            .finally(() => setBusy(false));
        }}
      />
      {total > 0 && (
        <div className="mb-2">
          <SlateSearchField value={q} onChange={setQ} label="Search images by name" />
        </div>
      )}
      <div className="max-h-[46dvh] overflow-y-auto pr-0.5">
        {!cats.length && (
          <p className="text-[12.5px] text-muted slate-card p-4 text-center">
            {ql ? `No matches for “${q.trim()}”.` : "No images in Elements yet — upload one above."}
          </p>
        )}
        {cats.map((gc) => (
          <div key={gc.id}>
            <p className="text-[11px] font-bold uppercase tracking-[.08em] text-muted mt-3 mb-1.5">{gc.label}</p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {gc.items.map((el) => (
                <button key={el.id} type="button" onClick={() => pick(el.img)} className="slate-card overflow-hidden text-left hover:border-[#3FA96D] !p-0">
                  <span className="block aspect-square bg-surface2 relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={el.img} className="absolute inset-0 w-full h-full object-cover" alt={el.name} loading="lazy" />
                  </span>
                  <span className="block px-1.5 py-1 text-[11px] font-semibold truncate">{el.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SlateDialog>
  );
}

// ---------- video picker ----------
function VideoPickerDialog({ close }: { close: () => void }) {
  const project = useStudio((s) => s.projects.find((x) => x.id === s.activeId) ?? s.projects[0]);
  const updateActive = useStudio((s) => s.updateActive);
  const importVideo = useStudio((s) => s.importVideo);
  const push = useToasts((s) => s.push);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  if (!project) return null;
  const vids = project.library.filter((v) => v.status === "success" && v.url);
  const ql = q.trim().toLowerCase();
  const shown = vids.filter((v) => !ql || (v.prompt || "Untitled").toLowerCase().includes(ql));

  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <span className="text-[14px] font-bold">Choose source video</span>
          <SlateCloseButton onClick={close} />
        </>
      }
    >
      <SlateUploadCard
        className="mb-2"
        title="Upload a video"
        busyTitle="Importing…"
        sub="MP4 · added to Library, usable this session"
        accept="video/*"
        busy={busy}
        onFile={(f) => {
          setBusy(true);
          captureVideo(f)
            .then(async ({ thumb, meta }) => {
              const uploaded = await api.uploadMedia(f).catch(() => null);
              const r = await importVideo({
                prompt: (f.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Uploaded video",
                res: meta.res,
                aspect: meta.aspect,
                dur: meta.dur,
                thumbDataUrl: thumb,
                ...(uploaded ? { mediaId: uploaded.id } : {}),
              });
              if (!r.ok || !r.id) {
                push(r.error ?? "Import failed", { icon: "!", tone: "danger" });
                return;
              }
              updateActive((d) => { d.gen.extendVideo = r.id as string; });
              close();
              const tooBig = f.size > INLINE_VIDEO_MAX;
              push(
                meta.dur > 30
                  ? `Imported — but ${meta.dur}s is too long to extend (≤30s)`
                  : !uploaded
                    ? "Imported as record only (file not stored) — extend needs the file"
                    : tooBig
                      ? "Imported and selected — file is over 20MB, extend needs a GCS source for it"
                      : "Imported and selected as extend source",
                { icon: "✓" },
              );
            })
            .catch(() => push("Could not read that video", { icon: "!", tone: "danger" }))
            .finally(() => setBusy(false));
        }}
      />
      {vids.length > 0 && (
        <div className="mb-2">
          <SlateSearchField value={q} onChange={setQ} label="Search videos by name" />
        </div>
      )}
      {!vids.length ? (
        <p className="text-[12.5px] text-muted slate-card p-4 text-center">No successful videos yet — generate or upload one.</p>
      ) : !shown.length ? (
        <p className="text-[12.5px] text-muted slate-card p-4 text-center">No matches for “{q.trim()}”.</p>
      ) : (
        <div className="space-y-2 max-h-[46dvh] overflow-y-auto pr-0.5">
          {shown.map((v) => {
            const exp = expectedDur(v, (id) => project.library.find((x) => x.id === id));
            return (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                if (exp > 30) {
                  push(`That video is ${exp}s — Extend inputs must be ≤ 30s.`, { icon: "!", tone: "danger" });
                  return;
                }
                updateActive((d) => { d.gen.extendVideo = v.id; });
                close();
              }}
              className={`w-full text-left slate-card p-2 flex items-center gap-2.5 hover:border-[#3FA96D] ${project.gen.extendVideo === v.id ? "!border-[#3FA96D]" : ""}`}
            >
              <span className="w-24 aspect-video rounded-[7px] overflow-hidden border slate-hair shrink-0 bg-surface2 relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.thumb} className="absolute inset-0 w-full h-full object-cover" alt="" />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-semibold truncate">{(v.prompt || "Untitled").slice(0, 60)}</span>
                <span className="block text-[11px] font-mono text-muted mt-0.5">{fmtDurPair(exp, v.durActual)} · {v.res} · {v.aspect}{exp > 30 ? " · too long (≤30s)" : ""}</span>
              </span>
            </button>
            );
          })}
        </div>
      )}
    </SlateDialog>
  );
}

// ---------- advanced ----------
function AdvancedDialog({ close }: { close: () => void }) {
  const project = useStudio((s) => s.projects.find((x) => x.id === s.activeId) ?? s.projects[0]);
  const updateActive = useStudio((s) => s.updateActive);
  const push = useToasts((s) => s.push);
  const [seed, setSeed] = useState<string | number>(project?.gen.seed ?? "");
  const [person, setPerson] = useState<"allow_adult" | "disallow">(
    project?.gen.person === "disallow" ? "disallow" : "allow_adult",
  );
  const [negative, setNegative] = useState(project?.gen.negativePrompt ?? "");
  if (!project) return null;
  return (
    <SlateModal onClose={close}>
      <SlateModalHead title="Advanced settings" onClose={close} />
      <div className="space-y-4">
        <div>
          <SlateLabel>Seed <span className="text-muted font-normal">(blank = random, 0 – 4294967295)</span></SlateLabel>
          <SlateField className="font-mono" value={String(seed)} onChange={(e) => setSeed(e.target.value)} inputMode="numeric" placeholder="random" />
        </div>
        <div>
          <SlateLabel>Person generation</SlateLabel>
          <SlateDropdown
            label={person === "allow_adult" ? "Adults — allow" : "None — disallow"}
            btnClassName="slate-field w-full flex items-center gap-1 !text-[13px] font-semibold"
            menu={(c) => [
              ["allow_adult", "Adults — allow generation"],
              ["disallow", "None — no people or faces"],
            ].map(([v, l]) => (
              <SlateOption key={v} active={person === v} onPick={() => setPerson(v as "allow_adult" | "disallow")} onClose={c}>
                {l}
              </SlateOption>
            ))}
          />
        </div>
        <div>
          <SlateLabel>Negative prompt <span className="text-muted font-normal">(things to avoid)</span></SlateLabel>
          <SlateTextarea rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="e.g. blurry, watermark, extra limbs" />
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
          <SlateButton
            variant="primary"
            onClick={() => {
              const parsed = advancedFormSchema.safeParse({ seed, person, negativePrompt: negative });
              if (!parsed.success) {
                push("Invalid advanced settings", { icon: "!", tone: "danger" });
                return;
              }
              updateActive((d) => { d.gen.seed = parsed.data.seed; d.gen.person = parsed.data.person; d.gen.negativePrompt = parsed.data.negativePrompt; });
              push("Advanced settings saved", { icon: "✓" });
              close();
            }}
          >
            <Check className="size-3.5" /> Save
          </SlateButton>
        </div>
      </div>
    </SlateModal>
  );
}

// ---------- video detail ----------
function VideoDetailDialog({ videoId, close }: { videoId: string; close: () => void }) {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const project = useStudio((s) => s.projects.find((x) => x.id === params.projectId));
  const addElement = useStudio((s) => s.addElement);
  const loadIntoComposer = useStudio((s) => s.loadIntoComposer);
  const updateActive = useStudio((s) => s.updateActive);
  const push = useToasts((s) => s.push);
  const { set } = useQueryState({ video: "", youtube: "", confirmDel: "" });
  const v = project?.library.find((x) => x.id === videoId);
  if (!project || !v) return null;
  const m = modelOf(v.model);
  // Extend rows store the 7s chunk on old records but the TOTAL on new ones:
  // expectedDur resolves either way (8s -> 15s -> 22s chains).
  const srcVideo = v.mode === "extend" && v.inputs.extendVideo
    ? project.library.find((x) => x.id === v.inputs.extendVideo)
    : undefined;
  const displayDur = expectedDur(v, (id) => project.library.find((x) => x.id === id));
  const cfg: [string, string][] = [
    ["Model", (v.model === "import" ? "Upload" : m.label) + (m.retires && v.model !== "import" ? " · retires Jun 30" : "")],
    ["Resolution", v.res], ["Aspect", v.aspect], ["Duration", v.mode === "extend" ? `${fmtDurPair(displayDur, v.durActual)} (src ${srcVideo ? expectedDur(srcVideo, (id) => project.library.find((x) => x.id === id)) : "?"}s + 7s)` : fmtDurPair(v.dur, v.durActual)],
    ["Size", fmtBytes(v.size)],
    ["Audio", v.audio ? "On" : "Off"],
    ["Seed", v.seed === "" || v.seed == null ? "random" : String(v.seed)],
    ["Person", v.person === "disallow" ? "Disallow" : "Allow adults"],
    ["Enhance", v.enhance ? "On" : "Off"], ["Batch", String(v.batch || 1)],
  ];

  const grab = (which: string, t: number | null) => {
    if (!v.url) {
      push("No playable file stored for this video.", { icon: "!", tone: "danger" });
      return;
    }
    push(`Grabbing ${which.toLowerCase()}…`, { icon: "…" });
    captureAt(authedMediaUrl(v.url), t)
      .then(async (img) => {
        const r = await addElement("frames", {
          name: `${which} · ${(v.prompt || "video").slice(0, 28)}`,
          imageUrl: img,
          note: "Grabbed from library video",
        });
        push(r.ok ? `${which} saved to Elements` : (r.error ?? "Could not save frame"), { icon: r.ok ? "✓" : "!", tone: r.ok ? "ok" : "danger" });
      })
      .catch(() => {
        push("Live grab blocked by the browser — try playing the video first", { icon: "!", tone: "danger" });
      });
  };

  const extend = () => {
    if (displayDur > 30) {
      push(`That video is ${displayDur}s — Extend inputs must be ≤ 30s (cap 37s total).`, { icon: "!", tone: "danger" });
      return;
    }
    updateActive((d) => { d.gen.mode = "extend"; d.gen.extendVideo = v.id; });
    router.push(`/p/${project.id}/generate`);
    close();
  };

  const reload = () => {
    const r = loadIntoComposer(v.id);
    if (!r.ok) {
      push(r.error ?? "Cannot reload", { icon: "!", tone: "danger" });
      return;
    }
    close();
    router.push(`/p/${project.id}/generate`);
    if (r.missing?.length) {
      push("Config reloaded — some inputs are gone", {
        icon: "✦",
        tone: "danger",
        detail: r.missing.slice(0, 3).join(" · "),
      });
    } else {
      push("Config reloaded into composer", { icon: "✦", detail: "Review and hit Generate when ready" });
    }
  };

  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <ModeBadge mode={v.mode} />
          <StatusBadge status={v.status} />
          <SlateBadge tone="draft">{fmtDurPair(displayDur, v.durActual)} · {v.res} · {v.aspect}</SlateBadge>
          <SlateCloseButton onClick={close} />
        </>
      }
      footer={
        <div className="flex flex-wrap items-center gap-2 w-full">
          <span className="font-display font-bold text-[17px] tabular-nums mr-auto" title={v.status === "pending" ? "Expected cost — debited on success" : v.status === "failed" ? "Would-be cost — not billed" : undefined}>
            {v.status === "failed" ? <s>{money(v.cost)}</s> : `${money(v.cost)}${v.status === "pending" ? " est." : ""}`}
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2 max-w-full">
          {v.status === "success" && (
            <>
              <SlateDropdown
                label="Save frame"
                btnClassName="slate-btn slate-btn-ghost slate-btn-sm"
                menu={(c) => (
                  <>
                    <SlateOption onPick={() => grab("First frame", 0.1)} onClose={c}>
                      <span className="flex items-center gap-2">
                        <SkipBack className="size-3.5 text-fg2" /> First frame
                      </span>
                    </SlateOption>
                    <SlateOption onPick={() => grab("Last frame", null)} onClose={c}>
                      <span className="flex items-center gap-2">
                        <SkipForward className="size-3.5 text-fg2" /> Last frame
                      </span>
                    </SlateOption>
                  </>
                )}
              />
              <SlateButton variant="ghost" size="sm" onClick={() => set({ youtube: v.id })} title="Publish to YouTube">
                <MonitorPlay className="size-3.5" /> {v.youtube?.videoId ? "YouTube ✓" : "YouTube"}
              </SlateButton>
              <SlateButton variant="ghost" size="sm" onClick={extend}>
                <StretchHorizontal className="size-3.5" /> Extend
              </SlateButton>
            </>
          )}
          {v.status !== "pending" && (
            <SlateButton variant="ghost" size="sm" onClick={reload} title="Load this exact config back into the composer (no submit)">
              <RotateCcw className="size-3.5" /> Reload
            </SlateButton>
          )}
          {v.status === "pending" ? (
            <SlateButton variant="ghost" size="sm" onClick={() => set({ confirmDel: v.id })} title="Stop polling and cancel this render (no output = no charge)">
              <CircleX className="size-3.5" /> Cancel
            </SlateButton>
          ) : v.status === "failed" ? (
            <SlateButton variant="ghost" size="sm" onClick={() => set({ confirmDel: v.id })} title="Dismiss this failed record (nothing was billed)">
              <Trash2 className="size-3.5" /> Dismiss
            </SlateButton>
          ) : (
            <SlateButton variant="ghost" size="sm" onClick={() => set({ confirmDel: v.id })} title="Delete this video">
              <Trash2 className="size-3.5" /> Delete
            </SlateButton>
          )}
          </div>
        </div>
      }
    >
      {v.status === "success" && v.url ? (
        <div className="rounded-[10px] border slate-hair bg-black overflow-hidden grid place-items-center">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video className="max-h-[46dvh] max-w-full mx-auto" controls playsInline poster={v.thumb || ""} src={authedMediaUrl(v.url)} />
        </div>
      ) : v.status === "success" ? (
        <div className="rounded-[10px] border slate-hair p-4 text-[12.5px] leading-relaxed" style={{ background: "var(--t-pending-bg)", color: "var(--t-pending-fg)" }}>
          <p className="font-bold mb-1">No playable file stored.</p>
          <p>This record kept metadata only — {v.model === "import" ? "the upload did not reach the server" : "the output was not archived"}. Re-upload or regenerate to play or extend.</p>
        </div>
      ) : v.status === "pending" ? (
        <div className="rounded-[10px] border slate-hair p-5 text-center">
          <SlateProgress value={v.progress || 5} />
          <p className="text-[12.5px] font-bold tabular-nums mt-2" title={v.etaSource === "measured" ? "Based on your past renders" : "Typical time for this tier"}>
            {v.progress || 5}% · {fmtCountdown(v.etaMs, v.elapsedMs)} · {fmtElapsed(v.elapsedMs ?? 0)} elapsed
          </p>
        </div>
      ) : (
        <div className="rounded-[10px] border slate-hair p-4 text-[12.5px] leading-relaxed" style={{ background: "var(--t-danger-bg)", color: "var(--t-danger-fg)" }}>
          <p className="font-bold mb-1">Generation failed — not billed.</p>
          <p className="font-mono !text-[11.5px] break-words">{v.error || "Unknown error"}</p>
        </div>
      )}
      <p className="mt-1">
        <SlateBadge tone="draft" className="!h-[20px] !text-[10.5px] tabular-nums" title={fullTs(v.createdAt)}>
          <Calendar className="size-3" /> {ago(v.createdAt)} · {fullTs(v.createdAt)}
        </SlateBadge>
      </p>
      <div className="mt-3 grid grid-cols-3 gap-1.5">
        {cfg.map((c) => (
          <div key={c[0]} className="rounded-[8px] border slate-hair px-2 py-1.5 min-w-0" style={{ background: "var(--surface-2)" }}>
            <p className="text-[9.5px] uppercase tracking-[.05em] text-muted font-bold leading-none">{c[0]}</p>
            <p className="text-[12px] font-semibold mt-1 truncate leading-tight" title={c[1]}>{c[1]}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-3">
        <div>
          <p className="slate-lbl">Prompt{v.mode === "extend" ? " (continuation)" : ""}</p>
          <p className="text-[13px] leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>{v.prompt || "—"}</p>
        </div>
        {v.negativePrompt && (
          <div>
            <p className="slate-lbl">Negative prompt</p>
            <p className="text-[13px] leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>{v.negativePrompt}</p>
          </div>
        )}
        {v.mode === "t2v" && (
          <div>
            <p className="slate-lbl">Inputs</p>
            <p className="text-[12.5px] text-muted leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>Text only — no reference images or source video.</p>
          </div>
        )}
        {v.mode === "i2v" && (
          <div>
            <p className="slate-lbl">Source image</p>
            {v.inputs.image ? (
              <div className="rounded-[10px] overflow-hidden border slate-hair h-[120px] bg-surface2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={v.inputs.image} className="w-full h-full object-cover" alt="source" />
              </div>
            ) : (
              <p className="text-[12.5px] text-muted leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>Source image deleted or unavailable — reload needs a new still.</p>
            )}
          </div>
        )}
        {v.mode === "frames" && (
          <div className="grid grid-cols-2 gap-3">
            {(["first", "last"] as const).map((k) => (
              <div key={k}>
                <p className="slate-lbl">{k === "first" ? "First frame" : "Last frame"}</p>
                <div className="rounded-[10px] overflow-hidden border slate-hair h-[110px] bg-surface2 grid place-items-center">
                  {v.inputs[k] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.inputs[k]} className="w-full h-full object-cover" alt={k} />
                  ) : (
                    <span className="text-[11.5px] text-muted px-2 text-center">Deleted or unavailable</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {v.mode === "r2v" && (
          <div>
            <p className="slate-lbl">Reference images ({(v.inputs.refs || []).length}/3)</p>
            {(v.inputs.refs || []).length ? (
              <div className="grid grid-cols-3 gap-2">
                {(v.inputs.refs || []).map((r, i) => (
                  <div key={i} className="rounded-[10px] overflow-hidden border slate-hair aspect-square bg-surface2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r} className="w-full h-full object-cover" alt="ref" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>Reference images deleted or unavailable — reload needs new stills.</p>
            )}
          </div>
        )}
        {v.mode === "extend" && (
          <div>
            <p className="slate-lbl">Source video (+7s continuation · {displayDur}s total)</p>
            {srcVideo ? (
              <button
                type="button"
                onClick={() => set({ video: srcVideo.id })}
                className="w-full text-left slate-card p-2 flex items-center gap-2.5 hover:border-[#3FA96D]"
                style={{ background: "var(--surface-2)" }}
                title="Open source video"
              >
                <span className="w-24 aspect-video rounded-[7px] overflow-hidden border slate-hair shrink-0 bg-surface2 relative grid place-items-center">
                  {srcVideo.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={srcVideo.thumb} className="absolute inset-0 w-full h-full object-cover" alt="" />
                  ) : (
                    <span className="text-[11px] text-muted">{srcVideo.dur}s</span>
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] font-semibold truncate">{(srcVideo.prompt || "Untitled").slice(0, 60)}</span>
                  <span className="block text-[11px] font-mono text-muted mt-0.5">{srcVideo.dur}s · {srcVideo.res} · {srcVideo.aspect} → +7s = {displayDur}s</span>
                </span>
              </button>
            ) : v.inputs.extendVideo ? (
              <p className="text-[12.5px] text-muted leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>Source video deleted — this clip keeps its {displayDur}s output but can&apos;t chain further from the original.</p>
            ) : (
              <p className="text-[12.5px] text-muted leading-relaxed slate-card p-3" style={{ background: "var(--surface-2)" }}>No source linked (old record) — output adds +7s to its original clip.</p>
            )}
          </div>
        )}
        {v.youtube?.videoId && (
          <div>
            <p className="slate-lbl">YouTube</p>
            <div className="slate-card p-2.5 flex items-center gap-2 flex-wrap" style={{ background: "var(--surface-2)" }}>
              <MonitorPlay className="size-4 text-[#C9432E]" />
              <a className="text-[12px] font-mono truncate" href={v.youtube.url} target="_blank" rel="noopener noreferrer">{v.youtube.url}</a>
              <span className="ml-auto text-[11.5px] text-fg2 tabular-nums">
                {v.youtube.views != null ? `${Number(v.youtube.views).toLocaleString()} views · ` : ""}{v.youtube.processingStatus || v.youtube.uploadStatus || ""}
              </span>
            </div>
          </div>
        )}
      </div>
    </SlateDialog>
  );
}

function DeleteVideoConfirm({ videoId, close }: { videoId: string; close: () => void }) {
  const deleteVideo = useStudio((s) => s.deleteVideo);
  const project = useStudio((s) => s.projects.find((x) => x.id === (s.activeId ?? "")) ?? s.projects[0]);
  const push = useToasts((s) => s.push);
  const { set } = useQueryState({ video: "", confirmDel: "" });
  const v = project?.library.find((x) => x.id === videoId);
  const mode = v?.status === "pending" ? "cancel" : v?.status === "failed" ? "dismiss" : "delete";
  const copy = {
    cancel: {
      title: "Cancel this render?",
      body: "Stops polling and asks Vertex to stop. No output means no charge.",
      action: "Cancel render",
      done: "Render cancelled",
    },
    dismiss: {
      title: "Dismiss this failure?",
      body: "Removes the failed record from the thread. Nothing was billed. This cannot be undone.",
      action: "Dismiss",
      done: "Failure dismissed",
    },
    delete: {
      title: "Delete this video?",
      body: "Removes it from the library and its cost from the project total. This cannot be undone.",
      action: "Delete",
      done: "Video deleted",
    },
  }[mode];
  return (
    <SlateModal onClose={close}>
      <h3 className="font-display font-bold text-[16px]">{copy.title}</h3>
      <p className="mt-1.5 text-[13.5px] text-fg2 leading-relaxed">{copy.body}</p>
      <div className="mt-5 flex gap-2 justify-end">
        <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
        <SlateButton
          variant="danger"
          onClick={() => {
            void deleteVideo(videoId).then(() => {
              push(copy.done, { icon: mode === "delete" ? "🗑" : "✓", tone: "info" });
              set({ video: "", confirmDel: "" });
              close();
            });
          }}
        >
          {copy.action}
        </SlateButton>
      </div>
    </SlateModal>
  );
}

// ---------- youtube publish ----------
function YoutubeDialog({ videoId, close }: { videoId: string; close: () => void }) {
  const params = useParams<{ projectId: string }>();
  const project = useStudio((s) => s.projects.find((x) => x.id === params.projectId));
  const setYoutube = useStudio((s) => s.setYoutube);
  const push = useToasts((s) => s.push);
  const yt = useYtAuth();
  const v = project?.library.find((x) => x.id === videoId);
  const saved = v?.youtube ?? {};
  const [title, setTitle] = useState(saved.title || (v?.prompt || "Untitled").slice(0, 95) || "Untitled");
  const [desc, setDesc] = useState(saved.description || ((v?.prompt || "") + (v?.prompt ? " — " : "") + `Made with AI Video Studio (${v ? modelOf(v.model).label : ""}, ${v?.res}, ${v?.dur}s). #AIVideo`));
  const [privacy, setPrivacy] = useState(saved.privacy || project?.settings.ytPrivacy || "unlisted");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(saved.pct || 0);
  const [info, setInfo] = useState<typeof saved | null>(saved.videoId ? saved : null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  if (!project || !v) return null;
  const connected = !!yt.token && yt.exp > Date.now();
  const saveYt = (patch: Record<string, unknown>) => setYoutube(v.id, patch);

  const poll = (id: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = () => {
      const tok = useYtAuth.getState().token;
      if (!tok) return;
      ytVideoState(tok, id)
        .then((item) => {
          if (!item) return;
          const st = item.status || {};
          const pd = item.processingDetails || {};
          const sn = item.statistics || {};
          const patch = {
            videoId: id, url: `https://youtu.be/${id}`, title: st.title || title,
            uploadStatus: st.uploadStatus || "", processingStatus: pd.processingStatus || "",
            timeLeftMs: pd.timeLeftMs || 0, fail: pd.processingFailureReason || st.failureReason || st.rejectionReason || "",
            views: sn.viewCount != null ? Number(sn.viewCount) : null,
            likes: sn.likeCount != null ? Number(sn.likeCount) : null,
            comments: sn.commentCount != null ? Number(sn.commentCount) : null,
            privacy: st.privacyStatus || privacy, checkedAt: Date.now(),
          };
          saveYt(patch);
          setInfo((p) => ({ ...p, ...patch }));
          if (patch.processingStatus === "succeeded" && patch.uploadStatus !== "uploaded") {
            if (pollRef.current) clearInterval(pollRef.current);
            push("YouTube video is live", { icon: "▶" });
          }
          if (["failed", "terminated"].includes(patch.processingStatus) || ["failed", "rejected"].includes(patch.uploadStatus)) {
            if (pollRef.current) clearInterval(pollRef.current);
            push("YouTube processing failed", { icon: "!", tone: "danger", detail: (patch.fail || "").slice(0, 160) });
          }
        })
        .catch(() => {});
    };
    tick();
    pollRef.current = setInterval(tick, 15000);
  };

  const refresh = () => {
    const id = v.youtube?.videoId || info?.videoId;
    if (!id) {
      push("Nothing published yet", { icon: "▶", tone: "info" });
      return;
    }
    const tok = useYtAuth.getState().token;
    if (!tok) {
      push("Connect YouTube first", { icon: "!", tone: "danger" });
      return;
    }
    push("Refreshing YouTube status…", { icon: "…" });
    ytVideoState(tok, id)
      .then((item) => {
        const st = item.status || {};
        const pd = item.processingDetails || {};
        const sn = item.statistics || {};
        const patch = {
          uploadStatus: st.uploadStatus || "", processingStatus: pd.processingStatus || "",
          timeLeftMs: pd.timeLeftMs || 0, fail: pd.processingFailureReason || st.failureReason || st.rejectionReason || "",
          views: sn.viewCount != null ? Number(sn.viewCount) : null,
          likes: sn.likeCount != null ? Number(sn.likeCount) : null,
          comments: sn.commentCount != null ? Number(sn.commentCount) : null,
          privacy: st.privacyStatus || privacy, checkedAt: Date.now(),
        };
        saveYt(patch);
        setInfo((p) => ({ ...p, ...patch }));
        push("YouTube status updated", { icon: "▶" });
      })
      .catch((e) => push("Refresh failed", { icon: "!", tone: "danger", detail: String((e as Error).message || e).slice(0, 120) }));
  };

  const start = async () => {
    if (busy) return;
    if (!v.url) {
      push("No playable file — re-upload this video first (blob URLs die on reload).", { icon: "!", tone: "danger" });
      return;
    }
    const parsed = ytPublishSchema.safeParse({ title, description: desc, privacy });
    if (!parsed.success) {
      push(parsed.error.issues[0]?.message ?? "Invalid input", { icon: "!", tone: "danger" });
      return;
    }
    setBusy(true);
    setPct(0);
    try {
      let tok = useYtAuth.getState().token;
      const exp = useYtAuth.getState().exp;
      if (!tok || exp <= Date.now()) {
        const c = await ytConnect(project.settings.ytClientId || "");
        const { ytFetchChannel } = await import("@/lib/youtube");
        const channel = await ytFetchChannel(c.token);
        useYtAuth.getState().setAuth(c.token, c.exp, channel);
        tok = c.token;
      }
      const res = await fetch(authedMediaUrl(v.url));
      if (!res.ok) throw new Error(`Fetch failed (${res.status}) — re-upload the file.`);
      const blob = await res.blob();
      if (!blob.size) throw new Error("Empty file — re-upload it.");
      saveYt({ title: parsed.data.title.slice(0, 100), description: parsed.data.description.slice(0, 4900), privacy, state: "uploading", pct: 0, startedAt: Date.now() });
      const out = await ytUploadVideo({
        token: tok, file: blob, title: parsed.data.title.slice(0, 100), description: parsed.data.description.slice(0, 4900),
        tags: ["AI video", "Veo", modelOf(v.model).label], categoryId: project.settings.ytCategory || "22",
        privacy, madeForKids: false, synthetic: true, onProgress: (pc) => { setPct(pc); saveYt({ pct: pc }); },
      });
      const id = out?.id;
      if (!id) throw new Error("YouTube accepted the upload but returned no video ID.");
      const patch = { videoId: id, url: `https://youtu.be/${id}`, state: "processing", uploadStatus: "uploaded", processingStatus: "processing", pct: 100, publishedAt: Date.now() };
      saveYt(patch);
      setInfo((p) => ({ ...p, ...patch }));
      setPct(100);
      push("Upload complete — YouTube is processing", { icon: "▶", detail: `youtu.be/${id}` });
      poll(id);
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 220);
      saveYt({ state: "error", fail: msg });
      push("YouTube upload failed", { icon: "!", tone: "danger", detail: msg.slice(0, 120) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <span className="grid place-items-center w-8 h-8 rounded-[8px] shrink-0 bg-[#F8E4DF]">
            <MonitorPlay className="size-4 text-[#C9432E]" />
          </span>
          <span className="text-[14px] font-bold truncate">Publish to YouTube</span>
          <SlateCloseButton onClick={close} />
        </>
      }
    >
      {!connected && (
        <div className="rounded-[10px] border slate-hair p-3 mb-3 flex items-center gap-2.5" style={{ background: "var(--surface-2)" }}>
          <span className="grid place-items-center w-9 h-9 rounded-[9px] shrink-0 bg-[#F8E4DF]">
            <MonitorPlay className="size-4 text-[#C9432E]" />
          </span>
          <p className="flex-1 min-w-0 text-[12.5px] leading-snug">
            <span className="font-bold">Not connected.</span>{" "}
            <span className="text-muted">You&apos;ll be asked to sign in with Google on publish — or connect now in Settings → YouTube.</span>
          </p>
        </div>
      )}
      {info?.videoId ? (
        <div className="rounded-[10px] border slate-hair p-3 mb-3" style={{ background: "var(--surface-2)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <SlateBadge tone={info.processingStatus === "succeeded" ? "ok" : ["failed", "terminated"].includes(info.processingStatus ?? "") ? "danger" : "pending"}>
              <MonitorPlay className="size-3" />
              {info.processingStatus === "succeeded" ? "Live" : info.processingStatus === "failed" ? "Failed" : info.processingStatus === "terminated" ? "Terminated" : info.processingStatus === "processing" ? "Processing" : "Uploaded"}
            </SlateBadge>
            <a className="text-[12.5px] font-mono text-[#1C7247] truncate" href={info.url} target="_blank" rel="noopener noreferrer">{info.url}</a>
            <SlateButton variant="ghost" size="sm" onClick={refresh} title="Refresh status & views" className="ml-auto">
              <RefreshCw className="size-3.5" /> Refresh
            </SlateButton>
          </div>
          <div className="mt-2 flex items-center gap-3 text-[12px] text-fg2 flex-wrap">
            <span className="tabular-nums"><span className="font-bold text-fg">{info.views != null ? Number(info.views).toLocaleString() : "—"}</span> views</span>
            <span className="tabular-nums"><span className="font-bold text-fg">{info.likes != null ? Number(info.likes).toLocaleString() : "—"}</span> likes</span>
            <span className="tabular-nums"><span className="font-bold text-fg">{info.comments != null ? Number(info.comments).toLocaleString() : "—"}</span> comments</span>
          </div>
          {info.fail && <p className="mt-1.5 text-[11.5px] font-mono break-words text-[#C9432E]">{info.fail}</p>}
        </div>
      ) : (
        <p className="text-[12.5px] text-muted leading-relaxed mb-3">
          Publishes this render straight to your channel via <span className="font-mono">videos.insert</span> (resumable upload, 256KB×N chunks). Progress shows here; processing + views poll every 15s after.
        </p>
      )}
      <div className="space-y-3">
        <div>
          <SlateLabel>Title (≤100)</SlateLabel>
          <SlateField value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="Video title" />
        </div>
        <div>
          <SlateLabel>Description</SlateLabel>
          <SlateTextarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description, links, #Shorts for vertical ≤60s…" />
        </div>
        <div>
          <SlateLabel>Privacy</SlateLabel>
          <SlateDropdown
            label={privacy}
            btnClassName="slate-field w-full flex items-center gap-1 !text-[13px] font-semibold"
            menu={(c) => YT_PRIVS.map((p) => (
              <SlateOption key={p.id} active={privacy === p.id} sub={p.hint} onPick={() => setPrivacy(p.id)} onClose={c}>
                {p.label}
              </SlateOption>
            ))}
          />
          <p className="text-[11.5px] text-muted mt-1">Unverified OAuth apps can only publish <span className="font-mono">private</span>.</p>
        </div>
        {busy && (
          <div>
            <div className="flex justify-between text-[12px] font-bold mb-1"><span>Uploading…</span><span className="tabular-nums">{pct}%</span></div>
            <SlateProgress value={pct} />
          </div>
        )}
        <div className="flex gap-2 justify-end flex-wrap">
          <SlateButton variant="ghost" onClick={close}>{info?.videoId ? "Close" : "Cancel"}</SlateButton>
          <SlateButton variant="primary" disabled={busy} onClick={start}>
            <MonitorPlay className="size-3.5" /> {busy ? `Publishing ${pct}%` : info?.videoId ? "Re-publish" : "Publish to YouTube"}
          </SlateButton>
        </div>
      </div>
    </SlateDialog>
  );
}
