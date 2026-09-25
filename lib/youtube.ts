// YouTube Data API v3 client (resumable upload + status polling).
// Token lives in-memory only (zustand), never persisted — matches reference HTML.
"use client";

export const YT_SCOPES =
  "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";

export function ytCatLabel(id: string): string {
  const map: Record<string, string> = {
    "22": "People & Blogs", "28": "Science & Tech", "24": "Entertainment",
    "27": "Education", "10": "Music", "17": "Sports",
  };
  return map[id] ?? "—";
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

export async function ytConnect(clientId: string): Promise<{ token: string; exp: number }> {
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
      tc.requestAccessToken({ prompt: "consent" });
    } catch (e) {
      reject(e);
    }
  });
}

export async function ytFetchChannel(token: string): Promise<string> {
  if (!token) return "";
  try {
    const r = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    return j?.items?.[0]?.snippet?.title ?? "";
  } catch {
    return "";
  }
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

export async function ytUploadVideo(opts: {
  token: string; file: Blob; title: string; description: string; tags: string[];
  categoryId: string; privacy: string; madeForKids: boolean; synthetic: boolean;
  onProgress?: (pct: number) => void;
}): Promise<{ id?: string }> {
  const { token, file, title, description, tags, categoryId, privacy, madeForKids, synthetic, onProgress } = opts;
  const total = file.size;
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
  let start = 0;
  const put = async (s: number, e: number): Promise<{ id?: string }> => {
    const end = Math.min(e, total);
    const rr = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": (file as File).type || "video/mp4",
        "Content-Length": String(end - s),
        "Content-Range": `bytes ${s}-${end - 1}/${total}`,
      },
      body: file.slice(s, end),
    });
    const tt = await rr.text();
    if (rr.status === 200 || rr.status === 201) {
      try { return JSON.parse(tt); } catch { return {}; }
    }
    if (rr.status === 308) {
      const rg = rr.headers.get("Range");
      let next = end;
      if (rg) {
        const m = rg.match(/bytes=\d+-(\d+)/);
        if (m) next = Math.min(total, parseInt(m[1], 10) + 1);
      }
      onProgress?.(Math.round((next / total) * 100));
      start = next;
      if (start >= total) return {};
      return put(start, start + CHUNK);
    }
    throw new Error(ytErrText(rr.status, tt) || "Upload chunk failed.");
  };
  return put(0, CHUNK);
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
