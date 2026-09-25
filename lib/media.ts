// Client-side media helpers (canvas capture). No store imports — pure functions.
// Thumbnails fall back to "" (no fake artwork) when capture fails.
"use client";

export function fileToImage(file: File, maxDim = 768): Promise<string> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.width;
      let h = img.height;
      const s = Math.min(1, maxDim / Math.max(w, h));
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d")?.drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error("bad image"));
    };
    img.src = url;
  });
}

export function captureAt(url: string, t: number | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = url;
    v.onloadedmetadata = () => {
      const target = t == null ? Math.max(0.1, (v.duration || 1) - 0.3) : t;
      try {
        v.currentTime = target;
      } catch (e) {
        reject(e);
      }
    };
    v.onseeked = () => {
      try {
        const w0 = v.videoWidth || 640;
        const h0 = v.videoHeight || 360;
        const s = Math.min(1, 640 / Math.max(w0, h0));
        const c = document.createElement("canvas");
        c.width = Math.round(w0 * s);
        c.height = Math.round(h0 * s);
        c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        reject(e);
      }
    };
    v.onerror = () => reject(new Error("video"));
    setTimeout(() => reject(new Error("timeout")), 10000);
  });
}

export interface CapturedVideo {
  url: string;
  thumb: string;
  meta: { dur: number; res: string; aspect: string };
}

export function captureVideo(file: File): Promise<CapturedVideo> {
  return new Promise((resolve) => {
    let done = false;
    const url = URL.createObjectURL(file);
    const fin = (thumb: string, meta: CapturedVideo["meta"]) => {
      if (!done) {
        done = true;
        resolve({ url, thumb, meta });
      }
    };
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = url;
    v.onloadeddata = () => {
      try {
        v.currentTime = Math.min(0.5, (v.duration || 2) / 2);
      } catch { /* noop */ }
    };
    v.onseeked = () => {
      const w0 = v.videoWidth || 640;
      const h0 = v.videoHeight || 360;
      const meta: CapturedVideo["meta"] = {
        dur: Math.max(1, Math.round(v.duration || 8)),
        res: Math.max(w0, h0) >= 3000 ? "4K" : Math.max(w0, h0) >= 1500 ? "1080p" : "720p",
        aspect: w0 >= h0 ? "16:9" : "9:16",
      };
      try {
        const s = Math.min(1, 480 / Math.max(w0, h0));
        const c = document.createElement("canvas");
        c.width = Math.round(w0 * s);
        c.height = Math.round(h0 * s);
        c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
        fin(c.toDataURL("image/jpeg", 0.75), meta);
      } catch {
        fin("", meta);
      }
    };
    v.onerror = () => fin("", { dur: 8, res: "720p", aspect: "16:9" });
    setTimeout(() => fin("", { dur: 8, res: "720p", aspect: "16:9" }), 8000);
  });
}
