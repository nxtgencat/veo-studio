"use client";

import { create } from "zustand";
import { blankGen, blankProject, seedStudio } from "@/mock/studio.mock";
import { SAMPLE_VIDEOS } from "@/mock/catalog.mock";
import { clamp, pic, uid } from "@/lib/format";
import { modelOf, priceFor, rateFor } from "@/lib/pricing";
import type { ElementCat, GenDraft, Project, VideoItem } from "@/lib/schemas";

const LS = "aivs-state-v1";

function cloneProject(q: Project): Project {
  return {
    ...q,
    gen: { ...q.gen, refs: [...(q.gen.refs || [])] },
    library: q.library.map((v) => ({
      ...v,
      inputs: v.inputs
        ? { ...v.inputs, refs: v.inputs.refs ? [...v.inputs.refs] : v.inputs.refs }
        : {},
      youtube: v.youtube ? { ...v.youtube } : undefined,
    })),
    elements: {
      characters: [...q.elements.characters],
      locations: [...q.elements.locations],
      assets: [...q.elements.assets],
      frames: [...q.elements.frames],
    },
    settings: { ...q.settings },
  };
}

function loadInitial(): { projects: Project[]; activeId: string | null } {
  if (typeof window === "undefined") return seedStudio();
  try {
    const raw = localStorage.getItem(LS);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.projects)) {
        for (const p of d.projects) {
          p.settings = p.settings ?? {};
          if (p.settings.ytClientId == null) p.settings.ytClientId = "";
          if (!p.settings.ytPrivacy) p.settings.ytPrivacy = "unlisted";
          if (!p.settings.ytCategory) p.settings.ytCategory = "22";
          for (const v of p.library ?? []) {
            if (v.imported && v.url && String(v.url).startsWith("blob:")) v.url = "";
          }
        }
        return { projects: d.projects, activeId: d.activeId ?? d.projects[0]?.id ?? null };
      }
    }
  } catch { /* seed fallback */ }
  return seedStudio();
}

function persist(projects: Project[], activeId: string | null) {
  try {
    localStorage.setItem(LS, JSON.stringify({ projects, activeId }));
  } catch { /* quota — ignore */ }
}

interface StudioState {
  projects: Project[];
  activeId: string | null;
  hydrated: boolean;
  hydrate: () => void;
  activeProject: () => Project | undefined;
  updateActive: (fn: (draft: Project) => void) => { ok: boolean; error?: string };
  queueGeneration: () => { ok: boolean; error?: string; count?: number };
  tickRenders: () => void;
  importVideo: (v: VideoItem) => void;
  deleteVideo: (id: string) => void;
  createProject: (name: string) => string;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  setActiveId: (id: string | null) => void;
  attachElement: (cat: ElementCat, img: string) => void;
}

export const useStudio = create<StudioState>()((set, get) => ({
  projects: [],
  activeId: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const init = loadInitial();
    set({ ...init, hydrated: true });
  },

  activeProject: () => {
    const { projects, activeId } = get();
    return projects.find((x) => x.id === activeId) ?? projects[0];
  },

  updateActive: (fn) => {
    const { projects, activeId } = get();
    if (!activeId) return { ok: false, error: "No active project." };
    const next = projects.map((q) => (q.id === activeId ? cloneProject(q) : q));
    const target = next.find((x) => x.id === activeId);
    if (!target) return { ok: false, error: "Project not found." };
    fn(target);
    // Normalize draft constraints (mirrors reference auto-fix behavior)
    const m = modelOf(target.gen.model);
    const resList = (m.res ?? []) as readonly string[];
    const durList = (m.dur ?? []) as readonly number[];
    if (!resList.includes(target.gen.res)) target.gen.res = (resList[0] ?? "720p") as GenDraft["res"];
    if (!durList.includes(target.gen.dur)) target.gen.dur = durList[durList.length - 1] ?? 8;
    if (target.gen.mode === "r2v") target.gen.dur = 8;
    if ("silent" in m && m.silent) target.gen.audio = false;
    set({ projects: next });
    persist(next, activeId);
    return { ok: true };
  },

  queueGeneration: () => {
    const p = get().activeProject();
    if (!p) return { ok: false, error: "No active project." };
    const g = p.gen;
    const m = modelOf(g.model);
    // Inline validation (same rules as lib/pricing.validateGen, kept here to avoid extra import cycle)
    if (!g.prompt.trim()) return { ok: false, error: "Write a prompt first." };
    if (g.mode === "i2v" && !g.image) return { ok: false, error: "Image mode needs 1 image." };
    if (g.mode === "frames" && (!g.first || !g.last)) return { ok: false, error: "Frames mode needs first + last frame." };
    if (g.mode === "r2v") {
      if (!("ref" in m && m.ref)) return { ok: false, error: `${m.label} has no reference mode.` };
      if (!g.refs.filter(Boolean).length) return { ok: false, error: "Reference mode needs 1–3 reference images." };
    }
    if (g.mode === "extend") {
      if (!("ext" in m && m.ext)) return { ok: false, error: `${m.label} cannot extend.` };
      if (!g.extendVideo) return { ok: false, error: "Pick a source video." };
      const s = p.library.find((x) => x.id === g.extendVideo);
      if (!s) return { ok: false, error: "Source video is gone — pick another." };
      if (!s.url) return { ok: false, error: "Source file is gone after reload — re-upload it." };
      if (s.dur > 30) return { ok: false, error: `Source is ${s.dur}s — Extend inputs must be ≤ 30s.` };
    }
    if (g.mode === "frames" && !("flf" in m && m.flf)) return { ok: false, error: `${m.label} has no frames mode.` };

    const unit = priceFor(g.model, g.res, g.dur, g.audio, 1);
    let count = 0;
    get().updateActive((draft) => {
      for (let i = 0; i < g.batch; i++) {
        const dur = g.mode === "extend" ? 7 : g.dur;
        const audio = "silent" in m && m.silent ? false : g.audio;
        const v: VideoItem = {
          id: uid("vid"), mode: g.mode, prompt: g.prompt.trim(), model: g.model,
          res: g.res, aspect: g.aspect, dur, audio,
          seed: g.seed === "" ? "" : Number(g.seed), person: g.person, enhance: g.enhance, batch: g.batch,
          status: "pending", progress: 5, createdAt: Date.now(), thumb: "", url: "", error: "",
          cost: g.mode === "extend" ? (rateFor(g.model, g.res, audio) || 0) * 7 : unit || 0,
          inputs: {
            image: g.image || undefined, first: g.first || undefined, last: g.last || undefined,
            refs: g.refs.filter(Boolean).slice().length ? g.refs.filter(Boolean).slice() : undefined,
            extendVideo: g.extendVideo || undefined,
          },
        };
        v.thumb = v.inputs.image || v.inputs.first || (v.inputs.refs || [])[0] || pic(v.id, 640, 360);
        if (g.mode === "extend") {
          const s = draft.library.find((x) => x.id === g.extendVideo);
          if (s) v.thumb = s.thumb;
        }
        draft.library.unshift(v);
        count++;
      }
    });
    return { ok: true, count };
  },

  tickRenders: () => {
    const { projects, activeId } = get();
    let changed = false;
    const next = projects.map((q) => ({
      ...q,
      library: q.library.map((v) => {
        if (v.status !== "pending") return v;
        changed = true;
        const pr = clamp((v.progress || 5) + 7 + Math.random() * 10, 5, 97);
        if (pr >= 97) {
          const fail = Math.random() < 0.08;
          return {
            ...v, progress: 100, status: (fail ? "failed" : "success") as VideoItem["status"],
            cost: fail ? 0 : v.cost,
            url: fail ? "" : v.url || SAMPLE_VIDEOS[Math.floor(Math.random() * SAMPLE_VIDEOS.length)],
            error: fail ? "RESOURCE_EXHAUSTED: quota exceeded. Retry with backoff." : "",
          };
        }
        return { ...v, progress: Math.round(pr) };
      }),
    }));
    if (!changed) return;
    set({ projects: next });
    persist(next, activeId);
  },

  importVideo: (v) => {
    get().updateActive((draft) => {
      draft.library.unshift(v);
    });
  },

  deleteVideo: (id) => {
    get().updateActive((draft) => {
      draft.library = draft.library.filter((x) => x.id !== id);
    });
  },

  createProject: (name) => {
    const q = blankProject(name.trim() || "Project");
    // Preserve current gen defaults shape
    q.gen = blankGen();
    const next = [q, ...get().projects];
    set({ projects: next, activeId: q.id });
    persist(next, q.id);
    return q.id;
  },

  renameProject: (id, name) => {
    const next = get().projects.map((x) => (x.id === id ? { ...x, name } : x));
    set({ projects: next });
    persist(next, get().activeId);
  },

  deleteProject: (id) => {
    const projects = get().projects.filter((x) => x.id !== id);
    const activeId = get().activeId === id ? (projects[0]?.id ?? null) : get().activeId;
    set({ projects, activeId });
    persist(projects, activeId);
  },

  setActiveId: (id) => {
    set({ activeId: id });
    persist(get().projects, id);
  },

  attachElement: (cat, img) => {
    get().updateActive((draft) => {
      const g = draft.gen;
      if (cat === "frames") {
        if (!g.first) g.first = img;
        else if (!g.last) g.last = img;
        else { g.first = g.last; g.last = img; }
        return;
      }
      const m = modelOf(g.model);
      if (!("ref" in m && m.ref)) g.model = "veo-3.1-fast-generate-001";
      g.mode = "r2v";
      const r = g.refs.filter(Boolean);
      if (r.length < 3 && !r.includes(img)) r.push(img);
      g.refs = r.slice(0, 3);
      g.dur = 8;
    });
  },
}));
