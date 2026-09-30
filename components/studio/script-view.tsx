"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowRight, Box, ChevronLeft, ChevronRight, CircleCheck, Code, Copy, FileText,
  Flag, MapPin, Plus, RefreshCw, ScrollText, Trash2, TriangleAlert, Upload, UserRound, UsersRound,
} from "lucide-react";
import { api, errOf } from "@/lib/api";
import {
  CHAIN_RISK_META, CHECK_TONE, CONTENT_RISK_META, KIND_META, MODE_META, ROLE_LABEL, mmss, shortName,
  type EntityKindKey, type PreviewFile, type ScriptCall, type ScriptDetail, type ScriptEntity, type ScriptSummary,
} from "@/lib/script";
import { useQueryState } from "@/hooks/use-studio-hooks";
import { pushErr, useToasts } from "@/stores/use-ui";
import { SlateBadge } from "@/components/slate/badge";
import { SlateButton, SlateCloseButton, SlateIconButton } from "@/components/slate/button";
import { PageHead, SlateEmpty, SlateSearchField, SlateSegmented } from "@/components/slate/core";
import { ConfirmDeleteDialog, SlateDialog } from "@/components/slate/overlays";
import { SlateTooltip } from "@/components/slate/tooltip";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "cn";

const KIND_ICON = { C: UserRound, L: MapPin, P: Box, G: UsersRound } as const;
const KIND_TONE = { C: "ok", L: "info", P: "pending", G: "draft" } as const;

const ROW = "flex gap-3 px-4 py-2.5 border-b slate-hair w-full text-left transition-colors hover:bg-surface2 cursor-pointer";
const ROW_SELECTED = { boxShadow: "inset 3px 0 0 #2A8F58" } as const;
const CARD = "slate-card overflow-hidden";
const HEAD = "flex items-center gap-2 px-4 h-12 border-b slate-hair";
const SUB = "flex items-center gap-2 px-4 py-2 bg-surface2 border-b slate-hair text-[12px] text-fg2";

type Tab = "timeline" | "elements" | "files";

/** Entity lookup for pills/links. */
function useEntityMap(detail: ScriptDetail | null): Map<string, ScriptEntity> {
  return useMemo(() => new Map((detail?.entities ?? []).map((e) => [e.id, e])), [detail]);
}

/** Open an inspector Sheet for a call/entity id (state lives in the URL). */
function useOpenSel(set: (p: Record<string, string>) => void): (id: string) => void {
  return useMemo(() => (id: string) => set({ sel: id }), [set]);
}

const SHEET_CLASS = "bg-surface border-l slate-hair p-0 gap-0 focus:outline-none data-[side=right]:w-full data-[side=right]:sm:max-w-[460px]";

export function ScriptView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const push = useToasts((s) => s.push);
  const { state, set } = useQueryState({
    script: "", tab: "timeline", kind: "C", q: "", sel: "", checks: "", add: "", raw: "",
  });
  const [list, setList] = useState<ScriptSummary[] | null>(null);
  const [detail, setDetail] = useState<ScriptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailBusy, setDetailBusy] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ kind: "script" | "file"; id: string; label: string } | null>(null);

  const refreshList = async () => {
    try {
      const { scripts } = await api.listScripts(projectId);
      setList(scripts);
    } catch (e) {
      setLoadErr(errOf(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setList(null);
    setDetail(null);
    setLoading(true);
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Keep the URL-selected script valid: default to the first, heal renames/deletes.
  useEffect(() => {
    if (!list) return;
    if (!state.script || !list.some((s) => s.id === state.script)) {
      if (list.length) set({ script: list[0]?.id ?? "" });
      else if (state.script) set({ script: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);

  useEffect(() => {
    if (!state.script) {
      setDetail(null);
      return;
    }
    let live = true;
    setDetailBusy(true);
    api.getScript(state.script)
      .then((d) => {
        if (live) {
          setDetail(d);
          setLoadErr("");
        }
      })
      .catch((e) => {
        if (live) {
          setDetail(null);
          setLoadErr(errOf(e));
        }
      })
      .finally(() => {
        if (live) setDetailBusy(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.script]);

  const reloadDetail = async (scriptId: string) => {
    try {
      setDetail(await api.getScript(scriptId));
    } catch (e) {
      pushErr(errOf(e));
    }
  };

  const tab = (["timeline", "elements", "files"] as const).includes(state.tab as Tab) ? (state.tab as Tab) : "timeline";
  const flagged = useMemo(
    () => detail?.calls.filter((c) => c.chain_risk !== "none" || c.content_risk !== "none") ?? [],
    [detail],
  );
  const careCount = useMemo(
    () => (detail?.checks.filter((c) => c.severity !== "info").length ?? 0) + flagged.length,
    [detail, flagged],
  );

  if (loading) {
    return (
      <>
        <PageHead title="Script" sub="Continuity packages: locked entities, call-by-call prompts, and machine checks." />
        <div className="slate-card p-5 space-y-3">
          <div className="slate-skeleton h-6 w-1/3" />
          <div className="slate-skeleton h-4 w-full" />
          <div className="slate-skeleton h-4 w-2/3" />
        </div>
      </>
    );
  }

  if (!list?.length) {
    return (
      <>
        <PageHead
          title="Script"
          sub="Continuity packages: locked entities, call-by-call prompts, and machine checks."
          actions={
            <SlateButton variant="primary" onClick={() => set({ add: "1" })}>
              <Plus className="size-3.5" /> Add files
            </SlateButton>
          }
        />
        {loadErr ? (
          <div className="slate-card p-5 text-[13px] text-fg2">{loadErr}</div>
        ) : (
          <SlateEmpty
            icon={<ScrollText className="size-6 text-[#1C7247]" />}
            title="No script files yet"
            sub="Upload or paste a skill-v5 YAML package — bible, shots, calls, or a single file. Duplicates are skipped, updates show a field-level diff."
            action={
              <SlateButton variant="primary" onClick={() => set({ add: "1" })}>
                <Plus className="size-3.5" /> Add script files
              </SlateButton>
            }
          />
        )}
        {state.add === "1" && (
          <AddFilesDialog
            projectId={projectId}
            scriptId=""
            scriptTitle=""
            close={(scriptId) => {
              set({ add: "", ...(scriptId ? { script: scriptId } : {}) });
              void refreshList().then(() => {
                if (scriptId) void reloadDetail(scriptId);
              });
            }}
          />
        )}
      </>
    );
  }

  return (
    <>
      <PageHead
        title={detail?.script.title ?? "Script"}
        sub={detail ? `${detail.totals.calls} calls · ${detail.totals.shots} shots · ${detail.scenes.length} scenes · ${mmss(detail.totals.footageS)}${detail.totals.targetS ? ` · target ${mmss(detail.totals.targetS)}` : ""}` : "Loading package…"}
        actions={
          <>
            {list.length > 1 && (
              <select
                aria-label="Script"
                className="slate-field hidden sm:block w-auto max-w-[220px] !min-h-[34px] !py-0 text-[12.5px] font-semibold"
                value={state.script}
                onChange={(e) => set({ script: e.target.value, sel: "", checks: "" })}
              >
                {list.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            )}
            {careCount > 0 && (
              <button type="button" onClick={() => set({ checks: "1", sel: "" })} className="slate-btn slate-btn-sm slate-btn-ghost !border-[var(--t-pending-fg)]">
                <TriangleAlert className="size-3.5" /> {careCount} need care
              </button>
            )}
            <SlateButton variant="primary" size="sm" onClick={() => set({ add: "1" })}>
              <Plus className="size-3.5" /> Add files
            </SlateButton>
          </>
        }
      />

      <SlateSegmented
        label="Script section"
        className="mb-4"
        scrollable
        options={[
          { id: "timeline", label: "Timeline" },
          { id: "elements", label: "Characters, places & props" },
          { id: "files", label: "Files & guide" },
        ] as const}
        value={tab}
        onChange={(v) => set({ tab: v })}
      />

      {loadErr && !detail ? (
        <div className="slate-card p-5 text-[13px] text-fg2">{loadErr}</div>
      ) : !detail ? (
        <div className="slate-card p-5 space-y-3">
          <div className="slate-skeleton h-6 w-1/3" />
          <div className="slate-skeleton h-4 w-full" />
        </div>
      ) : (
        <>
          {tab === "timeline" && <TimelineTab detail={detail} q={state.q} sel={state.sel} set={set} />}
          {tab === "elements" && <ElementsTab detail={detail} kind={state.kind} sel={state.sel} set={set} />}
          {tab === "files" && (
            <FilesTab
              detail={detail}
              set={set}
              onDeleteFile={(f) => setPendingDelete({ kind: "file", id: f.id, label: f.filename })}
              onDeleteScript={() => detail && setPendingDelete({ kind: "script", id: detail.script.id, label: detail.script.title })}
            />
          )}
        </>
      )}

      {/* Call / element inspector + checks: right Sheets, state in the URL. */}
      <InspectorSheets
        detail={detail}
        sel={state.sel}
        checksOpen={state.checks === "1" && !state.sel}
        flagged={flagged}
        set={set}
      />
      {state.add === "1" && detail && (
        <AddFilesDialog
          projectId={projectId}
          scriptId={detail.script.id}
          scriptTitle={detail.script.title}
          close={(scriptId) => {
            // One URL write: a second set() would rebuild from stale params
            // and resurrect add=1.
            set({ add: "", ...(scriptId ? { script: scriptId } : {}) });
            void refreshList().then(() => {
              void reloadDetail(scriptId ?? detail.script.id);
            });
          }}
        />
      )}
      {state.raw && detail && (
        <RawDialog
          scriptId={detail.script.id}
          fileId={state.raw}
          close={() => set({ raw: "" })}
        />
      )}
      {pendingDelete && (
        <ConfirmDeleteDialog
          title={pendingDelete.kind === "script" ? "Delete script?" : "Delete file?"}
          body={pendingDelete.kind === "script"
            ? `"${pendingDelete.label}" and all its files go away. This cannot be undone.`
            : `"${pendingDelete.label}" goes away. Derived calls and checks rebuild from the remaining files.`}
          action="Delete"
          icon={<Trash2 className="size-3.5" />}
          close={() => setPendingDelete(null)}
          confirm={() => {
            const target = pendingDelete;
            setPendingDelete(null);
            void (async () => {
              try {
                if (target.kind === "script") {
                  await api.deleteScript(target.id);
                  push("Script deleted", { icon: "trash" });
                  set({ script: "" });
                  await refreshList();
                } else if (detail) {
                  await api.deleteScriptFile(detail.script.id, target.id);
                  push("File deleted", { icon: "trash" });
                  await refreshList();
                  // The script may be gone (last file) — detail reload 404s, fall back to list.
                  try {
                    await reloadDetail(detail.script.id);
                  } catch {
                    set({ script: "" });
                  }
                }
              } catch (e) {
                pushErr(errOf(e));
              }
            })();
          }}
        />
      )}
      {detailBusy && <output className="sr-only">Refreshing…</output>}
    </>
  );
}

// ---------- atoms ----------

function EntityPill({ entity, onOpen }: { entity: ScriptEntity; onOpen: (id: string) => void }) {
  const k = entity.id[0] as EntityKindKey;
  const Icon = KIND_ICON[k] ?? Box;
  return (
    <SlateTooltip tip={`${KIND_META[k]?.one ?? "Entity"}: ${entity.name}`}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(entity.id);
        }}
        className={cn("slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold whitespace-nowrap [&_svg]:size-3", `slate-badge-${KIND_TONE[k] ?? "draft"}`)}
      >
        <Icon /> {shortName(entity.name)}
      </button>
    </SlateTooltip>
  );
}

function IdTag({ id, onOpen, current }: { id: string; onOpen: (id: string) => void; current?: boolean }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(id);
      }}
      className={cn(
        "slate-badge slate-badge-draft inline-flex items-center h-[22px] px-2 rounded-full text-[11px] font-mono font-semibold whitespace-nowrap tabular-nums",
        current && "outline-2 outline-[#2A8F58]",
      )}
    >
      {id}
    </button>
  );
}

function ModeTag({ mode }: { mode: string }) {
  const m = MODE_META[mode];
  if (!m) return <span className="slate-badge slate-badge-draft">{mode}</span>;
  return (
    <SlateTooltip tip={m.tip}>
      <span className={cn("slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold whitespace-nowrap", `slate-badge-${m.tone}`)}>
        <span className="w-2 h-2 rounded-full" style={{ background: m.dot, display: "inline-block" }} /> {m.label}
      </span>
    </SlateTooltip>
  );
}

function ChainRiskTag({ risk }: { risk: string }) {
  const r = CHAIN_RISK_META[risk];
  if (!r) return null;
  return (
    <SlateTooltip tip={r.tip}>
      <span className={cn("slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold whitespace-nowrap", `slate-badge-${r.tone}`)}>
        <TriangleAlert className="size-3" /> {risk === "hard_stop" ? "hard stop" : risk}
      </span>
    </SlateTooltip>
  );
}

function ContentRiskTag({ risk }: { risk: string }) {
  const r = CONTENT_RISK_META[risk];
  if (!r) return null;
  return (
    <SlateTooltip tip={r.tip}>
      <span className={cn("slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold whitespace-nowrap", `slate-badge-${r.tone}`)}>
        <TriangleAlert className="size-3" /> {risk === "low_consistency" ? "low consistency" : risk}
      </span>
    </SlateTooltip>
  );
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const push = useToasts((s) => s.push);
  return (
    <SlateButton
      variant="ghost"
      size="sm"
      aria-label={`Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(
          () => push("Copied", { icon: "check" }),
          () => pushErr("Copy failed"),
        );
      }}
    >
      <Copy className="size-3.5" /> Copy
    </SlateButton>
  );
}

/** Inline entity references inside free text (holder paths) become pills. */
function RichText({ text, byId, onOpen }: { text: string; byId: Map<string, ScriptEntity>; onOpen: (id: string) => void }) {
  const parts = text.split(/\b([CLPG]\d+b?)\b/g);
  return (
    <>
      {parts.map((p, i) => {
        const hit = byId.get(p);
        return hit ? <EntityPill key={`${p}-${i}`} entity={hit} onOpen={onOpen} /> : <span key={i}>{p}</span>;
      })}
    </>
  );
}

/** Clickable row (role=button div): rows contain entity pills, and a
 *  <button> cannot nest inside a <button>. */
function Row({ label, selected, onOpen, children, className }: {
  label: string; selected?: boolean; onOpen: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <div
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- rows contain entity-pill <button>s, which cannot nest inside a <button>
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(ROW, selected && "bg-surface2", className)}
      style={selected ? ROW_SELECTED : undefined}
    >
      {children}
    </div>
  );
}

// ---------- Timeline ----------

function TimelineTab({ detail, q, sel, set }: {
  detail: ScriptDetail; q: string; sel: string; set: (p: Record<string, string>) => void;
}) {
  const byId = useEntityMap(detail);
  const open = useOpenSel(set);
  const shotById = useMemo(() => new Map(detail.shots.map((s) => [s.id, s])), [detail]);
  const ql = q.trim().toLowerCase();
  const visible = useMemo(() => {
    const inSet = new Set(
      detail.calls
        .filter((c) => {
          if (!ql) return true;
          const shot = shotById.get(c.shot);
          const names = [shot?.location ?? "", ...c.characters, ...c.props]
            .map((id) => byId.get(id)?.name ?? "").join(" ");
          return `${c.summary} ${c.prompt} ${shot?.beat ?? ""} ${names}`.toLowerCase().includes(ql);
        })
        .map((c) => c.id),
    );
    return inSet;
  }, [detail, ql, byId, shotById]);

  const stat = (v: string, l: string) => (
    <p className="tabular-nums"><span className="font-display font-bold text-[20px]">{v}</span> <span className="text-[12px] text-fg2">{l}</span></p>
  );

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <div className={HEAD}>
          <h2 className="font-display font-bold text-[15px] tracking-[-.01em] truncate min-w-0 flex-1">{detail.script.title}</h2>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <div className="hidden sm:block w-[220px]">
              <SlateSearchField value={q} onChange={(v) => set({ q: v })} placeholder="Find a call, person or place" label="Find a call, person or place" />
            </div>
          </div>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            {stat(mmss(detail.totals.footageS), detail.totals.targetS ? `footage · target ${mmss(detail.totals.targetS)}` : "footage")}
            {stat(String(detail.scenes.length), "scenes")}
            {stat(String(detail.shots.length), "shots")}
            {stat(String(detail.calls.length), "calls")}
          </div>
          <div className="flex gap-[3px] overflow-x-auto no-scrollbar" aria-label="Calls in time order">
            {detail.calls.map((c) => {
              const m = MODE_META[c.mode];
              return (
                <SlateTooltip key={c.id} tip={`${c.id} · ${m?.label ?? c.mode} · +${c.dur}s · ${mmss(c.startS)}–${mmss(c.endS)}`}>
                  <button
                    type="button"
                    aria-label={`Open ${c.id}`}
                    onClick={() => open(c.id)}
                    className={cn("h-7 rounded-full shrink-0 cursor-pointer transition-[filter] hover:brightness-110", sel === c.id && "outline-2 outline-offset-1 outline-[#2A8F58]")}
                    style={{ flexGrow: Math.max(1, c.dur), flexBasis: 0, minWidth: 10, background: m?.dot ?? "#6B7280", opacity: visible.has(c.id) ? 1 : 0.25 }}
                  />
                </SlateTooltip>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg2">
            {Object.entries(MODE_META).map(([k, m]) => (
              <SlateTooltip key={k} tip={m.tip}>
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: m.dot }} /> {m.label}
                </span>
              </SlateTooltip>
            ))}
          </div>
          <div className="sm:hidden">
            <SlateSearchField value={q} onChange={(v) => set({ q: v })} placeholder="Find a call, person or place" label="Find a call, person or place" />
          </div>
        </div>
      </section>

      {detail.scenes.map((sc) => {
        const sceneShots = detail.shots.filter((s) => s.scene === sc.n);
        const bodies = sceneShots.filter((s) => s.callIds.some((id) => visible.has(id)));
        if (!bodies.length) return null;
        const locPill = sceneShots.map((s) => s.location).find((id) => byId.get(id));
        return (
          <section key={sc.n} className={CARD}>
            <div className={HEAD}>
              <h2 className="font-display font-bold text-[15px] tracking-[-.01em] truncate min-w-0">{sc.title}</h2>
              {locPill && byId.get(locPill) && <EntityPill entity={byId.get(locPill) as ScriptEntity} onOpen={open} />}
              <span className="ml-auto text-[12px] text-fg2 tabular-nums shrink-0">{sc.callIds.length} calls · {sc.footageS}s</span>
            </div>
            {bodies.map((shot) => {
              const calls = shot.callIds.map((id) => detail.calls.find((c) => c.id === id)).filter((c): c is ScriptCall => !!c);
              const tone = shot.footageS > 22 ? "#C9432E" : shot.footageS > 20 ? "#B8790E" : "#2A8F58";
              return (
                <div key={shot.id}>
                  <div className={SUB}>
                    <b className="text-fg shrink-0">Shot {shot.id}</b>
                    {shot.beat && <span className="truncate">{shot.beat}</span>}
                    <span className="ml-auto flex items-center gap-2 shrink-0 tabular-nums">
                      {calls.length > 1 && (
                        <SlateTooltip tip={`A ${calls.length}-call chain, ${shot.footageS}s of footage for ${shot.plannedS}s planned.`}>
                          <span className="flex items-center gap-2">
                            {calls.length} calls
                            <span className="h-1.5 rounded-full overflow-hidden" style={{ width: 56, background: "var(--surface-3)" }}>
                              <span className="block h-full" style={{ width: `${Math.min(100, (shot.footageS / 36) * 100)}%`, background: tone }} />
                            </span>
                          </span>
                        </SlateTooltip>
                      )}
                      {calls.length <= 1 && <span>1 call</span>}
                      <span>{shot.footageS}s · {shot.plannedS}s planned</span>
                    </span>
                  </div>
                  <div>
                    {calls.filter((c) => visible.has(c.id)).map((c) => (
                      <Row key={c.id} label={`${c.id} ${mmss(c.startS)} to ${mmss(c.endS)}: ${c.summary}`} selected={sel === c.id} onOpen={() => open(c.id)}>
                        <div className="shrink-0 w-20">
                          <p className="font-mono font-semibold text-[12px] leading-tight">{c.id}</p>
                          <p className="text-[12px] text-fg2 tabular-nums whitespace-nowrap leading-tight mt-0.5">{mmss(c.startS)}–{mmss(c.endS)}</p>
                        </div>
                        <div className="min-w-0 space-y-1.5">
                          <p className="font-semibold text-[13.5px] leading-snug line-clamp-2">{c.summary}</p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                            <ModeTag mode={c.mode} />
                            <span className="text-[12px] text-fg2 font-semibold tabular-nums whitespace-nowrap">+{c.dur}s</span>
                            <ChainRiskTag risk={c.chain_risk} />
                            <ContentRiskTag risk={c.content_risk} />
                            {shot.location && byId.get(shot.location) && <EntityPill entity={byId.get(shot.location) as ScriptEntity} onOpen={open} />}
                            {c.characters.map((id) => byId.get(id) && <EntityPill key={id} entity={byId.get(id) as ScriptEntity} onOpen={open} />)}
                            {c.props.map((id) => byId.get(id) && <EntityPill key={id} entity={byId.get(id) as ScriptEntity} onOpen={open} />)}
                          </div>
                          {c.ends_at && (
                            <p className="text-[12px] text-fg2 line-clamp-2"><Flag className="inline size-3 -mt-0.5" /> Ends: {c.ends_at}</p>
                          )}
                        </div>
                      </Row>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}

      {![...visible].length && (
        <section className={CARD}>
          <div className={HEAD}><h2 className="font-display font-bold text-[15px]">No matches</h2></div>
          <div className="p-4 text-[12px] text-fg2">Clear the search to see every call.</div>
        </section>
      )}
    </div>
  );
}

// ---------- Elements ----------

const KIND_TABS = ["C", "L", "P", "G"] as const;

function ElementsTab({ detail, kind, sel, set }: {
  detail: ScriptDetail; kind: string; sel: string; set: (p: Record<string, string>) => void;
}) {
  const k = (KIND_TABS as readonly string[]).includes(kind) ? (kind as EntityKindKey) : "C";
  const byId = useEntityMap(detail);
  const open = useOpenSel(set);
  const rows = detail.entities.filter((e) => e.id.startsWith(k));
  const Icon = KIND_ICON[k];
  const maxShot = detail.shots.length ? Math.max(...detail.shots.map((s) => s.id)) : 0;

  return (
    <section className={CARD}>
      <SlateSegmented
        label="Entity kind"
        className="m-3 mb-0"
        scrollable
        options={KIND_TABS.map((id) => ({
          id,
          label: `${KIND_META[id].many} · ${detail.entities.filter((e) => e.id.startsWith(id)).length}`,
        }))}
        value={k}
        onChange={(v) => set({ kind: v })}
      />
      <div className={cn(SUB, "mt-3")} style={{ background: "var(--surface)" }}>
        <Icon className="size-3.5" /> {KIND_META[k].hint} Click one for its images and prompts.
      </div>
      <div>
        {rows.map((e) => {
          const used = new Set((detail.index[e.id]?.shots ?? []).concat(e.appearsInShots, e.usedInShots));
          const nShots = used.size;
          const firstLine = (e.identity || e.binding || "").split("\n")[0];
          return (
            <Row key={e.id} label={`${e.name} (${e.id})`} selected={sel === e.id} onOpen={() => open(e.id)} className="flex-wrap items-center">
              <span className={cn("slate-badge grid place-items-center shrink-0 rounded-[9px] [&_svg]:size-5", `slate-badge-${KIND_TONE[k]}`)} style={{ width: 40, height: 40 }}>
                <Icon />
              </span>
              <div className="min-w-0 flex-1" style={{ minWidth: 200 }}>
                <p className="font-semibold">{e.name} <span className="text-[12px] text-fg2 font-mono font-medium">{e.id}</span></p>
                <p className="text-[12px] text-fg2">
                  {KIND_META[k].one}
                  {e.lockVersion != null ? ` · v${e.lockVersion}` : ""}
                  {e.variantOf ? ` · variant of ${e.variantOf}` : ""}
                  {e.adhoc ? " · ad-hoc" : ""}
                  {e.stateChanges ? ` · ${e.stateChanges}` : ""}
                  {e.why ? ` · ${e.why}` : ""}
                </p>
                {firstLine && <p className="text-[12px] text-fg2 truncate">{firstLine}</p>}
                {e.holderPath && (
                  <span className="flex flex-wrap items-center gap-2 mt-2 text-[12px] text-fg2">
                    Held by <RichText text={e.holderPath} byId={byId} onOpen={open} />
                  </span>
                )}
              </div>
              <span className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[12px] text-fg2 mr-1">Shots{nShots ? ` · ${nShots}` : ""}</span>
                {maxShot > 0 && maxShot <= 24 && Array.from({ length: maxShot }, (_, i) => i + 1).map((n) => (
                  <span key={n} className={cn("grid place-items-center w-6 h-6 rounded-full text-[12px] font-semibold tabular-nums", used.has(n) ? `slate-badge-${KIND_TONE[k]} slate-badge` : "text-muted")} style={used.has(n) ? undefined : { background: "var(--surface-3)" }}>
                    {n}
                  </span>
                ))}
              </span>
            </Row>
          );
        })}
        {!rows.length && <div className="p-4 text-[12px] text-fg2">No {KIND_META[k].many.toLowerCase()} in this package.</div>}
      </div>
    </section>
  );
}

// ---------- Files & guide ----------

function FilesTab({ detail, set, onDeleteFile, onDeleteScript }: {
  detail: ScriptDetail; set: (p: Record<string, string>) => void;
  onDeleteFile: (f: { id: string; filename: string }) => void;
  onDeleteScript: () => void;
}) {
  const split = detail.files.length > 1;
  const hasBible = detail.meta != null;
  const crossed = detail.checks.filter((c) => c.code === "chain_split_across_files").length;
  return (
    <div className="space-y-4">
      <section className={CARD}>
        <div className={cn(HEAD, "flex-wrap h-auto min-h-12 py-2")}>
          <h2 className="font-display font-bold text-[15px] tracking-[-.01em] truncate min-w-0 flex-1">Files in this script</h2>
          <div className="ml-auto flex items-center gap-2">
            <SlateButton variant="ghost" size="sm" onClick={() => set({ add: "1" })}>
              <Plus className="size-3.5" /> Add files
            </SlateButton>
            <SlateButton variant="ghost" size="sm" onClick={onDeleteScript} tip="Delete this script and all its files">
              <Trash2 className="size-3.5" /> <span className="hidden sm:inline">Delete script</span>
            </SlateButton>
          </div>
        </div>
        <div>
          {detail.files.map((f) => (
            <div key={f.id} className={cn(ROW, "items-center cursor-default")}>
              <FileText className="size-[18px] text-muted shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[12px] truncate">{f.filename}</p>
                <p className="text-[12px] text-fg2">{f.docs} docs · {f.calls} calls · {f.entities} entities</p>
              </div>
              <SlateBadge tone="info" className="hidden sm:inline-flex">{ROLE_LABEL[f.role] ?? f.role}</SlateBadge>
              <SlateIconButton label="View raw" onClick={() => set({ raw: f.id })}>
                <Code className="size-3.5" />
              </SlateIconButton>
              <SlateIconButton label="Replace via Add files" onClick={() => set({ add: "1" })}>
                <RefreshCw className="size-3.5" />
              </SlateIconButton>
              <SlateIconButton label={`Delete ${f.filename}`} onClick={() => onDeleteFile(f)}>
                <Trash2 className="size-3.5" />
              </SlateIconButton>
            </div>
          ))}
        </div>
        <div className={SUB} style={{ borderBottom: 0 }}>
          <CircleCheck className="size-3.5 text-[#2A8F58]" />
          {split
            ? `Split package: bible ${hasBible ? "✓" : "missing"} · ${detail.files.length} files · ${crossed ? `${crossed} link(s) cross a file` : "no chain crosses a file"}`
            : "Single-file package: bible, entities, shots and calls in one file."}
        </div>
      </section>

      <section className={CARD}>
        <div className={HEAD}><h2 className="font-display font-bold text-[15px] tracking-[-.01em]">How to read this page</h2></div>
        <div className="grid md:grid-cols-2">
          <div className="p-3" style={{ borderBottom: 0 }}>
            {(Object.keys(KIND_META) as EntityKindKey[]).map((kk) => {
              const Icon = KIND_ICON[kk];
              return (
                <div key={kk} className="flex items-start gap-3 py-1.5">
                  <span className="shrink-0 -mt-1">
                    <span className={cn("slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold", `slate-badge-${KIND_TONE[kk]}`)}>
                      <Icon className="size-3" /> {KIND_META[kk].one}
                    </span>
                  </span>
                  <span className="text-[12px] text-fg2 pt-[3px]">{KIND_META[kk].hint}</span>
                </div>
              );
            })}
            <GuideKv k="Shot" v="One moment of the story: planned time, a beat, dialogue lines." />
            <GuideKv k="Call" v="One generation request. A long shot is a chain of calls." />
            <GuideKv k="Line" v="One atomic dialogue line, covered by exactly one call." />
          </div>
          <div className="p-3 md:border-l slate-hair" style={{ borderBottom: 0 }}>
            {Object.entries(MODE_META).map(([m, meta]) => (
              <div key={m} className="flex items-start gap-3 py-1.5">
                <span className="shrink-0 -mt-1"><ModeTag mode={m} /></span>
                <span className="text-[12px] text-fg2 pt-[3px]">{meta.tip}</span>
              </div>
            ))}
            <GuideKv k="chain risk" v="Derived from chain footage: none, monitor (soft cap), hard stop." />
            <GuideKv k="content risk" v="Elevated: hard case. Low consistency: no clean reference fix." />
            <GuideKv k="dur" v="This call's own footage only — never a running total." />
            <GuideKv k="0:15–0:22" v="Where the call sits in the film." />
          </div>
        </div>
      </section>
    </div>
  );
}

function GuideKv({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="shrink-0 font-bold" style={{ width: 88 }}><b>{k}</b></span>
      <span className="text-[12px] text-fg2 pt-[1px]">{v}</span>
    </div>
  );
}

// ---------- Inspectors + checks (right Sheets) ----------

function InspectorSheets({ detail, sel, checksOpen, flagged, set }: {
  detail: ScriptDetail | null; sel: string; checksOpen: boolean; flagged: ScriptCall[];
  set: (p: Record<string, string>) => void;
}) {
  const call = detail?.calls.find((c) => c.id === sel);
  const entity = detail?.entities.find((e) => e.id === sel);
  const close = () => set({ sel: "", checks: "" });
  return (
    <>
      <Sheet open={!!(call || entity)} onOpenChange={(o) => { if (!o) set({ sel: "" }); }}>
        <SheetContent showCloseButton={false} className={SHEET_CLASS}>
          {detail && (call || entity) && (
            call
              ? <CallInspector detail={detail} call={call} set={set} />
              : <ElementInspector detail={detail} entity={entity as ScriptEntity} set={set} />
          )}
        </SheetContent>
      </Sheet>
      <Sheet open={checksOpen} onOpenChange={(o) => { if (!o) set({ checks: "" }); }}>
        <SheetContent showCloseButton={false} className={SHEET_CLASS}>
          <div className="h-14 px-4 flex items-center gap-2 border-b slate-hair shrink-0">
            <span className="font-display font-bold text-[15px]">Needs care</span>
            <SlateCloseButton onClick={close} />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {detail && detail.checks.length === 0 && flagged.length === 0 ? (
              <p className="p-4 text-[13px] text-fg2">All clear — every machine-checkable item passes and no call is flagged.</p>
            ) : (
              <>
                {detail?.checks.map((ch, i) => (
                  <button
                    key={`${ch.code}-${i}`}
                    type="button"
                    aria-label={`${ch.code}: ${ch.message}`}
                    disabled={!ch.callId && !ch.entityId}
                    onClick={() => ch.callId ? set({ sel: ch.callId, checks: "" }) : ch.entityId ? set({ sel: ch.entityId, checks: "" }) : undefined}
                    className={cn(ROW, (!ch.callId && !ch.entityId) && "cursor-default")}
                  >
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <SlateBadge tone={CHECK_TONE[ch.severity]}>{ch.severity}</SlateBadge>
                        {(ch.callId || ch.entityId) && <span className="font-mono text-[12px] font-semibold">{ch.callId ?? ch.entityId}</span>}
                      </div>
                      <p className="text-[13px] leading-snug">{ch.message}</p>
                      <p className="text-[12px] text-fg2 font-mono">{ch.code}</p>
                    </div>
                  </button>
                ))}
                {flagged.length > 0 && (
                  <>
                    <div className={SUB}>Flagged calls</div>
                    {flagged.map((c) => (
                      <button key={c.id} type="button" aria-label={`Open flagged call ${c.id}`} onClick={() => set({ sel: c.id, checks: "" })} className={ROW}>
                        <div className="min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[12px] font-semibold">{c.id}</span>
                            <ChainRiskTag risk={c.chain_risk} />
                            <ContentRiskTag risk={c.content_risk} />
                          </div>
                          <p className="font-semibold text-[13px] leading-snug">{c.summary}</p>
                        </div>
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function SheetHead({ title, extra, onClose }: { title: React.ReactNode; extra?: React.ReactNode; onClose: () => void }) {
  return (
    <div className="h-14 px-4 flex items-center gap-2 border-b slate-hair shrink-0">
      {title}
      <span className="ml-auto flex gap-1 items-center">
        {extra}
        <SlateCloseButton onClick={onClose} className="ml-0" />
      </span>
    </div>
  );
}

function SheetSec({ label, action, children }: { label?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3 border-b slate-hair last:border-b-0">
      {label && (
        <div className="flex items-center justify-between mb-2 min-h-[34px]">
          <p className="text-[12px] font-bold text-fg2">{label}</p>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function CallInspector({ detail, call, set }: { detail: ScriptDetail; call: ScriptCall; set: (p: Record<string, string>) => void }) {
  const byId = useEntityMap(detail);
  const open = useOpenSel(set);
  const idx = detail.calls.findIndex((c) => c.id === call.id);
  const prev = idx > 0 ? detail.calls[idx - 1] : undefined;
  const next = idx < detail.calls.length - 1 ? detail.calls[idx + 1] : undefined;
  const shot = detail.shots.find((s) => s.id === call.shot);
  const chain = detail.calls.filter((c) => c.shot === call.shot).sort((a, b) => a.pos - b.pos);
  const limit = (detail.meta?.model_lock as Record<string, unknown> | undefined)?.max_prompt_chars;
  const maxChars = typeof limit === "number" ? limit : 4000;
  const inCall = [...call.characters, ...call.props].map((id) => byId.get(id)).filter((e): e is ScriptEntity => !!e);
  const loc = shot?.location ? byId.get(shot.location) : undefined;
  const lines = (shot?.lines ?? []).filter((l) => call.dialogue.includes(l.id));

  return (
    <>
      <SheetHead
        onClose={() => set({ sel: "" })}
        title={<><span className="font-mono font-semibold text-[13px]">{call.id}</span><ModeTag mode={call.mode} /><ChainRiskTag risk={call.chain_risk} /><ContentRiskTag risk={call.content_risk} /></>}
        extra={
          <>
            <SlateIconButton label="Previous call" onClick={() => prev && open(prev.id)}>
              <ChevronLeft className="size-3.5" />
            </SlateIconButton>
            <SlateIconButton label="Next call" onClick={() => next && open(next.id)}>
              <ChevronRight className="size-3.5" />
            </SlateIconButton>
          </>
        }
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SheetSec>
          <p className="text-[12px] text-fg2">Scene {shot?.scene ?? "–"} · Shot {call.shot}{shot?.beat ? `: ${shot.beat}` : ""}</p>
          <p className="font-display font-bold text-[20px] leading-snug mt-1">{call.summary}</p>
          <p className="text-[12px] text-fg2 tabular-nums mt-1">
            {mmss(call.startS)} → {mmss(call.endS)} · <b>+{call.dur}s</b> · call {call.pos} of {call.of}
            {shot ? ` · ${shot.plannedS}s planned` : ""}
          </p>
        </SheetSec>
        {(call.of > 1 || call.chained_from || call.seed_from) && (
          <SheetSec label="Chain">
            <div className="flex items-center gap-2 flex-wrap">
              {chain.map((x, j) => (
                <span key={x.id} className="flex items-center gap-2">
                  {j > 0 && <ArrowRight className="size-3.5 text-muted" />}
                  <IdTag id={x.id} onOpen={open} current={x.id === call.id} />
                </span>
              ))}
            </div>
            {call.seed_from && (
              <p className="mt-2 text-[13px]">
                <b>Seed:</b>{" "}
                {byId.get(call.seed_from)
                  ? <EntityPill entity={byId.get(call.seed_from) as ScriptEntity} onOpen={open} />
                  : <span className="font-mono text-[12px]">{call.seed_from}</span>}
              </p>
            )}
            {call.continues_from && <p className="mt-2 text-[13px]"><b>Starts:</b> <span className="text-fg2">{call.continues_from}</span></p>}
            {call.anchor_from && <p className="mt-2 text-[13px]"><b>Anchor:</b> <span className="text-fg2">{call.anchor_from}</span></p>}
            {call.ends_at && <p className="mt-1 text-[13px]"><b>Ends:</b> <span className="text-fg2">{call.ends_at}</span></p>}
          </SheetSec>
        )}
        <SheetSec label="In this call">
          <div className="flex flex-wrap gap-2">
            {loc && <EntityPill entity={loc} onOpen={open} />}
            {inCall.map((e) => <EntityPill key={e.id} entity={e} onOpen={open} />)}
            {!loc && !inCall.length && <span className="text-[12px] text-fg2">Empty room — no locked entity on screen.</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3">
            <span className="text-[12px] text-fg2">Attach</span>
            {call.refs.length
              ? call.refs.map((r, j) => (
                <span key={`${r}-${j}`} className="flex items-center gap-1.5">
                  <span className="grid place-items-center w-6 h-6 rounded-full text-[12px] font-semibold tabular-nums text-muted" style={{ background: "var(--surface-3)" }}>{j + 1}</span>
                  {byId.get(r) ? <EntityPill entity={byId.get(r) as ScriptEntity} onOpen={open} /> : <span className="font-mono text-[12px] text-[#C9432E]">{r} (undefined)</span>}
                </span>
              ))
              : <span className="text-[12px] text-fg2">nothing new, the last frame carries the look</span>}
          </div>
        </SheetSec>
        {lines.length > 0 && (
          <SheetSec label={`Dialogue · ${lines.length} line${lines.length === 1 ? "" : "s"}`}>
            <div className="space-y-2">
              {lines.map((l) => (
                <p key={l.id} className="text-[13px] leading-relaxed">
                  <span className="font-mono text-[12px] text-fg2">{l.id}</span>{" "}
                  <b>{byId.get(l.who)?.name ?? l.who}:</b> <span className="text-fg2">“{l.text}”</span>
                </p>
              ))}
            </div>
          </SheetSec>
        )}
        {call.flags.length > 0 && (
          <SheetSec label="Flags">
            <div className="space-y-1">
              {call.flags.map((f, i) => (
                <p key={i} className="text-[12px] text-fg2 flex gap-1.5"><Flag className="size-3 mt-0.5 shrink-0" />{f}</p>
              ))}
            </div>
          </SheetSec>
        )}
        <SheetSec
          label={
            <>
              Prompt{" "}
              <span className="font-medium tabular-nums">
                · {call.renderedPrompt.length.toLocaleString()} / {maxChars.toLocaleString()}
                {call.renderSource === "actual" ? " · reconciled from log" : ""}
                {call.renderSource === "planned" ? " · filled from plan" : ""}
                {call.renderSource === "missing" ? " · placeholder unfilled" : ""}
              </span>
            </>
          }
          action={<CopyBtn text={call.renderedPrompt} label={`${call.id} prompt`} />}
        >
          <pre className="font-mono text-[12px] leading-relaxed bg-surface2 border slate-hair rounded-[9px] p-3 whitespace-pre-wrap break-words">{call.renderedPrompt}</pre>
        </SheetSec>
        {call.negative_prompt && (
          <SheetSec label="Negative prompt" action={<CopyBtn text={call.negative_prompt} label={`${call.id} negative prompt`} />}>
            <pre className="font-mono text-[12px] leading-relaxed bg-surface2 border slate-hair rounded-[9px] p-3 whitespace-pre-wrap break-words">{call.negative_prompt}</pre>
          </SheetSec>
        )}
      </div>
    </>
  );
}

function ElementInspector({ detail, entity, set }: { detail: ScriptDetail; entity: ScriptEntity; set: (p: Record<string, string>) => void }) {
  const k = entity.id[0] as EntityKindKey;
  const Icon = KIND_ICON[k] ?? Box;
  const byId = useEntityMap(detail);
  const open = useOpenSel(set);
  const entry = detail.index[entity.id];
  const shotIds = [...new Set([...(entry?.shots ?? []), ...entity.appearsInShots, ...entity.usedInShots])].sort((a, b) => a - b);
  const members = entity.contains.map((id) => byId.get(id)).filter((e): e is ScriptEntity => !!e);

  return (
    <>
      <SheetHead
        onClose={() => set({ sel: "" })}
        title={<span className={cn("slate-badge inline-flex items-center gap-[5px] h-[22px] px-2 rounded-full text-[11.5px] font-bold", `slate-badge-${KIND_TONE[k] ?? "draft"}`)}><Icon className="size-3" /> {KIND_META[k]?.one ?? "Entity"}</span>}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SheetSec>
          <div className="flex items-center gap-3">
            <span className={cn("slate-badge grid place-items-center shrink-0 rounded-[9px] [&_svg]:size-6", `slate-badge-${KIND_TONE[k] ?? "draft"}`)} style={{ width: 48, height: 48 }}>
              <Icon />
            </span>
            <div className="min-w-0">
              <p className="font-display font-bold text-[20px] leading-tight">{entity.name}</p>
              <p className="text-[12px] text-fg2">
                {KIND_META[k]?.one} · <span className="font-mono">{entity.id}</span>
                {entity.lockVersion != null ? ` · v${entity.lockVersion}` : ""}
                {entity.variantOf ? ` · variant of ${entity.variantOf}` : ""}
              </p>
            </div>
          </div>
        </SheetSec>
        {entity.identity && (
          <SheetSec label={k === "G" ? "Layout" : "Identity"}>
            <p className="text-[13px] text-fg2 leading-relaxed whitespace-pre-wrap">{entity.identity}</p>
          </SheetSec>
        )}
        {k === "G" && entity.binding && (
          <SheetSec label="Binding">
            <p className="text-[13px] text-fg2 leading-relaxed">{entity.binding}</p>
          </SheetSec>
        )}
        {entity.sideDetail && (
          <SheetSec label="Side detail">
            <p className="text-[13px] text-fg2 leading-relaxed whitespace-pre-wrap">{entity.sideDetail}</p>
          </SheetSec>
        )}
        {(entity.voice || entity.personality) && (
          <SheetSec label="Voice">
            {entity.voice && <p className="text-[13px] text-fg2 leading-relaxed whitespace-pre-wrap">{entity.voice}</p>}
            {entity.personality && <p className="text-[13px] text-fg2 leading-relaxed mt-1">{entity.personality}</p>}
          </SheetSec>
        )}
        {entity.light && (
          <SheetSec label="Light">
            <p className="text-[13px] text-fg2 leading-relaxed whitespace-pre-wrap">{entity.light}</p>
          </SheetSec>
        )}
        {(entity.stateChanges || entity.why) && (
          <SheetSec label="Notes">
            <div className="space-y-1.5 text-[13px]">
              {entity.why && <p><b>Why:</b> <span className="text-fg2">{entity.why}</span></p>}
              {entity.stateChanges && <p><b>State:</b> <span className="text-fg2">{entity.stateChanges}</span></p>}
            </div>
          </SheetSec>
        )}
        {entity.holderPath && (
          <SheetSec label="Held by">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <RichText text={entity.holderPath} byId={byId} onOpen={open} />
            </div>
          </SheetSec>
        )}
        {members.length > 0 && (
          <SheetSec label="Who is in it">
            <div className="flex flex-wrap items-center gap-3">
              {members.map((m, j) => (
                <span key={m.id} className="flex items-center gap-1.5">
                  <span className="grid place-items-center w-6 h-6 rounded-full text-[12px] font-semibold tabular-nums text-muted" style={{ background: "var(--surface-3)" }}>{j + 1}</span>
                  <EntityPill entity={m} onOpen={open} />
                </span>
              ))}
            </div>
          </SheetSec>
        )}
        <SheetSec label={`Appears in ${shotIds.length} shot${shotIds.length === 1 ? "" : "s"}`}>
          {shotIds.length ? shotIds.map((n) => {
            const shot = detail.shots.find((s) => s.id === n);
            const ids = (entry?.calls ?? []).filter((id) => detail.calls.find((c) => c.id === id)?.shot === n);
            return (
              <div key={n} className="flex items-center gap-2 py-1">
                <span className="text-[12px] text-fg2 shrink-0 tabular-nums" style={{ width: 52 }}>Shot {n}</span>
                <span className="text-fg2 truncate flex-1 text-[13px]">{shot ? `Scene ${shot.scene} · ${mmss(shot.startS)}–${mmss(shot.endS)}` : ""}</span>
                <span className="flex gap-1 shrink-0 flex-wrap justify-end">
                  {ids.map((id) => <IdTag key={id} id={id} onOpen={open} />)}
                </span>
              </div>
            );
          }) : <p className="text-[12px] text-fg2">Not used yet.</p>}
        </SheetSec>
        {entity.imagePrompt && (
          <SheetSec label="Image prompt" action={<CopyBtn text={entity.imagePrompt} label={`${entity.id} image prompt`} />}>
            <pre className="font-mono text-[12px] leading-relaxed bg-surface2 border slate-hair rounded-[9px] p-3 whitespace-pre-wrap break-words">{entity.imagePrompt}</pre>
          </SheetSec>
        )}
        {entity.negativePrompt && (
          <SheetSec label="Negative prompt" action={<CopyBtn text={entity.negativePrompt} label={`${entity.id} negative prompt`} />}>
            <pre className="font-mono text-[12px] leading-relaxed bg-surface2 border slate-hair rounded-[9px] p-3 whitespace-pre-wrap break-words">{entity.negativePrompt}</pre>
          </SheetSec>
        )}
      </div>
    </>
  );
}

// ---------- Add-files dialog ----------

function AddFilesDialog({ projectId, scriptId, scriptTitle, close }: {
  projectId: string; scriptId: string; scriptTitle: string; close: (scriptId: string | null) => void;
}) {
  const push = useToasts((s) => s.push);
  const [mode, setMode] = useState<"upload" | "paste">("upload");
  const [staged, setStaged] = useState<{ filename: string; text: string }[]>([]);
  const [paste, setPaste] = useState("");
  const [preview, setPreview] = useState<PreviewFile[] | null>(null);
  // Decisions follow staged order (preview[i] classifies staged[i]).
  const [decisions, setDecisions] = useState<Record<number, { action: "add" | "replace" | "skip"; targetFileId?: string }>>({});
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const addTexts = (files: File[]) => {
    void (async () => {
      const next = [...staged];
      for (const f of files.slice(0, 12 - next.length)) {
        try {
          const text = await f.text();
          next.push({ filename: f.name || `upload-${next.length + 1}.yaml`, text });
        } catch {
          pushErr(`Could not read ${f.name}`);
        }
      }
      setStaged(next);
    })();
  };

  const addPaste = () => {
    if (!paste.trim()) return;
    seq.current += 1;
    setStaged([...staged, { filename: `pasted-${seq.current}.yaml`, text: paste }]);
    setPaste("");
    setMode("upload");
  };

  const check = async () => {
    if (!staged.length) return;
    setBusy(true);
    try {
      const { files } = await api.previewScripts(projectId, { files: staged }, scriptId || undefined);
      setPreview(files);
      const d: typeof decisions = {};
      files.forEach((f, i) => {
        if (f.status === "update") d[i] = { action: "replace", targetFileId: f.match?.fileId };
        else if (f.status === "new") d[i] = { action: "add" };
        else d[i] = { action: "skip" };
      });
      setDecisions(d);
    } catch (e) {
      pushErr(errOf(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const files = preview.map((f, i) => {
        const st = staged[i] as { filename: string; text: string };
        const dec = decisions[i] ?? { action: "skip" as const };
        return { filename: st.filename, text: st.text, action: dec.action, ...(dec.targetFileId ? { targetFileId: dec.targetFileId } : {}) };
      });
      const { scriptId: sid, applied } = await api.commitScripts(projectId, { ...(scriptId ? { scriptId } : {}), files });
      const n = applied.added + applied.replaced;
      push(n ? `${n} change${n === 1 ? "" : "s"} applied` : "Nothing to apply — all skipped", { icon: n ? "check" : undefined });
      close(sid);
    } catch (e) {
      pushErr(errOf(e));
    } finally {
      setBusy(false);
    }
  };

  const statusTone = (s: PreviewFile["status"]): "ok" | "pending" | "info" | "danger" =>
    s === "duplicate" ? "ok" : s === "update" ? "pending" : s === "new" ? "info" : "danger";
  const applyCount = preview?.filter((f, i) => (decisions[i]?.action ?? "skip") !== "skip" && f.status !== "invalid").length ?? 0;

  return (
    <SlateDialog
      onClose={() => close(null)}
      header={
        <>
          <span className="text-[14px] font-bold">{preview ? `Review ${preview.length} file${preview.length === 1 ? "" : "s"}` : "Add script files"}</span>
          {scriptTitle && <span className="text-[12px] text-fg2 truncate">→ {scriptTitle}</span>}
          <SlateCloseButton onClick={() => close(null)} />
        </>
      }
      footer={preview ? (
        <>
          <span className="text-[12px] text-fg2 mr-auto">Nothing is saved until you apply.</span>
          <SlateButton variant="ghost" onClick={() => { setPreview(null); }}>Back</SlateButton>
          <SlateButton variant="primary" disabled={busy || !applyCount} onClick={apply}>
            {busy ? "Applying…" : `Apply ${applyCount} change${applyCount === 1 ? "" : "s"}`}
          </SlateButton>
        </>
      ) : undefined}
    >
      {!preview ? (
        <div className="space-y-3">
          <SlateSegmented
            label="Add method"
            options={[{ id: "upload", label: "Upload" }, { id: "paste", label: "Paste" }] as const}
            value={mode}
            onChange={setMode}
          />
          {mode === "upload" ? (
            <label className="slate-card slate-upload-card p-3 grid place-items-center gap-1 py-10 cursor-pointer hover:border-[#3FA96D] transition-colors text-center">
              <Upload className="size-6" />
              <span className="block text-[13px] font-bold">Drop YAML files here</span>
              <span className="block text-[11.5px] text-muted">or click to choose. We detect the file type for you.</span>
              <input
                type="file"
                accept=".yaml,.yml,.txt"
                multiple
                className="hidden"
                onChange={(e) => {
                  const fs = [...(e.target.files ?? [])];
                  if (fs.length) addTexts(fs);
                  e.target.value = "";
                }}
              />
            </label>
          ) : (
            <div className="space-y-3">
              <textarea
                className="slate-field font-mono !text-[12px]"
                style={{ height: "auto", padding: 10, resize: "vertical" }}
                rows={9}
                placeholder="Paste raw YAML here"
                aria-label="Paste raw YAML here"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
              <div className="flex justify-end">
                <SlateButton variant="ghost" size="sm" disabled={!paste.trim()} onClick={addPaste}>
                  <Plus className="size-3.5" /> Stage paste
                </SlateButton>
              </div>
            </div>
          )}
          {!!staged.length && (
            <div className="space-y-1.5">
              {staged.map((s, i) => (
                <div key={`${s.filename}-${i}`} className="flex items-center gap-2 text-[12.5px]">
                  <FileText className="size-4 text-muted shrink-0" />
                  <span className="font-mono truncate flex-1">{s.filename}</span>
                  <span className="text-muted tabular-nums">{(s.text.length / 1024).toFixed(1)} KB</span>
                  <SlateIconButton label={`Remove ${s.filename}`} size="icon-2xs" onClick={() => setStaged(staged.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3" />
                  </SlateIconButton>
                </div>
              ))}
              <div className="flex justify-end pt-1">
                <SlateButton variant="primary" disabled={busy} onClick={check}>
                  {busy ? "Checking…" : `Check ${staged.length} file${staged.length === 1 ? "" : "s"}`}
                </SlateButton>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {preview.map((f, i) => {
            const dec = decisions[i] ?? { action: "skip" as const };
            return (
              <div key={`${f.filename}-${i}`} className="slate-card p-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono truncate text-[12px]">{f.filename}</span>
                  {f.role && <SlateBadge tone="draft">{ROLE_LABEL[f.role] ?? f.role}</SlateBadge>}
                  <SlateBadge tone={statusTone(f.status)} className="ml-auto">{f.status === "update" ? `Update${f.match?.shared ? ` · ${f.match.shared}%` : ""}` : f.status[0]?.toUpperCase() + f.status.slice(1)}</SlateBadge>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-[12px] text-fg2 flex-1">
                    {f.status === "invalid" && f.error && `Doc ${f.error.doc}: ${f.error.message}`}
                    {f.status === "duplicate" && `Identical to ${f.match?.filename} (${f.match?.kind} match) — skipped.`}
                    {f.status === "update" && changeSummary(f)}
                    {f.status === "new" && `${f.docCount ?? 0} docs — new file.`}
                  </p>
                  {f.status !== "invalid" && (
                    <select
                      aria-label={`Action for ${f.filename}`}
                      className="slate-field !min-h-[34px] !py-0 text-[12.5px] font-semibold"
                      style={{ width: 120 }}
                      value={dec.action}
                      onChange={(e) => setDecisions({ ...decisions, [i]: { action: e.target.value as "add" | "replace" | "skip", targetFileId: f.match?.fileId } })}
                    >
                      {f.status === "update" && <option value="replace">Replace</option>}
                      <option value="add">{f.status === "update" ? "Add as new" : "Add"}</option>
                      <option value="skip">Skip</option>
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SlateDialog>
  );
}

function changeSummary(f: PreviewFile): string {
  const changes = f.changes ?? [];
  const added = changes.filter((c) => c.added).length;
  const removed = changes.filter((c) => c.removed).length;
  const edited = changes.filter((c) => !c.added && !c.removed);
  const head = edited.slice(0, 3).map((c) => `${shortKey(c.key)} · ${c.fields.join(", ")}`).join("; ");
  const parts = [];
  if (edited.length) parts.push(`${edited.length} changed${head ? `: ${head}` : ""}`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.join(" · ") || "No field changes";
}

function shortKey(key: string): string {
  if (key === "package_meta:meta") return "bible";
  if (key.startsWith("chunk_header:")) return key.replace("chunk_header:", "chunk ");
  if (key.startsWith("asset_log:")) return key.replace("asset_log:", "asset log ");
  if (key.startsWith("call_log:")) return key.replace("call_log:", "call log ");
  if (key.startsWith("shot:")) return key.replace("shot:", "Shot ");
  const i = key.indexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

// ---------- Raw file dialog ----------

function RawDialog({ scriptId, fileId, close }: { scriptId: string; fileId: string; close: () => void }) {
  const [raw, setRaw] = useState<{ filename: string; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    api.getScriptRaw(scriptId, fileId).then((r) => {
      if (live) setRaw(r);
    }).catch((e) => {
      if (live) pushErr(errOf(e));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptId, fileId]);
  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <Code className="size-4 text-muted" />
          <span className="text-[14px] font-bold font-mono truncate">{raw?.filename ?? "…"}</span>
          <SlateCloseButton onClick={close} />
        </>
      }
      footer={raw ? <span className="ml-auto"><CopyBtn text={raw.text} label="raw file" /></span> : undefined}
    >
      {raw ? (
        <pre className="font-mono text-[12px] leading-relaxed bg-surface2 border slate-hair rounded-[9px] p-3 whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto">{raw.text}</pre>
      ) : (
        <div className="slate-skeleton h-24 w-full" />
      )}
    </SlateDialog>
  );
}
