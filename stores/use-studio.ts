"use client";

import { create } from "zustand";
import { api, apiBase } from "@/lib/api";
import type { Capabilities, ServerElement, ServerJob, ServerSettings, ServerVideo } from "@/lib/api";
import { modelOf, setCapabilities, validateGen } from "@/lib/pricing";
import { imageDims } from "@/lib/media";
import type {
  ElementCat,
  ElementItem,
  GenDraft,
  Project,
  VideoItem,
} from "@/lib/schemas";

// ---------- local-only overlays (gen drafts, settings, youtube) ----------
const LS = "veo-web-v1";

interface LocalOverlays {
  activeId: string | null;
  drafts: Record<string, GenDraft>;
  settings: Record<string, Project["settings"]>;
  youtube: Record<string, NonNullable<VideoItem["youtube"]>>;
}

function defaultGen(): GenDraft {
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

// ---------- server → UI mapping ----------
const toWebMode = (m: string): VideoItem["mode"] => (m === "f2v" ? "frames" : (m as VideoItem["mode"]));
const toServerMode = (m: string): string => (m === "frames" ? "f2v" : m);

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

function parseRawInputs(json: string): RawInputs {
  try {
    return JSON.parse(json || "{}") as RawInputs;
  } catch {
    return {};
  }
}

function toVideoItem(
  v: ServerVideo,
  elements: ServerElement[],
  youtube: Record<string, NonNullable<VideoItem["youtube"]>>,
): VideoItem {
  let inputs: VideoItem["inputs"] = {};
  inputs = mapInputs(parseRawInputs(v.inputs_json), elements);
  return {
    id: v.id,
    jobId: v.job_id,
    mode: toWebMode(v.mode),
    prompt: v.prompt,
    model: v.model,
    res: v.resolution,
    aspect: v.aspect,
    dur: v.duration_seconds,
    audio: !!v.audio,
    seed: "",
    person: "allow_adult",
    enhance: false,
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
  };
}

function jobToVideoItem(
  j: ServerJob,
  elements: ServerElement[],
): VideoItem {
  const inputs = mapInputs(parseRawInputs(j.inputsJson ?? "{}"), elements);
  return {
    id: j.id,
    jobId: j.id,
    mode: toWebMode(j.mode),
    prompt: j.prompt,
    model: j.model,
    res: j.resolution,
    aspect: j.aspect,
    dur: j.durationSeconds,
    audio: j.audio,
    seed: typeof j.seed === "number" ? j.seed : "",
    person: "allow_adult",
    enhance: false,
    batch: 1,
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

// ---------- store ----------
interface SrvProject { id: string; name: string; createdAt: number }

interface StudioState {
  srvProjects: SrvProject[];
  srvSettings: Record<string, ServerSettings>;
  elements: ServerElement[];
  library: ServerVideo[];
  jobs: ServerJob[];
  caps: Capabilities | null;
  capsReady: boolean;
  serverUp: boolean;
  lastError: string;
  projects: Project[];
  activeId: string | null;
  hydrated: boolean;
  refreshing: boolean;
  serverSettings: (projectId: string) => ServerSettings | undefined;
  hydrate: () => Promise<void>;
  retry: () => Promise<void>;
  reloadProjects: () => Promise<void>;
  ensureLoaded: (projectId: string) => Promise<void>;
  refreshActive: () => Promise<void>;
  pollJobs: () => Promise<void>;
  activeProject: () => Project | undefined;
  updateActive: (fn: (draft: Project) => void) => { ok: boolean; error?: string };
  queueGeneration: () => Promise<{ ok: boolean; error?: string; count?: number }>;
  importVideo: (a: { prompt: string; res: string; aspect: string; dur: number; thumbDataUrl: string; mediaId?: string }) => Promise<{ ok: boolean; error?: string; id?: string }>;
  deleteVideo: (id: string) => Promise<void>;
  createProject: (name: string) => Promise<string>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  setActiveId: (id: string | null) => void;
  attachElement: (cat: ElementCat, img: string) => void;
  loadIntoComposer: (videoId: string) => { ok: boolean; error?: string; missing?: string[] };
  addElement: (cat: ElementCat, data: { name: string; imageUrl: string; note: string }) => Promise<{ ok: boolean; error?: string }>;
  deleteElement: (id: string) => Promise<void>;
  setYoutube: (videoId: string, patch: Record<string, unknown>) => void;
  saveSettings: (patch: Partial<Project["settings"]>) => Promise<void>;
}

function buildProjects(
  srv: SrvProject[],
  elements: ServerElement[],
  library: ServerVideo[],
  jobs: ServerJob[],
  srvSettings: Record<string, ServerSettings>,
  local: LocalOverlays,
): Project[] {
  return srv.map((p) => {
    const els = elements.filter((e) => e.project_id === p.id);
    const libs = library.filter((v) => v.project_id === p.id);
    const pjobs = jobs.filter((j) => j.projectId === p.id);
    const items: VideoItem[] = [
      ...libs.map((v) => toVideoItem(v, els, local.youtube)),
      ...pjobs
        .filter((j) => j.status === "queued" || j.status === "running" || j.status === "failed" || j.status === "cancelled")
        .map((j) => jobToVideoItem(j, els)),
    ].sort((a, b) => b.createdAt - a.createdAt);
    const grouped: Project["elements"] = { characters: [], locations: [], assets: [], frames: [] };
    for (const e of els) {
      const item: ElementItem = { id: e.id, name: e.name, img: e.image_url, note: e.note };
      if (e.category === "characters" || e.category === "locations" || e.category === "assets" || e.category === "frames") {
        grouped[e.category].push(item);
      }
    }
    // Server owns auth/bucket; browser keeps YouTube OAuth bits. SA key never
    // comes back down — hasSaJson/saEmail tell the UI what's configured.
    const srvCfg = srvSettings[p.id];
    const yt = local.settings[p.id];
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      gen: local.drafts[p.id] ?? defaultGen(),
      library: items,
      elements: grouped,
      settings: {
        saJson: "",
        bucket: srvCfg?.bucket ?? "",
        useBucket: srvCfg?.useBucket ?? true,
        authMode: srvCfg?.authMode ?? "service_account",
        ytClientId: yt?.ytClientId ?? "",
        ytPrivacy: yt?.ytPrivacy ?? "unlisted",
        ytCategory: yt?.ytCategory ?? "22",
      },
    };
  });
}

export const useStudio = create<StudioState>()((set, get) => {
  let local = loadLocal();
  const loaded = new Set<string>();
  // In-flight hydrate promise: never run two hydrates concurrently
  // (StrictMode double-effects / retries would each auto-create projects).
  let hydrating: Promise<void> | null = null;

  const persist = () => saveLocal(local);

  const rebuild = (patch: Partial<StudioState>) => {
    const s = get();
    const projects = buildProjects(s.srvProjects, s.elements, s.library, s.jobs, s.srvSettings, local);
    set({ ...patch, projects });
  };

  const errOf = (e: unknown): string =>
    e instanceof Error ? e.message : String(e ?? "Request failed");

  async function fetchScope(projectId: string) {
    const [els, libs, jobs, cfgResp] = await Promise.all([
      api.listElements(projectId),
      api.listLibrary(projectId),
      api.listJobs(projectId),
      api.getSettings(projectId),
    ]);
    const s = get();
    const prevCfg = s.srvSettings[projectId];
    const cfg: ServerSettings = {
      ...cfgResp,
      bucketLocation: cfgResp.bucketLocation ?? prevCfg?.bucketLocation ?? null,
    };
    set({
      elements: [...s.elements.filter((e) => e.project_id !== projectId), ...els.elements],
      library: [...s.library.filter((v) => v.project_id !== projectId), ...libs.videos],
      jobs: [...s.jobs.filter((j) => j.projectId !== projectId), ...jobs.jobs],
      srvSettings: { ...s.srvSettings, [projectId]: cfg },
    });
    loaded.add(projectId);
    rebuild({});
    // Fire-and-forget: playable successes without thumbs get browser captures.
    void backfillThumbs(projectId).catch(() => {});
  }

  // Capture real thumbnails for succeeded videos missing them. Browser-only
  // (canvas) by necessity — Bun has no video decoder. Guarded + capped.
  let backfilling = false;
  async function backfillThumbs(projectId: string) {
    if (backfilling) return;
    backfilling = true;
    try {
      const items = (get().projects.find((p) => p.id === projectId)?.library ?? [])
        .filter((v) => v.status === "success" && !v.thumb && v.url.startsWith("http"))
        .slice(0, 3);
      if (!items.length) return;
      const { captureAt } = await import("@/lib/media");
      for (const v of items) {
        try {
          const thumb = await captureAt(v.url, 0.5);
          await api.setThumb(v.id, thumb);
          set({
            library: get().library.map((r) =>
              r.id === v.id ? { ...r, thumb_url: thumb } : r,
            ),
          });
          rebuild({});
        } catch { /* keep placeholder; retried next refresh */ }
      }
    } finally {
      backfilling = false;
    }
  }

  async function doHydrate() {
    local = loadLocal();
    try {
      const [caps, projs] = await Promise.all([api.capabilities(), api.listProjects()]);
      setCapabilities(caps);
      const srv: SrvProject[] = projs.projects.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: Date.parse(p.created_at) || Date.now(),
      }));
      set({ caps, capsReady: true, srvProjects: srv, serverUp: true, lastError: "" });
      // Never auto-create: an empty server means the empty state (Home offers
      // "Create project"). Auto-creating here raced under concurrent hydrates
      // and littered untitled projects.
      if (!local.activeId || !srv.some((p) => p.id === local.activeId)) {
        local.activeId = srv[0]?.id ?? null;
      }
      persist();
      set({ activeId: local.activeId });
      if (local.activeId) await fetchScope(local.activeId).catch(() => {});
      rebuild({ hydrated: true });
    } catch (e) {
      set({ hydrated: true, serverUp: false, lastError: errOf(e) });
    }
  }

  return {
    srvProjects: [],
    srvSettings: {},
    elements: [],
    library: [],
    jobs: [],
    caps: null,
    capsReady: false,
    serverUp: true,
    lastError: "",
    projects: [],
    activeId: null,
    hydrated: false,
    refreshing: false,

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
      set({ srvProjects: srv, activeId });
      rebuild({});
      if (activeId) await get().ensureLoaded(activeId);
    },

    ensureLoaded: async (projectId: string) => {
      if (loaded.has(projectId)) return;
      await fetchScope(projectId).catch((e) => set({ lastError: errOf(e) }));
    },

    refreshActive: async () => {
      const id = get().activeId;
      if (!id) return;
      set({ refreshing: true });
      try {
        await fetchScope(id);
      } catch (e) {
        set({ lastError: errOf(e) });
      } finally {
        set({ refreshing: false });
      }
    },

    pollJobs: async () => {
      const s = get();
      const id = s.activeId;
      if (!id || !s.hydrated) return;
      const active = s.projects.find((p) => p.id === id);
      if (!active || !active.library.some((v) => v.status === "pending")) return;
      try {
        await fetchScope(id);
      } catch { /* next tick retries */ }
    },

    activeProject: () => {
      const { projects, activeId } = get();
      return projects.find((x) => x.id === activeId) ?? projects[0];
    },

    updateActive: (fn) => {
      const { activeId } = get();
      if (!activeId) return { ok: false, error: "No active project." };
      const current = get().projects.find((x) => x.id === activeId);
      if (!current) return { ok: false, error: "Project not found." };
      // Deep-copy the draft only — elements/youtube/library are server-backed
      // and must go through addElement/deleteElement/setYoutube.
      const draft: Project = {
        ...current,
        gen: { ...current.gen, refs: [...(current.gen.refs || [])] },
      };
      fn(draft);
      const m = modelOf(draft.gen.model);
      const resList = m.res;
      const durList = m.dur;
      if (!resList.includes(draft.gen.res)) draft.gen.res = (resList[0] ?? "720p") as GenDraft["res"];
      if (!durList.includes(draft.gen.dur)) draft.gen.dur = durList[durList.length - 1] ?? 8;
      if (draft.gen.mode === "r2v") draft.gen.dur = 8;
      if (m.silent) draft.gen.audio = false;
      local.drafts[activeId] = draft.gen;
      persist();
      rebuild({});
      return { ok: true };
    },

    queueGeneration: async () => {
      const p = get().activeProject();
      if (!p) return { ok: false, error: "No active project." };
      const g = { ...(local.drafts[p.id] ?? defaultGen()) };
      const m = modelOf(g.model);
      const validation = validateGen(
        { prompt: g.prompt, mode: g.mode, image: g.image, first: g.first, last: g.last, refs: g.refs, extendVideo: g.extendVideo },
        m,
        p.library,
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
        const hit = get().elements.find((e) => e.project_id === p.id && e.image_url === img);
        if (hit) return hit.id;
        const created = await api.createElement(p.id, {
          category,
          name: `${label} · ${new Date().toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
          imageUrl: img,
          note: "Saved from generator",
        });
        const row: ServerElement = {
          id: created.id,
          project_id: created.projectId ?? p.id,
          category: created.category,
          name: created.name,
          image_url: created.imageUrl,
          note: created.note,
          created_at: created.createdAt,
        };
        set({ elements: [...get().elements, row] });
        rebuild({});
        return created.id;
      };

      try {
        const dur = g.mode === "extend" ? 7 : g.dur;
        const audio = m.silent ? false : g.audio;
        const seed = g.seed === "" ? undefined : Number(g.seed);
        const base: Record<string, unknown> = {
          projectId: p.id,
          mode: toServerMode(g.mode),
          model: g.model,
          prompt: g.prompt.trim(),
          resolution: g.res,
          aspect: g.aspect,
          durationSeconds: dur,
          audio,
          sampleCount: 1,
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
          const s = p.library.find((x) => x.id === g.extendVideo);
          base.sourceVideoId = g.extendVideo;
          if (s) {
            base.sourceResolution = s.res;
            base.sourceAspect = s.aspect;
            base.sourceDurationSeconds = s.dur;
          }
          // Uploaded/generated files live on the server now — it resolves
          // gs:// chains and on-disk bytes itself. No raw bytes in the request.
        }
        let count = 0;
        for (let i = 0; i < (g.batch || 1); i++) {
          await api.createJob(base, crypto.randomUUID());
          count++;
        }
        await get().refreshActive();
        return { ok: true, count };
      } catch (e) {
        return { ok: false, error: errOf(e) };
      }
    },

    importVideo: async (a) => {
      const p = get().activeProject();
      if (!p) return { ok: false, error: "No active project." };
      try {
        const { id } = await api.importVideo({
          projectId: p.id,
          prompt: a.prompt,
          resolution: a.res,
          aspect: a.aspect,
          durationSeconds: a.dur,
          audio: true,
          thumbDataUrl: a.thumbDataUrl,
          ...(a.mediaId ? { mediaId: a.mediaId } : {}),
        });
        await get().refreshActive();
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
      await get().refreshActive();
    },

    createProject: async (name: string) => {
      const created = await api.createProject(name.trim() || "Project");
      const one: SrvProject = { id: created.id, name: created.name, createdAt: Date.parse(created.created_at) || Date.now() };
      local.drafts[one.id] = defaultGen();
      local.settings[one.id] = defaultSettings();
      local.activeId = one.id;
      persist();
      set({ srvProjects: [one, ...get().srvProjects], activeId: one.id });
      rebuild({});
      return one.id;
    },

    renameProject: async (id: string, name: string) => {
      const updated = await api.renameProject(id, name);
      set({ srvProjects: get().srvProjects.map((x) => (x.id === id ? { ...x, name: updated.name } : x)) });
      rebuild({});
    },

    deleteProject: async (id: string) => {
      await api.deleteProject(id);
      delete local.drafts[id];
      delete local.settings[id];
      const srvProjects = get().srvProjects.filter((x) => x.id !== id);
      const activeId = get().activeId === id ? (srvProjects[0]?.id ?? null) : get().activeId;
      local.activeId = activeId;
      persist();
      set({
        srvProjects,
        activeId,
        elements: get().elements.filter((e) => e.project_id !== id),
        library: get().library.filter((v) => v.project_id !== id),
        jobs: get().jobs.filter((j) => j.projectId !== id),
      });
      rebuild({});
      if (activeId) await get().ensureLoaded(activeId);
    },

    setActiveId: (id: string | null) => {
      local.activeId = id;
      persist();
      set({ activeId: id });
      if (id) void get().ensureLoaded(id).catch(() => {});
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
    loadIntoComposer: (videoId) => {
      const p = get().activeProject();
      if (!p) return { ok: false, error: "No active project." };
      const v = p.library.find((x) => x.id === videoId);
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
      const model = v.model === "import" ? (local.drafts[p.id]?.model ?? defaultGen().model) : v.model;
      const gen: GenDraft = {
        mode: v.mode,
        model,
        res: v.res as GenDraft["res"],
        aspect: v.aspect as GenDraft["aspect"],
        dur: v.dur,
        audio: v.audio,
        batch: 1,
        seed: v.seed ?? "",
        person: "allow_adult",
        enhance: true,
        prompt: v.prompt,
        image: wantImage ? need("image", v.inputs.image) : "",
        first: wantFrames ? need("first frame", v.inputs.first) : "",
        last: wantFrames ? need("last frame", v.inputs.last) : "",
        refs: wantRefs ? (v.inputs.refs ?? []).map((r, i) => need(`reference ${i + 1}`, r)).filter(Boolean) : [],
        extendVideo: "",
      };
      if (v.mode === "extend") {
        const src = v.inputs.extendVideo;
        if (src && p.library.some((x) => x.id === src)) gen.extendVideo = src;
        else missing.push("source video (deleted — pick another)");
      }
      // Normalize against the (possibly different) model, like live edits do.
      const m = modelOf(gen.model);
      if (!(m.res as readonly string[]).includes(gen.res)) gen.res = (m.res[0] ?? "720p") as GenDraft["res"];
      if (!(m.dur as readonly number[]).includes(gen.dur)) gen.dur = m.dur[m.dur.length - 1] ?? 8;
      if (gen.mode === "r2v") gen.dur = 8;
      if (m.silent) gen.audio = false;
      local.drafts[p.id] = gen;
      persist();
      rebuild({});
      return { ok: true, missing };
    },

    addElement: async (cat, data) => {
      const p = get().activeProject();
      if (!p) return { ok: false, error: "No active project." };
      try {
        const created = await api.createElement(p.id, {
          category: cat,
          name: data.name,
          imageUrl: data.imageUrl,
          note: data.note,
        });
        // POST returns camelCase; normalize to the snake_case row shape.
        const row: ServerElement = {
          id: created.id,
          project_id: created.projectId ?? p.id,
          category: created.category,
          name: created.name,
          image_url: created.imageUrl,
          note: created.note,
          created_at: created.createdAt,
        };
        set({ elements: [row, ...get().elements] });
        rebuild({});
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
      rebuild({});
    },

    setYoutube: (videoId, patch) => {
      local.youtube[videoId] = { ...(local.youtube[videoId] ?? {}), ...patch };
      persist();
      rebuild({});
    },

    serverSettings: (projectId: string) => get().srvSettings[projectId],

    saveSettings: async (patch) => {
      const id = get().activeId;
      if (!id) return;
      // Server owns auth/bucket; the SA key itself is only ever sent up, never stored locally.
      const { saJson, bucket, useBucket, authMode, ...ytPatch } = patch;
      const serverPatch: { saJson?: string; bucket?: string; useBucket?: boolean; authMode?: "service_account" | "env" } = {};
      if (typeof saJson === "string" && saJson.trim()) serverPatch.saJson = saJson;
      if (bucket !== undefined) serverPatch.bucket = bucket;
      if (useBucket !== undefined) serverPatch.useBucket = useBucket;
      if (authMode !== undefined) serverPatch.authMode = authMode;
      if (Object.keys(serverPatch).length > 0) {
        const saved = await api.saveSettings(id, serverPatch);
        const prev = get().srvSettings[id];
        set({
          srvSettings: {
            ...get().srvSettings,
            [id]: {
              projectId: saved.projectId,
              bucket: saved.bucket,
              useBucket: saved.useBucket,
              authMode: saved.authMode,
              hasSaJson: saved.hasSaJson,
              saEmail: saved.saEmail,
              saProjectId: saved.saProjectId,
              bucketLocation: saved.bucketCheck?.location ?? saved.bucketLocation ?? prev?.bucketLocation ?? null,
            },
          },
        });
      }
      if (Object.keys(ytPatch).length > 0) {
        local.settings[id] = { ...(local.settings[id] ?? defaultSettings()), ...ytPatch };
        persist();
      }
      rebuild({});
    },
  };
});
