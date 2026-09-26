// YouTube Data API v3 client (resumable upload + status polling).
// Session persists in this browser only (localStorage) — never on the
// server, never anywhere except Google's APIs. The access token itself
// expires ~1h after Google issues it; expiry is enforced on every read.
"use client";

import { useYtAuth } from "@/stores/use-ui";

export const YT_SCOPES =
  "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

import { YT_CATS } from "@/lib/catalog";

export function ytCatLabel(id: string): string {
  return YT_CATS.find((c) => c.id === id)?.label ?? "—";
}

async function ytEnsureGis(): Promise<boolean> {
  const w = window as unknown as { google?: { accounts?: { oauth2?: unknown } } };
  if (w.google?.accounts?.oauth2) return true;
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () => {
      const ww = window as unknown as { google?: { accounts?: { oauth2?: unknown } } };
      fin(!!ww.google?.accounts?.oauth2);
    };
    s.onerror = () => fin(false);
    document.head.appendChild(s);
    setTimeout(() => {
      const ww = window as unknown as { google?: { accounts?: { oauth2?: unknown } } };
      fin(!!ww.google?.accounts?.oauth2);
    }, 8000);
  });
}

export async function ytConnect(clientId: string, opts?: { consent?: boolean }): Promise<{ token: string; exp: number }> {
  const ok = await ytEnsureGis();
  if (!ok) throw new Error("Google sign-in library failed to load. Check connection / ad-blocker and retry.");
  if (!clientId?.trim()) throw new Error("Paste your OAuth Client ID in Settings → YouTube first.");
  const w = window as unknown as {
    google: { accounts: { oauth2: { initTokenClient: (o: Record<string, unknown>) => { requestAccessToken: (o: unknown) => void } } } };
  };
  return new Promise((resolve, reject) => {
    try {
      const tc = w.google.accounts.oauth2.initTokenClient({
        client_id: clientId.trim(),
        scope: YT_SCOPES,
        callback: (resp: { access_token?: string; expires_in?: number; error?: string }) => {
          if (resp?.access_token) {
            resolve({ token: resp.access_token, exp: Date.now() + (resp.expires_in || 3599) * 1e3 });
          } else reject(new Error(resp?.error || "Google sign-in was dismissed."));
        },
        error_callback: (err: { message?: string }) => reject(new Error(err?.message || "Google sign-in failed.")),
      });
      // Forced consent on explicit Connect; quiet (no prompt) for background refresh.
      tc.requestAccessToken(opts?.consent === false ? {} : { prompt: "consent" });
    } catch (e) {
      reject(e);
    }
  });
}

/** Connect + resolve channel name in one step (settings + publish flows). */
export async function ytConnectWithChannel(clientId: string, quiet = false): Promise<{ token: string; exp: number; channel: string; meta: YtChannelMeta | null; account: YtAccountState; detail: string }> {
  const { token, exp } = await ytConnect(clientId, quiet ? { consent: false } : undefined);
  const check = await ytCheckAccount(token);
  const meta = check.state === "ok" ? check.meta : null;
  const detail = check.state === "error" ? check.detail : "";
  return { token, exp, channel: meta?.name ?? "", meta, account: check.state, detail };
}

/** True when an error means "token dead" (expired/revoked) rather than a bad request. */
export function isAuthFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /^HTTP 401\b/.test(msg) || /invalid[_ ]credentials|unauthorized|invalid_grant|login required|authentication required/i.test(msg);
}

async function ytSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Run fn with a live token: quiet-connect when missing/expired, and on an
 * auth failure reconnect once and retry. Reconnect errors (user dismissed)
 * propagate — callers surface them.
 */
export async function withYtAuth<T>(clientId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const connect = async (): Promise<string> => {
    const c = await ytConnectWithChannel(clientId, true);
    useYtAuth.getState().setAuth({ token: c.token, exp: c.exp, channel: c.channel, meta: c.meta, account: c.account, detail: c.detail });
    return c.token;
  };
  const cur = useYtAuth.getState();
  const tok = cur.token && cur.exp > Date.now() ? cur.token : await connect();
  try {
    return await fn(tok);
  } catch (e) {
    if (!isAuthFailure(e)) throw e;
    return fn(await connect());
  }
}

/**
 * Best-effort server-side invalidation on Disconnect (memory-clear alone
 * leaves the token live ~1h). The revoke endpoint has no CORS, so per the
 * docs this goes through a hidden iframe form, fire-and-forget.
 */
export function ytRevokeAccess(token: string): void {
  if (!token || typeof document === "undefined") return;
  try {
    let frame = document.getElementById("yt-revoke-frame") as HTMLIFrameElement | null;
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "yt-revoke-frame";
      frame.name = "yt-revoke-frame";
      frame.style.display = "none";
      document.body.appendChild(frame);
    }
    const form = document.createElement("form");
    form.method = "post";
    form.action = "https://oauth2.googleapis.com/revoke";
    form.target = "yt-revoke-frame";
    form.style.display = "none";
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "token";
    input.value = token;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 5000);
  } catch { /* best-effort */ }
}

export interface YtChannelMeta {
  name: string;
  handle: string;
  avatar: string;
  subs: number | null;
  videos: number | null;
  views: number | null;
}

export type YtAccountState = "unknown" | "ok" | "no-channel" | "error";

export type YtAccountCheck =
  | { state: "ok"; meta: YtChannelMeta }
  | { state: "no-channel" }
  | { state: "error"; detail: string };

/**
 * One channels.list call (snippet + statistics, 1 quota unit). Distinguishes
 * "account has no channel" (uploads WILL fail — needs a channel created)
 * from "couldn't read" (API disabled / blocked network).
 */
export async function ytCheckAccount(token: string): Promise<YtAccountCheck> {
  if (!token) return { state: "error", detail: "no token" };
  let r: Response;
  try {
    r = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true", {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { state: "error", detail: "network unreachable" };
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { state: "error", detail: ytErrText(r.status, body).slice(0, 160) };
  }
  const item = (await r.json().catch(() => ({})))?.items?.[0];
  if (!item) return { state: "no-channel" };
  const sn = item.snippet ?? {};
  const st = item.statistics ?? {};
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    state: "ok",
    meta: {
      name: sn.title ?? "",
      handle: sn.customUrl ?? "",
      avatar: sn.thumbnails?.default?.url ?? "",
      subs: num(st.subscriberCount),
      videos: num(st.videoCount),
      views: num(st.viewCount),
    },
  };
}

/**
 * Re-run the account check against the current token and persist the
 * outcome (used by the Settings backfill + Retry button). Null when there
 * is no token to check. Never throws.
 */
export async function refreshYtAccount(): Promise<YtAccountCheck | null> {
  if (!useYtAuth.getState().token) return null;
  const check = await ytCheckAccount(useYtAuth.getState().token).catch(
    (): YtAccountCheck => ({ state: "error", detail: "network unreachable" }),
  );
  const s = useYtAuth.getState();
  if (!s.token) return check;
  if (check.state === "ok") {
    s.setAuth({ token: s.token, exp: s.exp, channel: check.meta.name || s.channel, meta: check.meta, account: "ok", detail: "" });
  } else if (check.state === "no-channel") {
    s.setAuth({ token: s.token, exp: s.exp, channel: s.channel, meta: null, account: "no-channel", detail: "" });
  } else {
    s.setAuth({ token: s.token, exp: s.exp, channel: s.channel, meta: null, account: "error", detail: check.detail });
  }
  return check;
}

export function ytErrText(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    const e = j?.error?.errors?.[0];
    if (e) return `${e.reason || status} — ${(e.message || "").slice(0, 160)}`;
    if (j?.error?.message) return String(j.error.message).slice(0, 180);
  } catch { /* noop */ }
  return `HTTP ${status} — ${String(body || "").slice(0, 160)}`;
}

/** Plain-language cause for a failed channel check (detail carries Google's own reason). */
export function ytErrorHint(detail: string): string {
  if (/authenticatedUserAccountSuspended|suspended/i.test(detail)) {
    return "This YouTube account is suspended by YouTube — appeal it, or connect a different Google account";
  }
  if (/accessNotConfigured|has not been used|not enabled|disabled/i.test(detail)) {
    return "Enable the YouTube Data API v3 in Google Cloud Console → APIs & Services → Library, for this OAuth project's GCP project";
  }
  if (/insufficient|forbidden|permissions/i.test(detail)) {
    return "Google refused the permission — reconnect and grant both YouTube permissions";
  }
  if (/quotaExceeded/i.test(detail)) {
    return "API quota exhausted — try again after midnight Pacific";
  }
  if (/network unreachable/i.test(detail)) {
    return "Something blocks googleapis.com here (ad-blocker, VPN, firewall)";
  }
  if (/401|invalid[_ ]credentials|unauthorized/i.test(detail)) {
    return "Token rejected — reconnect below";
  }
  return "Check the YouTube Data API is enabled for your OAuth project";
}

export async function ytUploadVideo(opts: {
  token: string; file: Blob; title: string; description: string; tags: string[];
  categoryId: string; privacy: string; madeForKids: boolean; synthetic: boolean;
  onProgress?: (pct: number) => void;
}): Promise<{ id?: string }> {
  const { token, file, title, description, tags, categoryId, privacy, madeForKids, synthetic, onProgress } = opts;
  const total = file.size;
  if (!total) throw new Error("Empty file — re-upload it.");
  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(total),
        "X-Upload-Content-Type": (file as File).type || "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title, description, tags, categoryId },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: !!madeForKids, containsSyntheticMedia: !!synthetic },
      }),
    },
  );
  const initText = await init.text();
  if (!init.ok) throw new Error(ytErrText(init.status, initText) || "Could not start YouTube session.");
  const sessionUrl = init.headers.get("Location");
  if (!sessionUrl) throw new Error("YouTube gave no upload URL. Retry.");
  const CHUNK = 256 * 1024 * 4;
  onProgress?.(0);

  // Byte Google will accept next (Range is 0-based inclusive).
  const nextFromRange = (range: string | null, fallback: number): number => {
    const m = /bytes=\d+-(\d+)/.exec(range ?? "");
    return m ? Math.min(total, parseInt(m[1], 10) + 1) : fallback;
  };

  // Where Google got to (per guide: empty PUT + `bytes */total`).
  const queryNext = async (): Promise<{ done: boolean; id?: string; next: number }> => {
    const q = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Length": "0",
        "Content-Range": `bytes */${total}`,
      },
    });
    const qt = await q.text();
    if (q.status === 200 || q.status === 201) {
      try {
        return { done: true, id: (JSON.parse(qt) as { id?: string }).id, next: total };
      } catch {
        return { done: true, next: total };
      }
    }
    if (q.status === 308) return { done: false, next: nextFromRange(q.headers.get("Range"), 0) };
    throw new Error(ytErrText(q.status, qt));
  };

  const failChunk = (status: number, body: string): never => {
    throw new Error(ytErrText(status, body) || "Upload chunk failed.");
  };

  // One attempt at bytes [s, e): progress recurses fresh; anything else
  // (network drop, unacknowledged 308, 5xx) backs off, asks Google where it
  // got to, and resumes there. 4xx is permanent for this token.
  const put = async (s: number, backoffMs: number, tries: number): Promise<{ id?: string }> => {
    const e = Math.min(s + CHUNK, total);
    let rr: Response | null = null;
    try {
      rr = await fetch(sessionUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": (file as File).type || "video/mp4",
          "Content-Length": String(e - s),
          "Content-Range": `bytes ${s}-${e - 1}/${total}`,
        },
        body: file.slice(s, e),
      });
    } catch { /* network drop → recover below */ }
    if (rr && (rr.status === 200 || rr.status === 201)) {
      try {
        return JSON.parse(await rr.text());
      } catch {
        return {};
      }
    }
    if (rr && rr.status === 308) {
      const next = nextFromRange(rr.headers.get("Range"), s);
      onProgress?.(Math.round((next / total) * 100));
      if (next > s && next < total) return put(next, 1000, 0);
      if (next >= total) throw new Error("YouTube accepted the upload but returned no video ID.");
    }
    if (rr && rr.status !== 308 && rr.status < 500) failChunk(rr.status, await rr.text());
    if (tries >= 5) throw new Error("YouTube upload stalled — retry the upload.");
    await ytSleep(backoffMs);
    const q = await queryNext();
    if (q.done) return { id: q.id };
    return put(q.next, backoffMs * 2, tries + 1);
  };
  return put(0, 1000, 0);
}

export async function ytVideoState(token: string, videoId: string) {
  const r = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}&part=status,processingDetails,statistics,snippet`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await r.json();
  if (j?.error) throw new Error(j.error.message || "YouTube lookup failed.");
  return j?.items?.[0];
}
