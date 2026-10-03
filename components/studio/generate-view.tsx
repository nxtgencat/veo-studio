"use client";

import { memo, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowRight, Check, ChevronDown, CircleX, ImagePlus, Loader2, Play, SlidersHorizontal, Sparkles, TriangleAlert,
  Volume2, VolumeX, WandSparkles, X,
} from "lucide-react";
import { EL_CATS, MODES } from "@/lib/catalog";
import { fmtDurPair, money } from "@/lib/format";
import { allModels, expectedDurOf, modelOf, priceFor } from "@/lib/pricing";
import { useComposer, useStudio } from "@/stores/use-studio";
import { pushErr, useToasts } from "@/stores/use-ui";
import { useElements, useGen, useLibrary, useQueryState } from "@/hooks/use-studio-hooks";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton, SlateIconButton } from "@/components/slate/button";
import { SlateDropdown, SlateMenuRow, SlateOption } from "@/components/slate/dropdown";
import { SlateTooltip } from "@/components/slate/tooltip";
import { PageHead } from "@/components/slate/core";
import { ModeBadge, ModeIcon, StatusBadge, VideoProgress } from "@/components/studio/shared";
import type { VideoItem } from "@/lib/schemas";

/** One recents card. Memo + stable derivation: progress ticks re-render only
 *  the rows that actually changed, not the whole thread. */
const RecentCard = memo(function RecentCard({ v, lib, projectId }: {
  v: VideoItem; lib: VideoItem[]; projectId: string;
}) {
  return (
    <Link
      href={`/p/${projectId}/generate?video=${v.id}`}
      className="slate-card overflow-hidden cursor-pointer hover:border-[#3FA96D] no-underline text-inherit"
    >
      <div className="flex gap-3 p-3 min-w-0">
        <span className="w-[96px] min-[420px]:w-[120px] sm:w-[168px] aspect-video rounded-[8px] overflow-hidden border slate-hair shrink-0 bg-surface2 relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {v.thumb ? (
            <img src={v.thumb} className="absolute inset-0 w-full h-full object-cover" alt="" loading="lazy" />
          ) : (
            <span className="absolute inset-0 grid place-items-center text-muted">
              <Play className="size-5 opacity-40" />
            </span>
          )}
          {v.status === "success" && (
            <span className="absolute inset-0 m-auto w-8 h-8 rounded-full bg-black/55 grid place-items-center">
              <Play className="size-4 text-white ml-0.5" />
            </span>
          )}
          {v.status === "failed" && (
            <span className="absolute inset-0 grid place-items-center bg-black/55">
              <CircleX className="size-5 text-white" />
            </span>
          )}
        </span>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center gap-1.5 flex-wrap">
            <ModeBadge mode={v.mode} />
            <StatusBadge status={v.status} />
            <SlateBadge tone="draft">{fmtDurPair(expectedDurOf(v, lib), v.durActual)} · {v.res}</SlateBadge>
          </div>
          <p className="text-[13px] font-semibold leading-snug mt-1.5 break-words line-clamp-2" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {v.prompt || "Untitled"}
          </p>
          {v.status === "pending" ? (
            <>
              <div className="slate-prog mt-2"><div style={{ width: `${v.progress || 5}%` }} /></div>
              <VideoProgress v={v} lead={`${money(v.cost)} est.`} />
            </>
          ) : (
            <SlateTooltip tip={v.status === "failed" ? "Would-be cost — not billed" : undefined}>
              <p className="text-[11.5px] font-mono text-muted mt-1.5">
                {v.status === "success" ? `${money(v.cost)} · ${modelOf(v.model).label}` : v.status === "failed" ? (<><s>{money(v.cost)}</s> · {(v.error || "failed").slice(0, 90)}</>) : (v.error || "failed").slice(0, 90)}
              </p>
            </SlateTooltip>
          )}
        </div>
      </div>
    </Link>
  );
});

function SlotBox({
  img, emptyLabel, emptyIcon, onPick, onClear, tag,
}: {
  img: string; emptyLabel: string; emptyIcon?: React.ReactNode; onPick: () => void; onClear: () => void; tag?: string;
}) {
  return (
    <div className="relative w-[44px] h-[44px] shrink-0">
      <SlateTooltip tip={emptyLabel}>
        <button
          type="button"
          onClick={onPick}
          aria-label={emptyLabel}
          className="w-full h-full rounded-[10px] overflow-hidden border slate-hair grid place-items-center hover:border-[#3FA96D] bg-surface2 relative"
          style={img ? undefined : { borderStyle: "dashed" }}
        >
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img} className="absolute inset-0 w-full h-full object-cover" alt="" />
          ) : (
            <span className="flex flex-col items-center gap-0.5 text-muted">
              {emptyIcon ?? <ImagePlus className="size-3.5" />}
              <span className="text-[8.5px] font-bold leading-none whitespace-nowrap">{emptyLabel}</span>
            </span>
          )}
        </button>
      </SlateTooltip>
      {img && (
        <SlateIconButton
          size="icon-2xs"
          variant="quiet"
          label="Clear"
          onClick={onClear}
          className="slate-float-btn absolute -top-2 -right-2 bg-surface border slate-hair"
        >
          <X />
        </SlateIconButton>
      )}
      {tag && (
        <span
          className="absolute bottom-0.5 right-1 text-[9px] font-mono text-white rounded px-1 pointer-events-none"
          style={{ background: "rgba(0,0,0,.55)" }}
        >
          {tag}
        </span>
      )}
    </div>
  );
}

export function GenerateView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const exists = useStudio((s) => s.projects.some((p) => p.id === projectId));
  const lib = useLibrary(projectId);
  const elements = useElements(projectId);
  const g = useGen(projectId);
  const updateDraft = useComposer((s) => s.updateDraft);
  const queueGeneration = useStudio((s) => s.queueGeneration);
  const push = useToasts((s) => s.push);
  const { set } = useQueryState({ video: "", youtube: "", picker: "", refIndex: "", advanced: "" });
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [mention, setMention] = useState<{ q: string; start: number; pos: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const m = useMemo(() => modelOf(g.model), [g.model]);
  const capsReady = useStudio((s) => s.capsReady);
  const MODELS = useMemo(() => (capsReady ? allModels() : []), [capsReady]);
  const price = useMemo(
    () => priceFor(g.model, g.res, g.dur, g.audio, g.batch),
    [g.model, g.res, g.dur, g.audio, g.batch],
  );
  const cur = MODES.find((x) => x.id === g.mode) ?? MODES[0];
  // Recents thread is generations only — uploads live in Library → Uploaded.
  const recents = useMemo(
    () => lib.filter((v) => !v.imported),
    [lib],
  );
  const pendingCount = useMemo(() => recents.filter((v) => v.status === "pending").length, [recents]);

  if (!exists) return null;
  if (!capsReady) {
    return (
      <div className="min-h-full grid place-items-center">
        <p className="text-[13px] text-muted">Loading models from server…</p>
      </div>
    );
  }
  const bad =
    (g.mode === "r2v" && !("ref" in m && m.ref)) ||
    (g.mode === "extend" && !("ext" in m && m.ext)) ||
    (g.mode === "frames" && !("flf" in m && m.flf));

  const fit = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    const lh = 22;
    const h = Math.min(Math.max(el.scrollHeight, lh * 2), lh * 4);
    el.style.height = h + "px";
    el.style.overflowY = el.scrollHeight > h + 1 ? "auto" : "hidden";
  };

  const allEls = () => {
    const out: { cat: string; label: string; e: { id: string; name: string; img: string; note: string } }[] = [];
    EL_CATS.forEach(({ id: cat, label }) => {
      (elements[cat as keyof typeof elements] || []).forEach((e) =>
        out.push({ cat, label, e }),
      );
    });
    return out;
  };
  const mentionList = mention ? allEls().filter((x) => x.e.name.toLowerCase().includes(mention.q)).slice(0, 6) : [];

  const attachMention = (img: string) => {
    updateDraft(projectId, (d) => {
      if (d.mode === "frames") {
        if (!d.first) d.first = img;
        else if (!d.last) d.last = img;
      } else if (d.mode === "i2v") {
        if (!d.image) d.image = img;
      } else if (d.mode === "r2v") {
        const r = d.refs.filter(Boolean);
        if (r.length < 3 && !r.includes(img)) r.push(img);
        d.refs = r;
      } else if (d.mode === "t2v") {
        const mm = modelOf(d.model);
        if (!("ref" in mm && mm.ref)) d.model = "veo-3.1-fast-generate-001";
        d.mode = "r2v";
        const r = d.refs.filter(Boolean);
        if (r.length < 3 && !r.includes(img)) r.push(img);
        d.refs = r;
        d.dur = 8;
      }
    });
  };

  const submit = () => {
    if (submitting) return;
    setMention(null);
    setSubmitting(true);
    void queueGeneration(projectId).then((r) => {
      setSubmitting(false);
      if (!r.ok) pushErr(r.error ?? "Cannot generate");
      else push(`${r.count} render${(r.count ?? 1) > 1 ? "s" : ""} queued`, { icon: "sparkles", detail: `${m.label} · ${g.res} · ${g.dur}s` });
    }).catch((e) => {
      setSubmitting(false);
      pushErr(e instanceof Error ? e.message : "Cannot generate");
    });
  };

  const openPicker = (patch: Record<string, string>) => set(patch);

  return (
    <div className="min-h-full flex flex-col min-w-0 w-full">
      {bad && (
        <div className="shrink-0 pb-3">
          <p className="text-[12px] text-[#B8790E] flex items-center gap-1.5">
            <TriangleAlert className="size-3.5" /> {m.label} does not support this mode — switch model or mode.
          </p>
        </div>
      )}

      <div className="flex-1 min-w-0 grid grid-cols-1 xl:grid-cols-2 content-start gap-2.5">
        {!recents.length ? (
          <div className="slate-card p-8 text-center xl:col-span-full max-w-[600px] w-full mx-auto">
            <div className="grid place-items-center w-12 h-12 rounded-full mx-auto mb-3" style={{ background: "var(--t-brand-bg)" }}>
              <Sparkles className="size-5 text-[#1C7247]" />
            </div>
            <h3 className="font-display font-bold text-[16px]">Describe a shot below to begin</h3>
            <p className="text-[12.5px] text-fg2 mt-1 max-w-[42ch] mx-auto">
              Renders appear here as a thread. Click any card for player, config and cost.
            </p>
          </div>
        ) : (
          <>
            <div className="xl:col-span-full">
              <PageHead
                title="Recents"
                sub={`${recents.length} renders — click a card for player, config and cost.`}
                actions={
                  <>
                    {pendingCount > 0 && (
                      <SlateBadge tone="pending">
                        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" /> {pendingCount} rendering
                      </SlateBadge>
                    )}
                    <Link href={`/p/${projectId}/library`} className="slate-btn slate-btn-ghost slate-btn-sm no-underline">
                      View all <ArrowRight className="size-3.5" />
                    </Link>
                  </>
                }
              />
            </div>
            {recents.map((v) => (
              <RecentCard key={v.id} v={v} lib={lib} projectId={projectId} />
            ))}
          </>
        )}
      </div>

      {/* sticky composer */}
      <div className="sticky bottom-0 z-20 -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8 mt-3 pb-5 -mb-5">
        <div
          className="absolute inset-x-0 -top-24 -bottom-5 pointer-events-none"
          style={{
            backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
            background: "linear-gradient(to bottom, transparent 0%, var(--app) 85%)",
            maskImage: "linear-gradient(to bottom, transparent 0, black 96px)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent 0, black 96px)",
          }}
        />
        <div className="relative slate-card slate-composer w-full max-w-[500] mx-auto">
          <div className="px-2.5 pt-2 flex items-center gap-2.5">
            <div className="w-[168px] min-[420px]:w-[200px] shrink-0">
              <SlateDropdown
                trigger={
                  <button
                    type="button"
                    className="w-full flex items-center gap-2.5 rounded-[10px] border slate-hair pl-2 pr-2.5 h-[44px] text-left hover:border-[#3FA96D] transition-colors"
                    style={{ background: "var(--surface-2)" }}
                    aria-haspopup="listbox"
                  >
                    <span className="slate-tile-icon w-8 h-8 rounded-[8px]">
                      <ModeIcon name={cur.icon} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-bold leading-tight truncate">
                        {cur.label}{g.mode === "r2v" ? " · 8s" : ""}{g.mode === "extend" ? " · +7s" : ""}
                      </span>
                      <span className={`block text-[11px] text-muted truncate leading-tight mt-px ${g.mode === "t2v" ? "" : "hidden min-[420px]:block"}`}>{cur.desc}</span>
                    </span>
                    <ChevronDown className="size-4 text-muted shrink-0" />
                  </button>
                }
                menu={(close) => MODES.map((md) => {
                  const dis =
                    (md.id === "r2v" && !("ref" in m && m.ref)) ||
                    (md.id === "extend" && !("ext" in m && m.ext)) ||
                    (md.id === "frames" && !("flf" in m && m.flf));
                  const on = g.mode === md.id;
                  if (dis) {
                    return (
                      <div key={md.id} className="flex items-center gap-2.5 rounded-[9px] px-2 py-2 opacity-40" aria-disabled="true">
                        <span className="grid place-items-center w-8 h-8 rounded-[8px] shrink-0 bg-surface2">
                          <ModeIcon name={md.icon} className="size-4 text-muted" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-[13px] font-bold leading-tight">{md.label}</span>
                          <span className="block text-[11px] text-muted truncate">N/A on {m.label}</span>
                        </span>
                      </div>
                    );
                  }
                  return (
                    <SlateMenuRow
                      key={md.id}
                      active={on}
                      onPick={() => updateDraft(projectId, (d) => {
                        d.mode = md.id;
                        if (md.id === "r2v") d.dur = 8;
                      })}
                      onClose={close}
                    >
                      <span className="grid place-items-center w-8 h-8 rounded-[8px] shrink-0" style={{ background: on ? "var(--surface)" : "var(--surface-2)" }}>
                        <ModeIcon name={md.icon} className="size-4" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className={`block text-[13px] font-bold leading-tight ${on ? "text-[var(--t-brand-fg)]" : ""}`}>{md.label}</span>
                        <span className="block text-[11px] text-muted truncate">{md.desc}</span>
                      </span>
                      {on && <Check className="size-4 shrink-0 text-[#1C7247]" />}
                    </SlateMenuRow>
                  );
                })}
              />
            </div>
            {g.mode !== "t2v" && (
              <div className="flex items-center gap-2.5 shrink-0">
                {g.mode === "i2v" && (
                  <SlotBox
                    img={g.image} emptyLabel="Frame"
                    onPick={() => openPicker({ picker: "image" })}
                    onClear={() => updateDraft(projectId, (d) => { d.image = ""; })}
                  />
                )}
                {g.mode === "frames" && (["first", "last"] as const).map((k) => (
                  <SlotBox
                    key={k} img={g[k]} emptyLabel={k === "first" ? "First" : "Last"}
                    onPick={() => openPicker({ picker: k })}
                    onClear={() => updateDraft(projectId, (d) => { d[k] = ""; })}
                  />
                ))}
                {g.mode === "r2v" && [0, 1, 2].map((i) => (
                  <SlotBox
                    key={i} img={g.refs[i] || ""} emptyLabel={`Ref ${i + 1}`}
                    onPick={() => openPicker({ picker: "ref", refIndex: String(i) })}
                    onClear={() => updateDraft(projectId, (d) => { d.refs = d.refs.filter((_, j) => j !== i); })}
                  />
                ))}
                {g.mode === "extend" && (() => {
                  const sel = lib.find((v) => v.id === g.extendVideo);
                  return (
                    <SlotBox
                      img={sel?.thumb ?? ""} emptyLabel="Video" tag={sel ? `${expectedDurOf(sel, lib)}s` : ""}
                      onPick={() => openPicker({ picker: "video" })}
                      onClear={() => updateDraft(projectId, (d) => { d.extendVideo = ""; })}
                    />
                  );
                })()}
              </div>
            )}
          </div>

          <div className="p-2.5">
            <div className="rounded-[10px] border slate-hair p-2 relative" style={{ background: "var(--surface-2)" }}>
              {mention && (
                <div className="absolute left-2 right-2 bottom-full mb-2 slate-card p-1.5 z-30 max-h-56 overflow-y-auto" role="listbox">
                  {!mentionList.length ? (
                    <p className="px-2 py-1.5 text-[12px] text-muted">No elements match “@{mention.q}” — add some in Elements.</p>
                  ) : mentionList.map((x) => (
                    <button
                      key={x.e.id}
                      type="button"
                      role="option"
                      onClick={() => {
                        const men = mention;
                        if (!men) return;
                        const token = `@${x.e.name} `;
                        updateDraft(projectId, (d) => {
                          const curP = d.prompt;
                          d.prompt = curP.slice(0, men.start) + token + curP.slice(men.pos);
                        });
                        setMention(null);
                        attachMention(x.e.img);
                        setTimeout(() => {
                          const ta = taRef.current;
                          if (ta) {
                            const n = men.start + token.length;
                            ta.focus();
                            try { ta.setSelectionRange(n, n); } catch { /* noop */ }
                            fit(ta);
                          }
                        }, 0);
                      }}
                      className="w-full flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-left hover:bg-surface2"
                    >
                      <span className="w-7 h-7 rounded-[7px] overflow-hidden shrink-0 bg-surface2 relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={x.e.img} className="absolute inset-0 w-full h-full object-cover" alt="" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[12.5px] font-semibold truncate leading-tight">{x.e.name}</span>
                        <span className="block text-[10.5px] text-muted leading-tight">{x.label}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <div className="relative">
                <textarea
                  rows={2}
                  value={g.prompt}
                  maxLength={4000}
                  ref={(el) => { taRef.current = el; fit(el); }}
                  onChange={(e) => {
                    updateDraft(projectId, (d) => { d.prompt = e.target.value; });
                    fit(e.target);
                    const pos = e.target.selectionStart || 0;
                    const mt = e.target.value.slice(0, pos).match(/@([\w-]*)$/);
                    setMention(mt ? { q: mt[1].toLowerCase(), start: pos - mt[0].length, pos } : null);
                  }}
                  placeholder={g.mode === "extend" ? "What happens next: action + camera + mood… (type @ to mention an element)" : "Describe the shot… (type @ to mention an element)"}
                  className="w-full bg-transparent outline-none resize-none text-[13.5px] leading-relaxed px-1 placeholder:text-muted"
                  style={{ overflowY: "hidden" }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && mention) { e.preventDefault(); setMention(null); return; }
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
                  }}
                />
                <SlateBadge
                  tone={g.prompt.length > 3600 ? "pending" : "draft"}
                  className="absolute bottom-1 right-3 tabular-nums transition-opacity hover:opacity-0"
                  tip="Prompt limit: 4000 characters"
                >
                  {(Math.round(g.prompt.length / 100) / 10).toString()}/4k
                </SlateBadge>
              </div>
              <div className="flex gap-2 mt-2 items-center">
                <SlateIconButton
                  size="icon"
                  variant={g.enhance ? "primary" : "ghost"}
                  label={`Enhance prompt ${g.enhance ? "on" : "off"}`}
                  onClick={() => updateDraft(projectId, (d) => { d.enhance = !d.enhance; })}
                >
                  <WandSparkles className="size-4" />
                </SlateIconButton>
                <SlateButton variant="primary" className="flex-1 !h-[38px]" disabled={price == null || submitting} onClick={submit} aria-label="Generate">
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{" "}
                  {submitting ? "Queuing…" : <>Generate <span className="tabular-nums">{price != null ? money(price) : "—"}</span></>}
                </SlateButton>
              </div>
            </div>

            <div className="pt-2">
              <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar max-w-full pb-0.5" aria-label="Generation options">
                <SlateDropdown
                  label={m.label}
                  title={`Model · ${m.label}`}
                  menu={(close) => MODELS.map((x) => (
                    <SlateOption
                      key={x.id}
                      active={g.model === x.id}
                      sub={"preview" in x && x.preview ? "Preview" : "retires" in x && x.retires ? "retires Jun 30" : x.tier}
                      onPick={() => updateDraft(projectId, (d) => {
                        d.model = x.id;
                        const mm = modelOf(x.id);
                        if (!(mm.res as readonly string[]).includes(d.res)) d.res = (mm.res[0] as "720p" | "1080p" | "4K");
                        if (!(mm.dur as readonly number[]).includes(d.dur)) d.dur = mm.dur[mm.dur.length - 1];
                        if ("silent" in mm && mm.silent) d.audio = false;
                      })}
                      onClose={close}
                    >
                      {x.label}
                    </SlateOption>
                  ))}
                />
                <SlateDropdown
                  label={g.res}
                  title="Resolution"
                  menu={(close) => ["720p", "1080p", "4K"].map((r) => {
                    const dis = !(m.res as readonly string[]).includes(r);
                    return (
                      <SlateOption
                        key={r} active={g.res === r} disabled={dis} note={dis ? "N/A" : undefined}
                        onPick={() => updateDraft(projectId, (d) => { d.res = r as "720p" | "1080p" | "4K"; })} onClose={close}
                      >
                        {r}
                      </SlateOption>
                    );
                  })}
                />
                <SlateDropdown
                  label={g.aspect}
                  title="Aspect ratio"
                  menu={(close) => ["16:9", "9:16"].map((r) => (
                    <SlateOption key={r} active={g.aspect === r}
                      onPick={() => updateDraft(projectId, (d) => { d.aspect = r as "16:9" | "9:16"; })} onClose={close}>
                      {r}
                    </SlateOption>
                  ))}
                />
                <SlateDropdown
                  label={`${g.dur}s`}
                  title="Duration"
                  menu={(close) => [4, 5, 6, 7, 8].map((d) => {
                    // 1080p/4K render 8s only (Vertex rejects shorter high-res).
                    const dis = !(m.dur as readonly number[]).includes(d) || (g.mode === "r2v" && d !== 8) || (g.res !== "720p" && d !== 8);
                    return (
                      <SlateOption
                        key={d} active={g.dur === d}
                        disabled={dis} note={dis ? "N/A" : undefined}
                        onPick={() => updateDraft(projectId, (d2) => { d2.dur = d; })} onClose={close}
                      >
                        {d}s
                      </SlateOption>
                    );
                  })}
                />
                <SlateIconButton
                  size="icon-sm"
                  variant={g.audio ? "primary" : "ghost"}
                  label={`Audio ${g.audio ? "on" : "off"}`}
                  disabled={"silent" in m && !!m.silent}
                  onClick={() => updateDraft(projectId, (d) => { d.audio = !d.audio; })}
                >
                  {g.audio ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                </SlateIconButton>
                <SlateDropdown
                  label={`×${g.batch}`}
                  title="Batch count"
                  menu={(close) => [1, 2, 3, 4].map((b) => (
                    <SlateOption key={b} active={g.batch === b} sub={b === 1 ? "single" : `${b} videos`}
                      onPick={() => updateDraft(projectId, (d) => { d.batch = b; })} onClose={close}>
                      ×{b}
                    </SlateOption>
                  ))}
                />
                <SlateIconButton
                  size="icon-sm"
                  variant="ghost"
                  label="Advanced settings"
                  onClick={() => openPicker({ advanced: "1" })}
                >
                  <SlidersHorizontal className="size-3.5" />
                </SlateIconButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
