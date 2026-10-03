"use client";

import { create } from "zustand";
import { api, apiBase, authedMediaUrl, errOf, getAuthToken, onUnauthorized, setAuthToken } from "@/lib/api";
import type { Capabilities, ServerElement, ServerJob, ServerSettings, ServerVideo } from "@/lib/api";
import { modelOf, setCapabilities, validateGen } from "@/lib/pricing";
import { expectedDur } from "@/lib/format";
import { imageDims } from "@/lib/media";
import { buildLibrary } from "@/lib/derive";
import type { ElementCat, GenDraft, Project } from "@/lib/schemas";

// ---------- local overlays (composer drafts, settings, youtube) ----------
// Drafts live in their own store so every keystroke re-renders ONLY the
// composer — never the library, sidebar, or any other view.
const LS = "veo-web-v1";

interface LocalOverlays {
  activeId: string | null;
  drafts: Record<string, GenDraft>;
  settings: Record<string, Project["settings"]>;
  youtube: Record<string, NonNullable<Project["library"][number]["youtube"]>>;
}

export function defaultGen(): GenDraft {
  return {
    mode: "t2v",
    model: "veo-3.1-fast-generate-001",
    res: "1080p",
    aspect: "16:9",
    dur: 8,
    audio: true,
    batch: 1,
    seed: "",
    person: "allow_adult",
    enhance: true,
    negativePrompt: "",
    prompt: "",
    image: "",
    first: "",
    last: "",
    refs: [],
    extendVideo: "",
  };
}

function defaultSettings(): Project["settings"] {
  return {
    saJson: "",
    bucket: "",
    useBucket: true,
    authMode: "service_account",
    ytClientId: "",
    ytPrivacy: "unlisted",
    ytCategory: "22",
  };
}

function loadLocal(): LocalOverlays {
  const empty: LocalOverlays = { activeId: null, drafts: {}, settings: {}, youtube: {} };
  if (typeof window === "undefined") return empty;
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return empty;
    const d = JSON.parse(raw) as Partial<LocalOverlays>;
    return {
      activeId: typeof d.activeId === "string" ? d.activeId : null,
      drafts: d.drafts && typeof d.drafts === "object" ? d.drafts : {},
      settings: d.settings && typeof d.settings === "object" ? d.settings : {},
      youtube: d.youtube && typeof d.youtube === "object" ? d.youtube : {},
    };
  } catch {
    return empty;
  }
}

function saveLocal(o: LocalOverlays) {
  try {
    localStorage.setItem(LS, JSON.stringify(o));
  } catch { /* quota — ignore */ }
}

// ---------- shared local-overlay helpers (module scope, both stores use them) ----------
const local = loadLocal();
const persist = () => saveLocal(local);
// Throttled writes: drafts can hold multi-MB image data URLs — stringifying
// on every keystroke blocked the main thread. First change writes through,
// bursts get 1 write/500ms.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersist = 0;
function schedulePersist() {
  const now = Date.now();
  if (now - lastPersist > 500) {
    lastPersist = now;
    persist();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    lastPersist = Date.now();
    persist();
  }, 500);
}

// ---------- composer store: drafts + youtube state, nothing else ----------
interface ComposerState {
  drafts: Record<string, GenDraft>;
  youtube: LocalOverlays["youtube"];
  settings: LocalOverlays["settings"];
  gen: (projectId: string) => GenDraft;
  updateDraft: (projectId: string, fn: (draft: GenDraft) => void) => { ok: boolean; error?: string };
  setDraft: (projectId: string, gen: GenDraft) => void;
  setYoutube: (videoId: string, patch: Record<string, unknown>) => void;
  dropProject: (projectId: string) => void;
}

export const useComposer = create<ComposerState>()((set, get) => ({
  drafts: local.drafts,
  youtube: local.youtube,
  settings: local.settings,

  gen: (projectId: string) => get().drafts[projectId] ?? defaultGen(),

  updateDraft: (projectId, fn) => {
    const current = get().drafts[projectId] ?? defaultGen();
    const draft: GenDraft = { ...current, refs: [...(current.refs || [])] };
    fn(draft);
    // Mode switch drops other modes' slots: they're invisible in the
    // composer, so stale values must never block the next Generate.
    // Advanced settings reset too — a seed / person rule / negative tuned
    // for one mode must not leak silently into another.
    if (draft.mode !== current.mode) {
      if (draft.mode !== "i2v") draft.image = "";
      if (draft.mode !== "frames") {
        draft.first = "";
        draft.last = "";
      }
      if (draft.mode !== "r2v") draft.refs = [];
      if (draft.mode !== "extend") draft.extendVideo = "";
      draft.seed = "";
      draft.person = "allow_adult";
      draft.negativePrompt = "";
    }
    const m = modelOf(draft.model);
    const resList = m.res;
    const durList = m.dur;
    if (!resList.includes(draft.res)) draft.res = (resList[0] ?? "720p") as GenDraft["res"];
    if (!durList.includes(draft.dur)) draft.dur = durList[durList.length - 1] ?? 8;
    // 1080p/4K render 8s only — snap when the resolution demands it.
    if (draft.res !== "720p" && draft.dur !== 8) draft.dur = 8;
    if (draft.mode === "r2v") draft.dur = 8;
    if (m.silent) draft.audio = false;
    local.drafts[projectId] = draft;
    schedulePersist();
    set({ drafts: { ...get().drafts, [projectId]: draft } });
    return { ok: true };
  },

  setDraft: (projectId, gen) => {
    local.drafts[projectId] = gen;
    schedulePersist();
    set({ drafts: { ...get().drafts, [projectId]: gen } });
  },

  setYoutube: (videoId, patch) => {
    const next = { ...(local.youtube[videoId] ?? {}), ...patch };
    local.youtube[videoId] = next;
    schedulePersist();
    set({ youtube: { ...get().youtube, [videoId]: next } });
  },

  dropProject: (projectId: string) => {
    delete local.drafts[projectId];
    delete local.settings[projectId];
    persist();
    const drafts = { ...get().drafts };
    const settings = { ...get().settings };
    delete drafts[projectId];
    delete settings[projectId];
    set({ drafts, settings });
  },
}));

// ---------- poll change detection: only fields the UI renders ----------
function sameJobRow(a: ServerJob, b: ServerJob): boolean {
  return (
    a.id === b.id && a.status === b.status && a.progress === b.progress &&
    a.error === b.error && a.costEstimate === b.costEstimate &&
    a.elapsedMs === b.elapsedMs && a.etaMs === b.etaMs &&
    a.updatedAt === b.updatedAt
  );
}

// Thumb data URLs can be ~100KB — compare length + updated_at, O(1) per row.
function sameLibraryRow(a: ServerVideo, b: ServerVideo): boolean {
  return (
    a.id === b.id && a.updated_at === b.updated_at &&
    a.video_url === b.video_url && a.thumb_url.length === b.thumb_url.length &&
    a.bytes === b.bytes && a.cost_estimate === b.cost_estimate &&
    a.actual_duration_seconds === b.actual_duration_seconds
  );
}

function rowsSame<T extends { id: string }>(prev: T[], next: T[], same: (a: T, b: T) => boolean): boolean {
  if (prev.length !== next.length) return false;
  const byId = new Map(next.map((r) => [r.id, r]));
  return prev.every((r) => {
    const n = byId.get(r.id);
    return n !== undefined && same(r, n);
  });
}

// ---------- server store: raw rows only, never derived view models ----------
export interface SrvProject { id: string; name: string; createdAt: number }

interface StudioState {
  projects: SrvProject[];
  settings: Record<string, ServerSettings>;
  elements: ServerElement[];
  videos: ServerVideo[];
  jobs: ServerJob[];
  caps: Capabilities | null;
  capsReady: boolean;
  serverUp: boolean;
  lastError: string;
  activeId: string | null;
  hydrated: boolean;
  authRequired: boolean;
  totals: {
    projects: number; videos: number; delivered: number; spend: number;
    byProject: { projectId: string; videos: number; spend: number }[];
  } | null;
  login: (password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  serverSettings: (projectId: string) => ServerSettings | undefined;
  hydrate: () => Promise<void>;
  retry: () => Promise<void>;
  reloadProjects: () => Promise<void>;
  ensureProject: (projectId: string) => Promise<void>;
  refreshProject: () => Promise<void>;
  pollTick: () => Promise<void>;
  createProject: (name: string) => Promise<string>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setActiveId: (id: string | null) => void;
  queueGeneration: (projectId: string) => Promise<{ ok: boolean; error?: string; count?: number }>;
  importVideo: (projectId: string, a: { prompt: string; res: string; aspect: string; dur: number; thumbDataUrl: string; mediaId?: string }) => Promise<{ ok: boolean; error?: string; id?: string }>;
  deleteVideo: (id: string) => Promise<void>;
  attachElement: (projectId: string, cat: ElementCat, img: string) => void;
  loadIntoComposer: (projectId: string, videoId: string) => { ok: boolean; error?: string; missing?: string[] };
  addElement: (projectId: string, cat: ElementCat, data: { name: string; imageUrl: string; note: string }) => Promise<{ ok: boolean; error?: string }>;
  renameElement: (id: string, data: { name: string; note: string }) => Promise<{ ok: boolean; error?: string }>;
  deleteElement: (id: string) => Promise<void>;
  saveSettings: (patch: Partial<Project["settings"]>) => Promise<void>;
}

export const useStudio = create<StudioState>()((set, get) => {
  const loaded = new Set<string>();
  // In-flight hydrate promise: never run two hydrates concurrently
  // (StrictMode double-effects / retries would each auto-create projects).
  let hydrating: Promise<void> | null = null;
  let polling = false;
  let backfilling = false;

  async function fetchProject(projectId: string) {
    const [els, libs, jobs, cfgResp, totals] = await Promise.all([
      api.listElements(projectId),
      api.listLibrary(projectId),
      api.listJobs(projectId),
      api.getSettings(projectId),
      api.stats().catch(() => null),
    ]);
    const s = get();
    const prevCfg = s.settings[projectId];
    const cfg: ServerSettings = {
      ...cfgResp,
      bucketLocation: cfgResp.bucketLocation ?? prevCfg?.bucketLocation ?? null,
    };
    set({
      elements: [...s.elements.filter((e) => e.project_id !== projectId), ...els.elements],
      videos: [...s.videos.filter((v) => v.project_id !== projectId), ...libs.videos],
      jobs: [...s.jobs.filter((j) => j.projectId !== projectId), ...jobs.jobs],
      settings: { ...s.settings, [projectId]: cfg },
      ...(totals ? { totals } : {}),
    });
    loaded.add(projectId);
    // Thumbnail capture needs video decode + canvas on the main thread —
    // never inside the fetch critical path.
    const run = () => {
      void backfillThumbs(projectId).catch(() => {});
    };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(run, { timeout: 8000 });
    else setTimeout(run, 2000);
  }

  // Capture real thumbnails for succeeded videos missing them. Browser-only
  // (canvas) by necessity — Bun has no video decoder. Guarded + capped.
  // Any playable url counts: local /api/media/… as well as direct http(s).
  // gs://-only rows map to url="" and are skipped (nothing playable to grab).
  async function backfillThumbs(projectId: string) {
    if (backfilling) return;
    backfilling = true;
    try {
      const s = get();
      const items = s.videos
        .filter((v) => v.project_id === projectId && !v.thumb_url && !!playableUrl(v.video_url))
        .slice(0, 3);
      if (!items.length) return;
      const { captureAt } = await import("@/lib/media");
      for (const v of items) {
        try {
          const thumb = await captureAt(authedMediaUrl(`${apiBase()}${v.video_url}`), 0.5);
          await api.setThumb(v.id, thumb);
          set({
            videos: get().videos.map((r) =>
              r.id === v.id ? { ...r, thumb_url: thumb } : r,
            ),
          });
        } catch { /* keep placeholder; retried next refresh */ }
      }
    } finally {
      backfilling = false;
    }
  }

  function playableUrl(videoUrl: string): string {
    if (videoUrl.startsWith("/media/")) return `${apiBase()}${videoUrl}`;
    return videoUrl.startsWith("http") ? videoUrl : "";
  }

  async function doHydrate() {
    const fresh = loadLocal();
    local.activeId = fresh.activeId;
    local.drafts = fresh.drafts;
    local.settings = fresh.settings;
    local.youtube = fresh.youtube;
    useComposer.setState({ drafts: local.drafts, settings: local.settings, youtube: local.youtube });
    try {
      // Password gate first: don't fan out authed calls that will all 401.
      const auth = await api.authStatus().catch(() => ({ required: false }));
      if (auth.required && !getAuthToken()) {
        set({ hydrated: true, serverUp: true, authRequired: true, lastError: "" });
        return;
      }
      set({ authRequired: false });
      const [caps, projs] = await Promise.all([api.capabilities(), api.listProjects()]);
      setCapabilities(caps);
      const srv: SrvProject[] = projs.projects.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: Date.parse(p.created_at) || Date.now(),
      }));
      set({ caps, capsReady: true, projects: srv, serverUp: true, lastError: "" });
      void api.stats().then((t) => set({ totals: t })).catch(() => {});
      // Never auto-create: an empty server means the empty state (Home offers
      // "Create project"). Auto-creating here raced under concurrent hydrates
      // and littered untitled projects.
      if (!local.activeId || !srv.some((p) => p.id === local.activeId)) {
        local.activeId = srv[0]?.id ?? null;
      }
      persist();
      set({ activeId: local.activeId });
      if (local.activeId) await fetchProject(local.activeId).catch(() => {});
      set({ hydrated: true });
    } catch (e) {
      set({ hydrated: true, serverUp: false, lastError: errOf(e) });
    }
  }

  return {
    projects: [],
    settings: {},
    elements: [],
    videos: [],
    jobs: [],
    caps: null,
    capsReady: false,
    serverUp: true,
    lastError: "",
    activeId: null,
    hydrated: false,
    authRequired: false,
    totals: null,

    login: async (password: string) => {
      setAuthToken(password);
      try {
        // Probe with a real call: wrong password must not clear the gate.
        await api.capabilities();
        set({ authRequired: false });
        set({ hydrated: false });
        await get().hydrate();
        return { ok: true };
      } catch (e) {
        setAuthToken(null);
        set({ authRequired: true });
        return { ok: false, error: e instanceof Error ? e.message : "Login failed" };
      }
    },

    logout: () => {
      setAuthToken(null);
      set({ authRequired: true });
    },

    serverSettings: (projectId: string) => get().settings[projectId],

    hydrate: () => {
      if (get().hydrated) return Promise.resolve();
      if (hydrating) return hydrating;
      hydrating = (async () => {
        await doHydrate();
      })().finally(() => {
        hydrating = null;
      });
      return hydrating;
    },

    retry: async () => {
      set({ hydrated: false });
      await get().hydrate();
    },

    reloadProjects: async () => {
      const projs = await api.listProjects();
      const srv: SrvProject[] = projs.projects.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: Date.parse(p.created_at) || Date.now(),
      }));
      let activeId = get().activeId;
      if (!activeId || !srv.some((p) => p.id === activeId)) activeId = srv[0]?.id ?? null;
      local.activeId = activeId;
      persist();
      set({ projects: srv, activeId });
      if (activeId) await get().ensureProject(activeId);
    },

    ensureProject: async (projectId: string) => {
      if (loaded.has(projectId)) return;
      await fetchProject(projectId).catch((e) => set({ lastError: errOf(e) }));
    },

    refreshProject: async () => {
      const id = get().activeId;
      if (!id) return;
      try {
        await fetchProject(id);
      } catch (e) {
        set({ lastError: errOf(e) });
      }
    },

    pollTick: async () => {
      const s = get();
      const id = s.activeId;
      if (!id || !s.hydrated) return;
      if (!s.jobs.some((j) => j.projectId === id && (j.status === "queued" || j.status === "running"))) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (polling) return;
      polling = true;
      try {
        // Light delta: only jobs + library change under a render. Elements,
        // settings and stats are untouched by polling.
        const [jobs, libs] = await Promise.all([api.listJobs(id), api.listLibrary(id)]);
        const cur = get();
        const prevJobs = cur.jobs.filter((j) => j.projectId === id);
        const prevLib = cur.videos.filter((v) => v.project_id === id);
        if (rowsSame(prevJobs, jobs.jobs, sameJobRow) && rowsSame(prevLib, libs.videos, sameLibraryRow)) {
          return; // unchanged progress tick — zero set() calls, zero re-renders
        }
        set({
          jobs: [...cur.jobs.filter((j) => j.projectId !== id), ...jobs.jobs],
          videos: [...cur.videos.filter((v) => v.project_id !== id), ...libs.videos],
        });
      } catch { /* next tick retries */ }
      finally { polling = false; }
    },

    createProject: async (name: string) => {
      const created = await api.createProject(name.trim() || "Project");
      const one: SrvProject = { id: created.id, name: created.name, createdAt: Date.parse(created.created_at) || Date.now() };
      local.settings[one.id] = defaultSettings();
      local.activeId = one.id;
      persist();
      useComposer.getState().setDraft(one.id, defaultGen());
      useComposer.setState({ settings: { ...local.settings } });
      set({ projects: [one, ...get().projects], activeId: one.id });
      return one.id;
    },

    renameProject: async (id: string, name: string) => {
      const updated = await api.renameProject(id, name);
      set({ projects: get().projects.map((x) => (x.id === id ? { ...x, name: updated.name } : x)) });
    },

    deleteProject: async (id: string) => {
      await api.deleteProject(id);
      useComposer.getState().dropProject(id);
      const projects = get().projects.filter((x) => x.id !== id);
      const activeId = get().activeId === id ? (projects[0]?.id ?? null) : get().activeId;
      local.activeId = activeId;
      persist();
      set({
        projects,
        activeId,
        elements: get().elements.filter((e) => e.project_id !== id),
        videos: get().videos.filter((v) => v.project_id !== id),
        jobs: get().jobs.filter((j) => j.projectId !== id),
      });
      if (activeId) await get().ensureProject(activeId);
    },

    setActiveId: (id: string | null) => {
      local.activeId = id;
      persist();
      set({ activeId: id });
      if (id) void get().ensureProject(id).catch(() => {});
    },

    attachElement: (projectId, cat, img) => {
      useComposer.getState().updateDraft(projectId, (draft) => {
        const g = draft;
        if (cat === "frames") {
          if (!g.first) g.first = img;
          else if (!g.last) g.last = img;
          else { g.first = g.last; g.last = img; }
          return;
        }
        const m = modelOf(g.model);
        if (!m.ref) g.model = "veo-3.1-fast-generate-001";
        g.mode = "r2v";
        const r = g.refs.filter(Boolean);
        if (r.length < 3 && !r.includes(img)) r.push(img);
        g.refs = r.slice(0, 3);
        g.dur = 8;
      });
    },

    // Reload a library video's exact config into the composer. Never submits.
    // Inputs that no longer resolve (deleted elements, expired session files)
    // are reported so the user can re-attach them.
    loadIntoComposer: (projectId, videoId) => {
      const library = buildLibrary(projectId, get().videos, get().jobs, get().elements, useComposer.getState().youtube);
      const v = library.find((x) => x.id === videoId);
      if (!v) return { ok: false, error: "Video is gone from the library." };
      const missing: string[] = [];
      const need = (label: string, url?: string): string => {
        if (!url) {
          missing.push(label);
          return "";
        }
        if (url.startsWith("blob:")) {
          missing.push(`${label} (session file expired — re-upload)`);
          return "";
        }
        return url;
      };
      // Only the slots this mode actually uses — a t2v clip has no frames
      // to miss, and must not report any.
      const wantImage = v.mode === "i2v";
      const wantFrames = v.mode === "frames";
      const wantRefs = v.mode === "r2v";
      const model = v.model === "import" ? (useComposer.getState().drafts[projectId]?.model ?? defaultGen().model) : v.model;
      const gen: GenDraft = {
        mode: v.mode,
        model,
        res: v.res as GenDraft["res"],
        aspect: v.aspect as GenDraft["aspect"],
        dur: v.dur,
        audio: v.audio,
        batch: 1,
        seed: v.seed ?? "",
        person: v.person === "dont_allow" ? "dont_allow" : "allow_adult",
        enhance: v.enhance,
        negativePrompt: v.negativePrompt ?? "",
        prompt: v.prompt,
        image: wantImage ? need("image", v.inputs.image) : "",
        first: wantFrames ? need("first frame", v.inputs.first) : "",
        last: wantFrames ? need("last frame", v.inputs.last) : "",
        refs: wantRefs ? (v.inputs.refs ?? []).map((r, i) => need(`reference ${i + 1}`, r)).filter(Boolean) : [],
        extendVideo: "",
      };
      if (v.mode === "extend") {
        const src = v.inputs.extendVideo;
        if (src && library.some((x) => x.id === src)) gen.extendVideo = src;
        else missing.push("source video (deleted — pick another)");
      }
      // Normalize against the (possibly different) model, like live edits do.
      const m = modelOf(gen.model);
      if (!(m.res as readonly string[]).includes(gen.res)) gen.res = (m.res[0] ?? "720p") as GenDraft["res"];
      if (!(m.dur as readonly number[]).includes(gen.dur)) gen.dur = m.dur[m.dur.length - 1] ?? 8;
      if (gen.mode === "r2v") gen.dur = 8;
      if (m.silent) gen.audio = false;
      useComposer.getState().setDraft(projectId, gen);
      return { ok: true, missing };
    },

    queueGeneration: async (projectId: string) => {
      const g = { ...(useComposer.getState().drafts[projectId] ?? defaultGen()) };
      const m = modelOf(g.model);
      const library = buildLibrary(projectId, get().videos, get().jobs, get().elements, useComposer.getState().youtube);
      const validation = validateGen(
        { prompt: g.prompt, mode: g.mode, image: g.image, first: g.first, last: g.last, refs: g.refs, extendVideo: g.extendVideo },
        m,
        library,
      );
      if (validation) return { ok: false, error: validation };

      // Frames pairing: both stills should match the requested output aspect.
      if (g.mode === "frames") {
        const [a, b] = await Promise.all([imageDims(g.first), imageDims(g.last)]);
        const landscape = g.aspect === "16:9";
        const bad =
          (a && (landscape ? a.w < a.h : a.w > a.h)) || (b && (landscape ? b.w < b.h : b.w > b.h));
        if (bad) {
          return {
            ok: false,
            error: `Both frames should be ${g.aspect} like the output — one still looks ${landscape ? "portrait" : "landscape"} (it would fail or get cropped).`,
          };
        }
      }

      const resolveAsset = async (img: string, category: string, label: string): Promise<string> => {
        const hit = get().elements.find((e) => e.project_id === projectId && e.image_url === img);
        if (hit) return hit.id;
        const created = await api.createElement(projectId, {
          category,
          name: `${label} · ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
          imageUrl: img,
          note: "Saved from generator",
        });
        const row: ServerElement = {
          id: created.id,
          project_id: created.projectId ?? projectId,
          category: created.category,
          name: created.name,
          image_url: created.imageUrl,
          note: created.note,
          created_at: created.createdAt,
        };
        set({ elements: [...get().elements, row] });
        return created.id;
      };

      try {
        const dur = g.mode === "extend" ? 7 : g.dur;
        const audio = m.silent ? false : g.audio;
        const seed = g.seed === "" ? undefined : Number(g.seed);
        const base: Record<string, unknown> = {
          projectId,
          mode: g.mode === "frames" ? "f2v" : g.mode,
          model: g.model,
          prompt: g.prompt.trim(),
          resolution: g.res,
          aspect: g.aspect,
          durationSeconds: dur,
          audio,
          sampleCount: 1,
          person: g.person,
          enhancePrompt: g.enhance,
          ...(g.negativePrompt.trim() ? { negativePrompt: g.negativePrompt.trim().slice(0, 2000) } : {}),
          ...(seed != null && !Number.isNaN(seed) ? { seed } : {}),
        };
        if (g.mode === "i2v") base.imageAssetId = await resolveAsset(g.image, "frames", "Source still");
        if (g.mode === "frames") {
          base.firstFrameAssetId = await resolveAsset(g.first, "frames", "First frame");
          base.lastFrameAssetId = await resolveAsset(g.last, "frames", "Last frame");
        }
        if (g.mode === "r2v") {
          base.refAssetIds = [];
          for (const r of g.refs.filter(Boolean)) {
            (base.refAssetIds as string[]).push(await resolveAsset(r, "assets", "Reference"));
          }
        }
        if (g.mode === "extend") {
          const s = library.find((x) => x.id === g.extendVideo);
          base.sourceVideoId = g.extendVideo;
          if (s) {
            base.sourceResolution = s.res;
            base.sourceAspect = s.aspect;
            base.sourceDurationSeconds = expectedDur(s, (id) => library.find((x) => x.id === id));
          }
          // Uploaded/generated files live on the server now — it resolves
          // gs:// chains and on-disk bytes itself. No raw bytes in the request.
        }
        let count = 0;
        for (let i = 0; i < (g.batch || 1); i++) {
          await api.createJob(base, crypto.randomUUID());
          count++;
        }
        await get().refreshProject();
        // Fresh composer for the next shot: clear prompt + inputs, keep config.
        // Advanced settings clear too — seed / person / negative belong to
        // the request just used, like the prompt.
        useComposer.getState().updateDraft(projectId, (d) => {
          d.prompt = "";
          d.image = "";
          d.first = "";
          d.last = "";
          d.refs = [];
          d.extendVideo = "";
          d.seed = "";
          d.person = "allow_adult";
          d.negativePrompt = "";
        });
        return { ok: true, count };
      } catch (e) {
        return { ok: false, error: errOf(e) };
      }
    },

    importVideo: async (projectId, a) => {
      try {
        const { id } = await api.importVideo({
          projectId,
          prompt: a.prompt,
          resolution: a.res,
          aspect: a.aspect,
          durationSeconds: a.dur,
          audio: true,
          thumbDataUrl: a.thumbDataUrl,
          ...(a.mediaId ? { mediaId: a.mediaId } : {}),
        });
        await get().refreshProject();
        return { ok: true, id };
      } catch (e) {
        return { ok: false, error: errOf(e) };
      }
    },

    deleteVideo: async (id: string) => {
      // Pending → cancel the live job. Failed job record → dismiss it.
      // Finished library video → delete it. Exactly one applies per status.
      const job = get().jobs.find((j) => j.id === id);
      if (job && (job.status === "queued" || job.status === "running")) {
        try {
          await api.cancelJob(id);
        } catch (e) {
          set({ lastError: errOf(e) });
        }
      } else if (job) {
        try {
          await api.deleteJob(id);
        } catch {
          // Already terminal/gone — refresh anyway.
        }
      } else {
        try {
          await api.deleteVideo(id);
        } catch {
          // Already terminal/gone — refresh anyway.
        }
      }
      await get().refreshProject();
    },

    addElement: async (projectId, cat, data) => {
      try {
        const created = await api.createElement(projectId, {
          category: cat,
          name: data.name,
          imageUrl: data.imageUrl,
          note: data.note,
        });
        // POST returns camelCase; normalize to the snake_case row shape.
        const row: ServerElement = {
          id: created.id,
          project_id: created.projectId ?? projectId,
          category: created.category,
          name: created.name,
          image_url: created.imageUrl,
          note: created.note,
          created_at: created.createdAt,
        };
        set({ elements: [row, ...get().elements] });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: errOf(e) };
      }
    },

    deleteElement: async (id: string) => {
      try {
        await api.deleteElement(id);
      } catch (e) {
        set({ lastError: errOf(e) });
      }
      set({ elements: get().elements.filter((e) => e.id !== id) });
    },

    renameElement: async (id, data) => {
      const name = data.name.trim().slice(0, 80);
      if (!name) return { ok: false, error: "Name is required." };
      try {
        await api.updateElement(id, { name, note: data.note.trim().slice(0, 200) });
      } catch (e) {
        return { ok: false, error: errOf(e) };
      }
      set({
        elements: get().elements.map((e) =>
          e.id === id ? { ...e, name, note: data.note.trim().slice(0, 200) } : e,
        ),
      });
      return { ok: true };
    },

    saveSettings: async (patch) => {
      const id = get().activeId;
      if (!id) return;
      // Server owns auth/bucket/YouTube config; the SA key itself is only ever sent up, never stored locally.
      // Empty-string saJson is meaningful (clear the stored key) — only undefined means "don't touch".
      const { saJson, bucket, useBucket, authMode, ...ytPatch } = patch;
      const serverPatch: { saJson?: string; bucket?: string; useBucket?: boolean; authMode?: "service_account" | "env"; ytClientId?: string; ytPrivacy?: string; ytCategory?: string } = {};
      if (typeof saJson === "string") serverPatch.saJson = saJson;
      if (bucket !== undefined) serverPatch.bucket = bucket;
      if (useBucket !== undefined) serverPatch.useBucket = useBucket;
      if (authMode !== undefined) serverPatch.authMode = authMode;
      if (typeof ytPatch.ytClientId === "string") serverPatch.ytClientId = ytPatch.ytClientId;
      if (typeof ytPatch.ytPrivacy === "string") serverPatch.ytPrivacy = ytPatch.ytPrivacy;
      if (typeof ytPatch.ytCategory === "string") serverPatch.ytCategory = ytPatch.ytCategory;
      if (Object.keys(serverPatch).length > 0) {
        const saved = await api.saveSettings(id, serverPatch);
        const prev = get().settings[id];
        set({
          settings: {
            ...get().settings,
            [id]: {
              projectId: saved.projectId,
              bucket: saved.bucket,
              useBucket: saved.useBucket,
              authMode: saved.authMode,
              hasSaJson: saved.hasSaJson,
              saEmail: saved.saEmail,
              saProjectId: saved.saProjectId,
              bucketLocation: saved.bucketCheck?.location ?? saved.bucketLocation ?? prev?.bucketLocation ?? null,
              ytClientId: saved.ytClientId,
              ytPrivacy: saved.ytPrivacy,
              ytCategory: saved.ytCategory,
            },
          },
        });
      }
      if (Object.keys(ytPatch).length > 0) {
        local.settings[id] = { ...(local.settings[id] ?? defaultSettings()), ...ytPatch };
        schedulePersist();
        useComposer.setState({ settings: { ...local.settings } });
      }
    },
  };
});

// A 401 anywhere means the password changed or the session died: pop the gate.
if (typeof window !== "undefined") {
  onUnauthorized(() => useStudio.setState({ authRequired: true }));
}
