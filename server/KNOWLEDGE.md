# Veo on Vertex AI — Knowledge Base (researched 2026-09-25)

> Do not trust `mock/*`. This file is the single source of truth for model
> capabilities, derived from official Google docs fetched Sep 2026.
> All dynamic UI + validation + pricing must import `src/capabilities.ts`,
> which is a typed transcription of this file.

## 1. Supported models (Vertex AI / Agent Platform)

| Model ID | Family | Tier | Stage | Release | Retirement |
|---|---|---|---|---|---|
| `veo-2.0-generate-001` | Veo 2 | Legacy (silent) | GA | 2025 | retiring (legacy) |
| `veo-3.0-generate-001` | Veo 3 | Standard | GA | 2025-07-29 | **2026-06-30** |
| `veo-3.0-fast-generate-001` | Veo 3 | Fast | GA | 2025-07-29 | **2026-06-30** |
| `veo-3.1-generate-001` | Veo 3.1 | Standard | GA | 2025-11-17 | 2026-11-17 or later |
| `veo-3.1-fast-generate-001` | Veo 3.1 | Fast | GA | 2025-11-17 | 2026-11-17 or later |
| `veo-3.1-lite-generate-001` | Veo 3.1 | Lite | Preview | 2026-04-02 | Preview terms |

Notes:
- Veo 3 line retires **2026-06-30** — server keeps them marked `retires:true`
  and UI must warn, but still allows generation until Vertex actually 404s.
- Veo 3.1 is the current default. Lite is cheapest, Preview-gated, no 4K.
- LiteLLM provider surface confirms the same 6 IDs (incl. `veo-3.1-generate-preview`
  aliases for Gemini API). Canonical Vertex IDs above are what we store.

## 2. Generation modes

| Mode | ID | Vertex task | Description |
|---|---|---|---|
| Text-to-video | `t2v` | (default) | prompt only |
| Image-to-video | `i2v` | first-frame | 1 input image = first frame |
| First+last frame | `f2v` | first+last interpolation | 2 input images pin start/end |
| Reference/assets | `r2v` | `reference_to_video` (Subject) | up to 3 subject/style images |
| Extend | `extend` | `extend` | continue an existing clip by +7s |

## 3. Capability matrix (model x mode)

Common to all Veo: **24 fps**, output container **video/mp4**,
aspect ratios **16:9, 9:16** only (no 1:1 on Vertex — 1:1 seen on wrapper
sites is a crop, not native).

### 3.1 Veo 3.1 Standard (`veo-3.1-generate-001`)

- Durations: **4, 6, 8s**. Exception: `r2v` (reference) **8s only**.
- Resolutions: output **720p, 1080p, 4K**. Input (I2V/F2V) **720p, 1080p**.
  1080p/4K require 8s duration (shorter durations fall back to 720p on Vertex).
- Audio: native, toggleable (`generateAudio`). Costs ~2x.
- Input limits: I2V 1 image ≤20MB; F2V exactly 2 images; R2V 1–3 images
  (`referenceType: asset`); T2V prompt only.
- Output limits: up to **4 videos per prompt** (`sampleCount 1–4`); each is a
  separate billable clip.
- Extend: supported, 720p/1080p/4K (see §4).

### 3.2 Veo 3.1 Fast (`veo-3.1-fast-generate-001`)

- Same as Standard except output resolutions **720p, 1080p, 4K** (4K allowed
  but priced separately), durations 4/6/8s (R2V 8s only), audio toggleable.
- Cheaper + lower latency. Quality tradeoff.

### 3.3 Veo 3.1 Lite (`veo-3.1-lite-generate-001`, Preview)

- Durations 4/6/8s (R2V 8s only). Output **720p, 1080p only — no 4K**.
- Reference (R2V): **not supported** on Lite per console task menu
  (our matrix disables it; Vertex returns 400 if attempted).
- Extend: supported but output capped at 720p/1080p.
- Cheapest tier for iteration.

### 3.4 Veo 3 / 3 Fast (`veo-3.0-generate-001`, `veo-3.0-fast-generate-001`)

- Durations 4/6/8s. Output **720p, 1080p** (no 4K). 24fps, 16:9/9:16.
- Audio: native, toggleable.
- I2V supported (≤20MB). **R2V not supported. Extend not supported.
  F2V not supported** on Veo 3 (first+last interpolation is 3.1+).
- Up to 4 outputs per prompt. Retire 2026-06-30.

### 3.5 Veo 2 (`veo-2.0-generate-001`)

- Silent (no audio ever). Output **720p only**.
- Durations observed **5–8s** in console variants; API `durationSeconds`
  accepts 5–8. We allow [5,6,7,8]; default 8.
- I2V + F2V + R2V supported (legacy advanced controls); Extend **not**
  supported via public task menu (advanced-controls SKU exists but is not
  the same `extend` task — we disable Extend for Veo 2).
- Aspect 16:9/9:16. 24fps.

## 3d. Media library honesty (what's verified where)

- **MediaBunny is demux-only in Bun** (no WebCodecs decoder): duration,
  dimensions, codec, keyframe index via `probeVideoMetadata` — including
  verifying import uploads server-side instead of trusting client meta.
  Pixel decode (`VideoSampleSink`) degrades gracefully where no decoder exists.
- **Still dimensions come from `Bun.Image.metadata()`** (header-only, native):
  the f2v aspect-pairing rule is enforced at submit (`FRAMES_ASPECT_MISMATCH`),
  not just in the browser pre-check.

## 3c. Server media store (what persists where)

- **Elements/images:** inline data-URL uploads persist in sqlite (≤20 MB
  JPEG/PNG); remote URLs stay URLs and are fetched (capped, sniffed) at
  submit time.
- **Videos:** `data/media/` file store (`media` table index) + `POST
  /media/upload` (multipart, 200 MB cap, video/image only) and
  `GET /media/:id` with Range support. Deleting a library row deletes its
  hosted file; GCS objects are left alone.
- **Generations:** on success the server archives output bytes — GCS object
  download preferred, inline LRO payload as fallback — into the media store.
  `library.video_url` is the playable `/media/…` URL; `gcs_uri` keeps the
  chainable URI. Archival never fails the job (falls back to URI/empty).
- **Uploads:** web uploads the file first, then imports with `mediaId` —
  playable and extendable across reloads.
- **Extend resolution order:** explicit `sourceVideoGcsUri` → chained
  `gcs_uri` → on-disk `/media` bytes (≤20 MB inline) → request inline
  `sourceVideoBytes` → clear `EXTEND_NEEDS_SOURCE` / `EXTEND_SOURCE_TOO_BIG`.

## 3b. Image-input limits (all slots)

Counts per request — slots are mutually exclusive (one slot only, enforced
as `MIXED_INPUTS`):

| Slot | Max | Mode |
|---|---|---|
| image (first frame) | 1 | Image-to-video |
| image + lastFrame | 2 (start + end pair) | Frames-to-video |
| referenceImages | 3 asset (3.1/3.1 Fast, Veo 2) | Reference-to-video |
| video | 1 (GCS URI recommended, Base64 ≤20 MB) | Extend |

Per-image: **≤20 MB each**, **JPEG/PNG only** (magic-byte sniffed, not just
Content-Type). Inline uploads are inspected at element creation
(`E_IMAGE_TYPE`/`E_IMAGE_TOO_LARGE`); remote URLs are fetched with a hard
cap and sniffed at submit time. Frames pairing: both stills should share the
requested output aspect (client pre-check; mismatches fail or get cropped).
References should depict the same subject — conflicting images dilute
identity (guidance, not verifiable). R2V duration lock (8 s only) and
sampleCount 1–4 per mode already in §3.

## 4. Extend rules (strict)

Official extend-video docs (Agent Platform):

- Input: **MP4**, **1–30s** long, **24fps**, resolution **720p/1080p/4K**,
  aspect **16:9 or 9:16**. Two accepted shapes (mirrors the GenAI SDK
  `Video` type): **GCS URI (recommended)** — `video: {gcsUri, mimeType}` —
  and **inline Base64 bytes** — `video: {bytesBase64Encoded, mimeType}` —
  capped at 20 MB like input images. Older REST reports of bytes being
  rejected in the video object appear version-dependent; the current SDK
  accepts both, with URI strongly preferred past a few MB (Base64 JSON
  payloads get fragile). Our server resolves GCS first, bytes second.
- Output: **exactly +7s** appended per call.
- Total cap: **37s for Veo**, 40s for Gemini Omni Flash. Chaining extend
  calls is how >8s films are built (Flow Scene Builder does the same).
- Our server additionally enforces (validation.ts):
  1. `sourceDuration + 7 <= 37` else 422 (`EXTEND_CAP_EXCEEDED`).
  2. **Same resolution as source — resolution switch is rejected**
     (`EXTEND_RESOLUTION_MISMATCH`). Rationale: Vertex infers/keeps the
     source raster; requesting 1080p from a 720p source either 400s or
     silently upscales with a surprise 4K-tier charge. Task spec mandates
     rejection, so we reject.
  3. Same aspect ratio likewise rejected on mismatch.
  4. Extend input must reference a completed library video (or explicit
     `sourceVideoId` + stored provenance), plus a prompt describing the
     continuation. Audio flag may be toggled only if the model supports it.

## 5. Auth, regions, quotas, buckets

- **Default auth: service-account JSON, pasted in Settings.**
  The key carries `project_id`, `client_email`, `private_key` — nothing else
  is needed. Server signs an RS256 JWT assertion (Bun WebCrypto, zero deps)
  and exchanges it at `https://oauth2.googleapis.com/token` for a cached
  Bearer access token (`cloud-platform` scope), used for Vertex calls.
  Keys live in the server DB (`project_settings.sa_json`) and are never
  returned by the API (`GET settings` exposes only `hasSaJson/saEmail`).
- **Environment auth is opt-in per project** (`authMode: env`), using
  `GOOGLE_CLOUD_PROJECT`/`VERTEX_ACCESS_TOKEN`. Without a key or env creds,
  jobs fail with an actionable `E_SA_MISSING` / `E_VERTEX_NOT_CONFIGURED`.
- **Bucket (`use_bucket`, default on):** when a bucket is set, submits carry
  `storageUri: gs://{bucket}/veo/` so Vertex writes outputs to Cloud Storage,
  and the output URI is stored as the library `video_url` — which is what
  makes **Extend chaining work headless** (extend sources must be `gs://`
  URIs: an explicit `sourceVideoGcsUri` or a previous bucket output).
  With the bucket off, outputs return inline and Extend is unavailable
  (`EXTEND_NEEDS_GCS`).
- **Bucket validation (before save):** a bucket ID is checked with
  `testIamPermissions` for `storage.objects.get/list` — the SA needs
  **Storage Object User** (`roles/storage.objectUser`: object read+write,
  no bucket admin), which is enough. A plain metadata GET is deliberately
  NOT the gate, since Object User lacks `storage.buckets.get`.
  Vertex's own service agent separately needs Storage Object Creator for
  outputs; unreachable/missing buckets map to `E_BUCKET_*` and are never saved.
- Regions: Veo serves from **`us-central1`** (set `VERTEXAI_LOCATION` to change).
  Server stores `region` per job, defaults `us-central1`.
- Quotas (per project, per base model, per minute, per region):
  Veo 3.x **10 online prediction requests/min**; Veo 3.1 **50/min**
  (model page "Fixed quota" table). Exceeding yields `RESOURCE_EXHAUSTED`
  — jobs surface it as `failed` with retryable hint, never silently dropped.
- IAM + billing must exist before first call; enable `aiplatform.googleapis.com`.

## 6. Pricing (official, USD per output second)

Source: `cloud.google.com/vertex-ai/generative-ai/pricing` → Veo table
(fetched Sep 2026; table header says "/1 count" but rows are per-second —
confirmed by $0.40×8=$3.20 examples across trackers and LiteLLM usage).

| Model | Video+Audio /s | Video only /s |
|---|---|---|
| Veo 3.1 Standard 720p | 0.40 | 0.20 |
| Veo 3.1 Standard 1080p | 0.40 | 0.20 |
| Veo 3.1 Standard 4K | 0.60 | 0.40 |
| Veo 3.1 Fast 720p | 0.10 | 0.08 |
| Veo 3.1 Fast 1080p | 0.12 | 0.10 |
| Veo 3.1 Fast 4K | 0.30 | 0.25 |
| Veo 3.1 Lite 720p | 0.05 | 0.03 |
| Veo 3.1 Lite 1080p | 0.08 | 0.05 |
| Veo 3 Standard 720p/1080p | 0.40 | 0.20 |
| Veo 3 Fast 720p | 0.10 | 0.08 |
| Veo 3 Fast 1080p | 0.12 | 0.10 |
| Veo 2 720p (silent) | n/a | 0.50 |

Formula: `cost = rate(model, resolution, audio) × durationSeconds × sampleCount`.
Disabling audio roughly halves Standard cost — surface this in UI.
`GET /models/capabilities` returns this table machine-readable so the UI can
price live before submitting.

## 6b. Crash semantics (server restart mid-generation)

- Boot runs `recoverInterrupted()`: jobs WITH a Vertex operation resume
  polling it (never resubmitted — no double spend); jobs WITHOUT one are
  marked failed/`SERVER_RESTARTED` (Vertex was never called: no charge).
- With bucket: Vertex finishes server-side into `gs://`; recovery archives
  the output into the library as if nothing happened.
- Without bucket: Vertex still completes and bills, but nobody fetched the
  inline bytes — output is lost unless the LRO is still queryable at boot
  (recovery polls it and archives when reachable).

## 7. Cancellation + billing on cancel

- Vertex LROs expose **`operations.cancel`** (REST
  `POST /v1/{name}:cancel`, GenAI SDK `client.operations.cancel`).
  Semantics: "best effort, success is not guaranteed".
- Billing: Vertex charges **only requests returning 200 with output**.
  4xx/5xx are not charged. A successfully cancelled operation returns
  `cancelled:true, done:true` with **no video** → **no per-second charge**,
  because no output seconds were produced.
- Race: if cancel lands after the operation already completed, the video
  exists and the **full per-second charge applies** — cancel is a no-op.
  Our `POST /jobs/:id/cancel` therefore returns `cancelled | already_done`
  so the UI can display "cancelled — no charge" vs "already completed —
  full charge".
- Server never bills locally; `costEstimate` is an estimate from §6 for
  display. Ground truth is Cloud Billing.

## 8. Async: idempotency, polling, webhooks

- Vertex video generation is a **long-running operation (LRO)**:
  `predictLongRunning` → `{ name: operations/… }` → poll
  `GET /v1/{name}` until `done:true` (typical 60s–6min). Never block HTTP.
- Idempotency: Vertex has **no native idempotency key**. Our server
  implements it: `POST /composer/jobs` requires `Idempotency-Key` header
  (or `idempotencyKey` body field); key is UNIQUE per project. Retries with
  the same key return the original `jobId` without creating a duplicate or
  spending twice.
- Polling (headless contract): `POST /composer/jobs → { jobId }` (202),
  then `GET /jobs/:id` until `status: succeeded|failed|cancelled`.
  `GET /library` / `GET /library/:id` expose finished provenance.
  Job payloads carry `elapsedMs`/`etaMs`/`etaSource`: the server records
  Vertex submit time and completion durations, serving the measured median
  of the last 20 successes per model (tier-typical fallback until then) —
  there is no percent-complete API on Vertex LROs, so progress is
  elapsed-vs-ETA, never fake precision.
- Webhooks: Gemini API supports **webhooks for background execution**
  (`webhooks` docs); Vertex proper does not push — clients poll. Our server
  accepts optional `webhookUrl` on job creation and POSTs a signed
  completion payload when the LRO resolves, giving webhook semantics on top
  of polling. Delivery failures are logged, never fail the job.

## 9. Sources (all fetched Sep 2026)

- `ai.google.dev/gemini-api/docs/video` — Veo vs Omni Flash positioning
- `ai.google.dev/gemini-api/docs/veo` — GenerateVideosConfig: aspect_ratio,
  resolution (720p/1080p/4K), 8s clips, ≤3 reference images, extension 720p note
- `docs.cloud.google.com/.../models/veo/3-1-generate` — 3.1 tiers, 4/6/8s,
  R2V 8s-only, input 720p/1080p, output 720p/1080p/4K, 24fps, quotas, GA dates
- `docs.cloud.google.com/.../models/veo/3-0-generate` — Veo 3 specs: 4/6/8s,
  ≤4 outputs, ≤20MB image, 9:16/16:9, 720p/1080p, 24fps, us-central1,
  10 req/min, retire 2026-06-30
- `docs.cloud.google.com/.../models/video/extend-videos` — input 1–30s MP4
  24fps, +7s output, 37s Veo cap (40s Omni)
- `docs.cloud.google.com/.../models/video/generate-videos-from-references`
  — R2V subject task, aspect/resolution/duration params, asset type
- `docs.cloud.google.com/.../models/video/generate-videos-from-first-and-last-frames`
  — F2V interpolation
- `cloud.google.com/vertex-ai/generative-ai/pricing` — Veo per-second table
- `docs.cloud.google.com/.../machine-learning/general/long-running-operations`
  + `reference/rest/v1/projects.locations.operations/cancel` — cancel best-effort
- `docs.litellm.ai/docs/providers/vertex_ai/videos` — 6 model IDs, durations,
  size→aspect/resolution mapping, duration-based cost tracking
- `aistudio.google.com/models/veo-3` — 24fps, 4/6/8s, 8s-only for 1080p+/refs
