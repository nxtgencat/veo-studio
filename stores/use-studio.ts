"use client";

import { create } from "zustand";
import { api, apiBase, authedMediaUrl, errOf, getAuthToken, onUnauthorized, setAuthToken } from "@/lib/api";
import type { Capabilities, ServerElement, ServerJob, ServerSettings, ServerVideo } from "@/lib/api";
import { modelOf, setCapabilities, validateGen } from "@/lib/pricing";
import { expectedDur } from "@/lib/format";
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
  enhancePrompt?: boolean;
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

function jobToVideoItem(
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
  authRequired: boolean;
  /** Server-side account totals (all projects, even never-opened ones). */
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
  renameElement: (id: string, data: { name: string; note: string }) => Promise<{ ok: boolean; error?: string }>;
  deleteElement: (id: string) => Promise<void>;
  setYoutube: (videoId: string, patch: Record<string, unknown>) => void;
  saveSettings: (patch: Partial<Project["settings"]>) => Promise<void>;
}

function sameStrArr(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** Flat composer draft equality — lets rebuild reuse the previous ref when
 *  a poll (not the user) triggered it, so typing views don't re-render. */
function sameGen(a: GenDraft, b: GenDraft): boolean {
  return (
    a === b ||
    (a.mode === b.mode && a.model === b.model && a.res === b.res &&
      a.aspect === b.aspect && a.dur === b.dur && a.audio === b.audio &&
      a.batch === b.batch && String(a.seed) === String(b.seed) &&
      a.person === b.person && a.enhance === b.enhance &&
      a.negativePrompt === b.negativePrompt && a.prompt === b.prompt &&
      a.image === b.image && a.first === b.first && a.last === b.last &&
      a.extendVideo === b.extendVideo && sameStrArr(a.refs, b.refs))
  );
}

function sameInputs(a: VideoItem["inputs"], b: VideoItem["inputs"]): boolean {
  return (
    a === b ||
    (a.image === b.image && a.first === b.first && a.last === b.last &&
      a.extendVideo === b.extendVideo && sameStrArr(a.refs, b.refs))
  );
}

/** Render-relevant equality for one library row. youtube is compared by
 *  reference — setYoutube allocates a new object only for the edited video. */
function sameVideoItem(a: VideoItem, b: VideoItem): boolean {
  return (
    a === b ||
    (a.id === b.id && a.jobId === b.jobId && a.mode === b.mode &&
      a.prompt === b.prompt && a.model === b.model && a.res === b.res &&
      a.aspect === b.aspect && a.dur === b.dur && a.durActual === b.durActual &&
      a.size === b.size && a.audio === b.audio && String(a.seed) === String(b.seed) &&
      a.person === b.person && a.enhance === b.enhance && a.batch === b.batch &&
      a.status === b.status && a.progress === b.progress && a.cost === b.cost &&
      a.createdAt === b.createdAt && a.thumb === b.thumb && a.url === b.url &&
      a.imported === b.imported && a.error === b.error &&
      a.elapsedMs === b.elapsedMs && a.etaMs === b.etaMs && a.etaSource === b.etaSource &&
      a.negativePrompt === b.negativePrompt && a.youtube === b.youtube &&
      sameInputs(a.inputs, b.inputs))
  );
}

function sameElArr(a: ElementItem[], b: ElementItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.name === y.name && x.img === y.img && x.note === y.note;
  });
}

function sameSettings(a: Project["settings"], b: Project["settings"]): boolean {
  return (
    a === b ||
    (a.saJson === b.saJson && a.bucket === b.bucket && a.useBucket === b.useBucket &&
      a.authMode === b.authMode && a.ytClientId === b.ytClientId &&
      a.ytPrivacy === b.ytPrivacy && a.ytCategory === b.ytCategory)
  );
}

function buildProjects(
  prev: Project[],
  srv: SrvProject[],
  elements: ServerElement[],
  library: ServerVideo[],
  jobs: ServerJob[],
  srvSettings: Record<string, ServerSettings>,
  local: LocalOverlays,
): Project[] {
  const prevById = new Map(prev.map((p) => [p.id, p]));
  const next = srv.map((p) => {
    const prior = prevById.get(p.id);
    const els = elements.filter((e) => e.project_id === p.id);
    const libs = library.filter((v) => v.project_id === p.id);
    const pjobs = jobs.filter((j) => j.projectId === p.id);
    const fresh: VideoItem[] = [
      ...libs.map((v) => toVideoItem(v, els, local.youtube)),
      ...pjobs
        .filter((j) => j.status === "queued" || j.status === "running" || j.status === "failed" || j.status === "cancelled")
        .map((j) => jobToVideoItem(j, els)),
    ].sort((a, b) => b.createdAt - a.createdAt);
    // Reuse item refs (and the whole array) when nothing render-relevant changed.
    let items = prior?.library;
    if (!items || items.length !== fresh.length || fresh.some((v, i) => !sameVideoItem(v, items![i]))) {
      if (prior && prior.library.length === fresh.length) {
        items = fresh.map((v, i) => (sameVideoItem(v, prior.library[i]) ? prior.library[i] : v));
      } else {
        items = fresh;
      }
    }
    const grouped: Project["elements"] = { characters: [], locations: [], assets: [], frames: [] };
    for (const e of els) {
      const item: ElementItem = { id: e.id, name: e.name, img: e.image_url, note: e.note };
      if (e.category === "characters" || e.category === "locations" || e.category === "assets" || e.category === "frames") {
        grouped[e.category].push(item);
      }
    }
    const gen = local.drafts[p.id] ?? prior?.gen ?? defaultGen();
    // Server owns auth/bucket; browser keeps YouTube OAuth bits. SA key never
    // comes back down — hasSaJson/saEmail tell the UI what's configured.
    const srvCfg = srvSettings[p.id];
    const yt = local.settings[p.id];
    const settings: Project["settings"] = {
      saJson: "",
      bucket: srvCfg?.bucket ?? "",
      useBucket: srvCfg?.useBucket ?? true,
      authMode: srvCfg?.authMode ?? "service_account",
      // YouTube publish config: server truth once loaded, local cache before that.
      ytClientId: srvCfg?.ytClientId ?? yt?.ytClientId ?? "",
      ytPrivacy: srvCfg?.ytPrivacy ?? yt?.ytPrivacy ?? "unlisted",
      ytCategory: srvCfg?.ytCategory ?? yt?.ytCategory ?? "22",
    };
    if (
      prior && prior.name === p.name && prior.createdAt === p.createdAt &&
      sameGen(gen, prior.gen) && items === prior.library &&
      sameElArr(grouped.characters, prior.elements.characters) &&
      sameElArr(grouped.locations, prior.elements.locations) &&
      sameElArr(grouped.assets, prior.elements.assets) &&
      sameElArr(grouped.frames, prior.elements.frames) &&
      sameSettings(settings, prior.settings)
    ) {
      return prior;
    }
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      gen,
      library: items,
      elements: prior && sameElArr(grouped.characters, prior.elements.characters) &&
        sameElArr(grouped.locations, prior.elements.locations) &&
        sameElArr(grouped.assets, prior.elements.assets) &&
        sameElArr(grouped.frames, prior.elements.frames)
        ? prior.elements : grouped,
      settings: prior && sameSettings(settings, prior.settings) ? prior.settings : settings,
    };
  });
  // Whole-array stability: unchanged projects keep the previous array ref, so
  // whole-store subscribers (sidebar, lists) skip poll ticks entirely.
  if (prev.length === next.length && next.every((p, i) => p === prev[i])) return prev;
  return next;
}

/** Jobs-side change detection for the light poll: only fields the UI renders. */
function sameJobRow(a: ServerJob, b: ServerJob): boolean {
  return (
    a.id === b.id && a.status === b.status && a.progress === b.progress &&
    a.error === b.error && a.costEstimate === b.costEstimate &&
    a.elapsedMs === b.elapsedMs && a.etaMs === b.etaMs &&
    a.updatedAt === b.updatedAt
  );
}

/** Library-side change detection. Thumb data URLs can be ~100KB — compare
 *  length + updated_at instead of the bytes, so the check stays O(1) per row. */
function sameLibraryRow(a: ServerVideo, b: ServerVideo): boolean {
  return (
    a.id === b.id && a.updated_at === b.updated_at &&
    a.video_url === b.video_url && a.thumb_url.length === b.thumb_url.length &&
    a.bytes === b.bytes && a.cost_estimate === b.cost_estimate &&
    a.actual_duration_seconds === b.actual_duration_seconds
  );
}

function rowsSame<T>(prev: T[], next: T[], same: (a: T, b: T) => boolean): boolean {
  if (prev.length !== next.length) return false;
  const byId = new Map<string, T>();
  for (const r of next) byId.set((r as { id: string }).id, r);
  return prev.every((r) => {
    const n = byId.get((r as { id: string }).id);
    return n !== undefined && same(r, n);
  });
}
export const useStudio = create<StudioState>()((set, get) => {
  let local = loadLocal();
  const loaded = new Set<string>();
  // In-flight hydrate promise: never run two hydrates concurrently
  // (StrictMode double-effects / retries would each auto-create projects).
  let hydrating: Promise<void> | null = null;

  const persist = () => saveLocal(local);
  // Keystroke-path writes are throttled: drafts can hold multi-MB image data
  // URLs, and JSON.stringify on every keystroke blocked the main thread while
  // polls were in flight. First change writes through; bursts get 1 write/500ms.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPersist = 0;
  const schedulePersist = () => {
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
  };

  const rebuild = (patch: Partial<StudioState>) => {
    const s = get();
    const projects = buildProjects(s.projects, s.srvProjects, s.elements, s.library, s.jobs, s.srvSettings, local);
    set({ ...patch, projects });
  };

  /** Idle-deferred: thumbnail capture needs video decode + canvas on the main
   *  thread — never inside the poll/fetch critical path. */
  function idleBackfill(projectId: string) {
    const run = () => {
      void backfillThumbs(projectId).catch(() => {});
    };
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
    };
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(run, { timeout: 8000 });
    else setTimeout(run, 2000);
  }

  async function fetchScope(projectId: string) {
    const [els, libs, jobs, cfgResp, totals] = await Promise.all([
      api.listElements(projectId),
      api.listLibrary(projectId),
      api.listJobs(projectId),
      api.getSettings(projectId),
      api.stats().catch(() => null),
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
      ...(totals ? { totals } : {}),
    });
    loaded.add(projectId);
    rebuild({});
    // Fire-and-forget off the critical path (see idleBackfill).
    idleBackfill(projectId);
  }

  // Capture real thumbnails for succeeded videos missing them. Browser-only
  // (canvas) by necessity — Bun has no video decoder. Guarded + capped.
  // Any playable url counts: local /api/media/… as well as direct http(s).
  // gs://-only rows map to url="" and are skipped (nothing playable to grab).
  let backfilling = false;
  let polling = false;
  async function backfillThumbs(projectId: string) {
    if (backfilling) return;
    backfilling = true;
    try {
      const items = (get().projects.find((p) => p.id === projectId)?.library ?? [])
        .filter((v) => v.status === "success" && !v.thumb && !!v.url)
        .slice(0, 3);
      if (!items.length) return;
      const { captureAt } = await import("@/lib/media");
      for (const v of items) {
        try {
          const thumb = await captureAt(authedMediaUrl(v.url), 0.5);
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
      set({ caps, capsReady: true, srvProjects: srv, serverUp: true, lastError: "" });
      void api.stats().then((t) => set({ totals: t })).catch(() => {});
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
      // Strip ?token= from any in-memory playable URLs by rebuilding from the
      // raw server rows (which never carry the token).
      set({ authRequired: true });
      rebuild({});
    },

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
      try {
        await fetchScope(id);
      } catch (e) {
        set({ lastError: errOf(e) });
      }
    },

    pollJobs: async () => {
      const s = get();
      const id = s.activeId;
      if (!id || !s.hydrated) return;
      // Raw jobs first: cheaper than scanning derived projects, and stable.
      if (!s.jobs.some((j) => j.projectId === id && (j.status === "queued" || j.status === "running"))) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (polling) return;
      polling = true;
      try {
        // Light delta: only jobs + library change under a render. Elements,
        // settings and stats are untouched by polling — the old fetchScope
        // re-downloaded all five (including ~100KB thumb data URLs) every 3s.
        const [jobs, libs] = await Promise.all([api.listJobs(id), api.listLibrary(id)]);
        const cur = get();
        const prevJobs = cur.jobs.filter((j) => j.projectId === id);
        const prevLib = cur.library.filter((v) => v.project_id === id);
        if (rowsSame(prevJobs, jobs.jobs, sameJobRow) && rowsSame(prevLib, libs.videos, sameLibraryRow)) {
          return; // unchanged progress tick — zero set() calls, zero re-renders
        }
        set({
          jobs: [...cur.jobs.filter((j) => j.projectId !== id), ...jobs.jobs],
          library: [...cur.library.filter((v) => v.project_id !== id), ...libs.videos],
        });
        rebuild({});
      } catch { /* next tick retries */ }
      finally { polling = false; }
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
      // Mode switch drops other modes' slots: they're invisible in the
      // composer, so stale values must never block the next Generate.
      // Advanced settings reset too — a seed / person rule / negative tuned
      // for one mode must not leak silently into another.
      if (draft.gen.mode !== current.gen.mode) {
        if (draft.gen.mode !== "i2v") draft.gen.image = "";
        if (draft.gen.mode !== "frames") {
          draft.gen.first = "";
          draft.gen.last = "";
        }
        if (draft.gen.mode !== "r2v") draft.gen.refs = [];
        if (draft.gen.mode !== "extend") draft.gen.extendVideo = "";
        draft.gen.seed = "";
        draft.gen.person = "allow_adult";
        draft.gen.negativePrompt = "";
      }
      const m = modelOf(draft.gen.model);
      const resList = m.res;
      const durList = m.dur;
      if (!resList.includes(draft.gen.res)) draft.gen.res = (resList[0] ?? "720p") as GenDraft["res"];
      if (!durList.includes(draft.gen.dur)) draft.gen.dur = durList[durList.length - 1] ?? 8;
      // 1080p/4K render 8s only — snap when the resolution demands it.
      if (draft.gen.res !== "720p" && draft.gen.dur !== 8) draft.gen.dur = 8;
      if (draft.gen.mode === "r2v") draft.gen.dur = 8;
      if (m.silent) draft.gen.audio = false;
      local.drafts[activeId] = draft.gen;
      schedulePersist();
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
          const s = p.library.find((x) => x.id === g.extendVideo);
          base.sourceVideoId = g.extendVideo;
          if (s) {
            base.sourceResolution = s.res;
            base.sourceAspect = s.aspect;
            base.sourceDurationSeconds = expectedDur(s, (id) => p.library.find((x) => x.id === id));
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
        // Fresh composer for the next shot: clear prompt + inputs, keep config.
        // Advanced settings clear too — seed / person / negative belong to
        // the request just used, like the prompt.
        get().updateActive((d) => {
          d.gen.prompt = "";
          d.gen.image = "";
          d.gen.first = "";
          d.gen.last = "";
          d.gen.refs = [];
          d.gen.extendVideo = "";
          d.gen.seed = "";
          d.gen.person = "allow_adult";
          d.gen.negativePrompt = "";
        });
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
      schedulePersist();
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
      rebuild({});
      return { ok: true };
    },

    setYoutube: (videoId, patch) => {
      local.youtube[videoId] = { ...(local.youtube[videoId] ?? {}), ...patch };
      schedulePersist();
      rebuild({});
    },

    serverSettings: (projectId: string) => get().srvSettings[projectId],

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
      }
      rebuild({});
    },
  };
});

// A 401 anywhere means the password changed or the session died: pop the gate.
if (typeof window !== "undefined") {
  onUnauthorized(() => useStudio.setState({ authRequired: true }));
}
