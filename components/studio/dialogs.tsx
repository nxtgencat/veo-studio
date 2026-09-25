"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Calendar, Check, MonitorPlay, RefreshCw, SkipBack, SkipForward, StretchHorizontal,
  Trash2,
} from "lucide-react";
import { EL_CATS, YT_PRIVS } from "@/mock/catalog.mock";
import { ago, fullTs, money, pic, uid } from "@/lib/format";
import { modelOf } from "@/lib/pricing";
import { captureAt, captureVideo, fileToImage } from "@/lib/media";
import { ytConnect, ytUploadVideo, ytVideoState } from "@/lib/youtube";
import { advancedFormSchema, ytPublishSchema } from "@/lib/schemas";
import { useStudio } from "@/stores/use-studio";
import { useToasts, useYtAuth } from "@/stores/use-ui";
import { useQueryState } from "@/hooks/use-studio-hooks";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton, SlateCloseButton, SlateIconButton } from "@/components/slate/button";
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
            .then((url) => {
              const el = { id: uid("el"), name: (f.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 40) || "Upload", img: url, note: "Uploaded in picker" };
              updateActive((d) => {
                d.elements[slotKey === "ref" ? "assets" : "frames"].unshift(el);
              });
              pick(url);
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
            .then(({ url, thumb, meta }) => {
              const v = {
                id: uid("vid"), mode: "t2v" as const, prompt: (f.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Uploaded video",
                model: "import", res: meta.res, aspect: meta.aspect, dur: meta.dur, audio: true,
                seed: "" as string | number, person: "allow_adult", enhance: false, batch: 1,
                status: "success" as const, progress: 100, cost: 0, createdAt: Date.now(),
                thumb, url, imported: true, error: "", inputs: {},
              };
              importVideo(v);
              updateActive((d) => { d.gen.extendVideo = v.id; });
              close();
              push(meta.dur > 30 ? `Imported — but ${meta.dur}s is too long to extend (≤30s)` : "Imported and selected as extend source", { icon: "✓" });
            })
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
          {shown.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => {
                if (v.dur > 30) {
                  push(`That video is ${v.dur}s — Extend inputs must be ≤ 30s.`, { icon: "!", tone: "danger" });
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
                <span className="block text-[11px] font-mono text-muted mt-0.5">{v.dur}s · {v.res} · {v.aspect}{v.dur > 30 ? " · too long (≤30s)" : ""}</span>
              </span>
            </button>
          ))}
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
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
          <SlateButton
            variant="primary"
            onClick={() => {
              const parsed = advancedFormSchema.safeParse({ seed, person });
              if (!parsed.success) {
                push("Invalid advanced settings", { icon: "!", tone: "danger" });
                return;
              }
              updateActive((d) => { d.gen.seed = parsed.data.seed; d.gen.person = parsed.data.person; });
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
  const updateActive = useStudio((s) => s.updateActive);
  const push = useToasts((s) => s.push);
  const { set } = useQueryState({ video: "", youtube: "", confirmDel: "" });
  const v = project?.library.find((x) => x.id === videoId);
  if (!project || !v) return null;
  const m = modelOf(v.model);
  const cfg: [string, string][] = [
    ["Model", (v.model === "import" ? "Upload" : m.label) + (m.retires && v.model !== "import" ? " · retires Jun 30" : "")],
    ["Resolution", v.res], ["Aspect", v.aspect], ["Duration", `${v.dur}s`],
    ["Audio", v.audio ? "On" : "Off"],
    ["Seed", v.seed === "" || v.seed == null ? "random" : String(v.seed)],
    ["Person", v.person === "disallow" ? "Disallow" : "Allow adults"],
    ["Enhance", v.enhance ? "On" : "Off"], ["Batch", String(v.batch || 1)],
  ];

  const grab = (which: string, t: number | null) => {
    if (!v.url) {
      push("File is gone after reload — re-upload it to play or grab frames.", { icon: "!", tone: "danger" });
      return;
    }
    push(`Grabbing ${which.toLowerCase()}…`, { icon: "…" });
    captureAt(v.url, t)
      .then((img) => {
        updateActive((d) => {
          d.elements.frames.unshift({ id: uid("el"), name: `${which} · ${(v.prompt || "video").slice(0, 28)}`, img, note: "Grabbed from library video" });
        });
        push(`${which} saved to Elements`, { icon: "✓" });
      })
      .catch(() => {
        updateActive((d) => {
          d.elements.frames.unshift({ id: uid("el"), name: `${which} · ${(v.prompt || "video").slice(0, 28)}`, img: v.thumb || pic(v.id, 400, 225), note: "Cover fallback" });
        });
        push("Live grab blocked — saved cover instead", { icon: "!", tone: "danger" });
      });
  };

  const extend = () => {
    if (v.dur > 30) {
      push(`That video is ${v.dur}s — Extend inputs must be ≤ 30s.`, { icon: "!", tone: "danger" });
      return;
    }
    updateActive((d) => { d.gen.mode = "extend"; d.gen.extendVideo = v.id; });
    router.push(`/p/${project.id}/generate`);
    close();
  };

  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <ModeBadge mode={v.mode} />
          <StatusBadge status={v.status} />
          <SlateBadge tone="draft">{v.dur}s · {v.res} · {v.aspect}</SlateBadge>
          <SlateCloseButton onClick={close} />
        </>
      }
      footer={
        <>
          <span className="font-display font-bold text-[17px] tabular-nums mr-auto">{v.status === "success" ? money(v.cost) : "$0.00"}</span>
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
          <SlateIconButton variant="quiet" size="icon-sm" label="Delete video" onClick={() => set({ confirmDel: v.id })}>
            <Trash2 className="size-3.5" />
          </SlateIconButton>
        </>
      }
    >
      {v.status === "success" && v.url ? (
        <div className="rounded-[10px] border slate-hair bg-black overflow-hidden grid place-items-center">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video className="max-h-[46dvh] max-w-full mx-auto" controls playsInline poster={v.thumb || ""} src={v.url} />
        </div>
      ) : v.status === "success" ? (
        <div className="rounded-[10px] border slate-hair p-4 text-[12.5px] leading-relaxed" style={{ background: "var(--t-pending-bg)", color: "var(--t-pending-fg)" }}>
          <p className="font-bold mb-1">File kept as thumbnail only.</p>
          <p>Browsers can&apos;t persist video files — re-upload it to play or extend.</p>
        </div>
      ) : v.status === "pending" ? (
        <div className="rounded-[10px] border slate-hair p-5 text-center">
          <SlateProgress value={v.progress || 5} />
          <p className="text-[12.5px] font-bold tabular-nums mt-2">{v.progress || 5}% rendering…</p>
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
        {v.mode === "i2v" && v.inputs.image && (
          <div>
            <p className="slate-lbl">Source image</p>
            <div className="rounded-[10px] overflow-hidden border slate-hair h-[120px] bg-surface2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={v.inputs.image} className="w-full h-full object-cover" alt="source" />
            </div>
          </div>
        )}
        {v.mode === "frames" && (
          <div className="grid grid-cols-2 gap-3">
            {(["first", "last"] as const).map((k) => (
              <div key={k}>
                <p className="slate-lbl">{k === "first" ? "First frame" : "Last frame"}</p>
                <div className="rounded-[10px] overflow-hidden border slate-hair h-[110px] bg-surface2">
                  {v.inputs[k] && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={v.inputs[k]} className="w-full h-full object-cover" alt={k} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {v.mode === "r2v" && (
          <div>
            <p className="slate-lbl">Reference images ({(v.inputs.refs || []).length}/3)</p>
            <div className="grid grid-cols-3 gap-2">
              {(v.inputs.refs || []).map((r, i) => (
                <div key={i} className="rounded-[10px] overflow-hidden border slate-hair aspect-square bg-surface2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={r} className="w-full h-full object-cover" alt="ref" />
                </div>
              ))}
            </div>
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
  const push = useToasts((s) => s.push);
  const { set } = useQueryState({ video: "", confirmDel: "" });
  return (
    <SlateModal onClose={close}>
      <h3 className="font-display font-bold text-[16px]">Delete this video?</h3>
      <p className="mt-1.5 text-[13.5px] text-fg2 leading-relaxed">
        Removes it from the library and its cost from the project total. This cannot be undone.
      </p>
      <div className="mt-5 flex gap-2 justify-end">
        <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
        <SlateButton
          variant="danger"
          onClick={() => {
            deleteVideo(videoId);
            push("Video deleted", { icon: "🗑", tone: "info" });
            set({ video: "", confirmDel: "" });
            close();
          }}
        >
          Delete
        </SlateButton>
      </div>
    </SlateModal>
  );
}

// ---------- youtube publish ----------
function YoutubeDialog({ videoId, close }: { videoId: string; close: () => void }) {
  const params = useParams<{ projectId: string }>();
  const project = useStudio((s) => s.projects.find((x) => x.id === params.projectId));
  const updateActive = useStudio((s) => s.updateActive);
  const push = useToasts((s) => s.push);
  const yt = useYtAuth();
  const v = project?.library.find((x) => x.id === videoId);
  const saved = v?.youtube ?? {};
  const [title, setTitle] = useState(saved.title || (v?.prompt || "Untitled").slice(0, 95) || "Untitled");
  const [desc, setDesc] = useState(saved.description || ((v?.prompt || "") + (v?.prompt ? " — " : "") + `Made with AI Video Studio (${v ? modelOf(v.model).label : ""}, ${v?.res}, ${v?.dur}s). #AIVideo`));
  const [privacy, setPrivacy] = useState(saved.privacy || project?.settings.ytPrivacy || "unlisted");
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(saved.pct || 0);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState<typeof saved | null>(saved.videoId ? saved : null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  if (!project || !v) return null;
  const connected = !!yt.token && yt.exp > Date.now();
  const saveYt = (patch: Record<string, unknown>) =>
    updateActive((d) => {
      const x = d.library.find((y) => y.id === v.id);
      if (x) x.youtube = { ...(x.youtube ?? {}), ...patch } as typeof x.youtube;
    });

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
            setErr(patch.fail || "YouTube processing failed.");
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
      setErr("No playable file — re-upload this video first (blob URLs die on reload).");
      return;
    }
    const parsed = ytPublishSchema.safeParse({ title, description: desc, privacy });
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    setErr("");
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
      const res = await fetch(v.url);
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
      setErr(msg);
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
            <SlateIconButton variant="quiet" size="icon-sm" label="Refresh status & views" onClick={refresh} className="!w-8 ml-auto">
              <RefreshCw className="size-3.5" />
            </SlateIconButton>
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
        {err && <p className="text-[12px] font-mono break-words p-2.5 rounded-[8px]" style={{ background: "var(--t-danger-bg)", color: "var(--t-danger-fg)" }}>{err}</p>}
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
