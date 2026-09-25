# Veo headless server

Bun-first video-generation backend for Veo on Vertex AI. Hono (`Bun.serve`) + `bun:sqlite` + `pino` + MediaBunny. No ffmpeg.

## Quick start

```sh
bun install                    # from repo root (workspaces)
bun --filter server dev        # API on 127.0.0.1:8787
# or everything: bun run dev  (Next :3000 + API :8787 in parallel)
```

Vertex calls need credentials (otherwise jobs fail honestly instead of mocking):

```sh
GOOGLE_CLOUD_PROJECT=… VERTEX_ACCESS_TOKEN=… VERTEXAI_LOCATION=us-central1
```

Or paste a service-account key in project Settings — the default auth path (see [Auth & buckets](#auth--buckets)).

> [!NOTE]
> `server/KNOWLEDGE.md` is the researched source of truth for capabilities and pricing. `src/capabilities.ts` is its typed transcription — the UI and validation must import it, never hardcode the matrix.

## Contract

All errors are `{ error: { code, message, details? } }`.

- `POST /composer/jobs` (header `Idempotency-Key` required, or `idempotencyKey` body field) → `202 { jobId, deduped }`. Never blocks: the job submits to Vertex in the background (`predictLongRunning`) and is polled (`fetchPredictOperation`). Retries with the same key return the original job — no double spend.
- `GET /jobs/:id` — poll `queued → running → succeeded | failed | cancelled`. Payloads carry `elapsedMs` / `etaMs` / `etaSource` (measured median of last 20 successes per model, else tier-typical estimate).
- `GET /jobs?projectId=` — recent jobs (limit 200). `DELETE /jobs/:id` removes terminal records only.
- `POST /jobs/:id/cancel` — best-effort cancel. Returns `cancelled` (no output, no per-second charge) or `already_done` (clip completed, full charge applies) with a `costImplication` string.
- `GET /library[?projectId=]`, `GET /library/:id` — finished videos + provenance (`video_url`, `gcs_uri`, model, inputs). `PATCH /library/:id` sets a browser-captured thumbnail; `DELETE` also drops the hosted file. `POST /library/import` registers an upload (server probes the container rather than trusting client meta).
- `GET /models/capabilities` — machine-readable matrix from `KNOWLEDGE.md` (models × modes, resolutions, durations, audio, quotas) + per-second pricing + defaults. Drive all UI enable/disable and live price math from this.
- `POST /frames/extract` (multipart `video`, optional `count` 1–10) — MediaBunny demux: duration, dimensions, codec, keyframe index. Pixel thumbnails are best-effort: Bun has no WebCodecs `VideoDecoder`, so headless responses carry `thumbnailStatus: "decoder-unavailable-in-this-runtime"` with `thumbnails: []`; the same code returns base64 PNGs where a decoder exists.
- CRUD: `POST/GET /projects`, `GET/PATCH/DELETE /projects/:id`, `/projects/:id/elements` (`characters | locations | assets | frames`), `PATCH/DELETE /elements/:id`.
- `GET/PATCH /projects/:id/settings` — service-account JSON (write-only), bucket, `useBucket` toggle, `authMode` (`service_account` default | `env`). Reads expose only `hasSaJson` / `saEmail` / `saProjectId`, never the key. Writes are **verified live before saving** (fresh keys must mint a token; buckets must exist and grant at least object read).
- `POST /media/upload` (multipart `file`, 200 MB cap, video/image only) + `GET /media/:id` (Range-capable) — the server file store behind uploads and archived outputs.
- `GET /backup?elements=|generated=|uploads=` (tar.gz download) + `POST /restore` (multipart, full merge with per-table counts) + `POST /restore/inspect` (dry-run counts + manifest).
- `GET /health` → `{ ok: true }`.

## Rules enforced (`src/validation.ts`)

- Input slots are mutually exclusive (one per request): prompt | 1 image | first+last pair | 1–3 refs | video source. Stale fields from another mode are rejected as `MIXED_INPUTS`, not ignored.
- `i2v` needs `imageAssetId`; `f2v` needs both frame IDs; `r2v` needs 1–3 refs (and 8s); `extend` needs `sourceVideoId`.
- Images: JPEG/PNG only (magic-byte sniffed), ≤20 MB each. Inline uploads checked at element creation; remote URLs fetched with a hard cap and sniffed at submit.
- `extend`: exactly +7s, total ≤ 37s (`EXTEND_CAP_EXCEEDED`), **same resolution and aspect as source** (`EXTEND_RESOLUTION_MISMATCH` / `EXTEND_ASPECT_MISMATCH` — switches are rejected, never silently upscaled).
- 1080p/4K are 8s-only; audio can only be on for models with native audio; `sampleCount` ≤ model `maxOutputs`.
- Extend source resolution order: explicit `sourceVideoGcsUri` → chained `gcs_uri` → on-disk `/media` bytes (≤20 MB inline) → request-inline `sourceVideoBytes` → `EXTEND_NEEDS_SOURCE` / `EXTEND_SOURCE_TOO_BIG`. Without a bucket, outputs are inline-only and Extend is unavailable (`EXTEND_NEEDS_GCS`).

## Auth & buckets

- **Default: service-account JSON per project.** The server signs an RS256 JWT (Bun WebCrypto, zero deps) and exchanges it for a cached Bearer token (`cloud-platform` scope). Keys stay in `project_settings.sa_json` and are never returned.
- **Opt-in env auth** (`authMode: env`) uses `GOOGLE_CLOUD_PROJECT` / `VERTEX_ACCESS_TOKEN`.
- **Bucket (`useBucket`, default on):** submits carry `storageUri: gs://{bucket}/veo/` so Vertex writes outputs to GCS — this is what makes Extend chaining work headless. On success the server archives output bytes (GCS download preferred, inline LRO payload fallback) into the media store; `library.video_url` is the playable `/media/…` URL and `gcs_uri` keeps the chainable URI. Archival never fails the job.
- **Bucket check before save:** `testIamPermissions` for `storage.objects.get/list` — Storage Object User suffices (a plain metadata GET is deliberately not the gate). Vertex's service agent separately needs Storage Object Creator.
- Region defaults to `us-central1` (`VERTEXAI_LOCATION` overrides). Quotas: Veo 3.x 10 req/min, Veo 3.1 50 req/min per base model per region — over-quota surfaces as failed with a retryable hint.

## Billing & crash semantics

- Vertex charges only 200s that produce output; 4xx/5xx are not charged. Local `costEstimate = rate(model, resolution, audio) × durationSeconds × sampleCount` is display-only — ground truth is Cloud Billing.
- Boot runs `recoverInterrupted()`: jobs *with* a Vertex operation resume polling (never resubmitted — no double spend); jobs *without* one are marked `SERVER_RESTARTED` (Vertex was never called, no charge). With a bucket, outputs land in `gs://` and recovery archives them; without one, output is lost unless the LRO is still queryable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `API_HOST` | `127.0.0.1` | Bind address |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | CORS allowlist (comma-separated) |
| `SQLITE_FILE` | `server/data/veo.sqlite` | DB path |
| `MEDIA_DIR` | `server/data/media` | File store |
| `GOOGLE_CLOUD_PROJECT`, `VERTEX_ACCESS_TOKEN`, `VERTEXAI_LOCATION` | — | Env-mode credentials (`us-central1` default region) |
| `VEO_PASSWORD` | — (open) | Access password. When set, every route except `/health` and `/auth/status` requires `Authorization: Bearer <pw>` (constant-time compare, 401 `UNAUTHORIZED` otherwise). Web UI prompts once per tab (sessionStorage) |
| `LOG_LEVEL` | `info` | pino level |

## Layout

```text
server/
  KNOWLEDGE.md         researched capability/pricing source of truth
  src/capabilities.ts  typed matrix (transcription of KNOWLEDGE.md)
  src/pricing.ts       per-second rates + estimateCost()
  src/validation.ts    zod schemas + mode/extend rules
  src/vertex.ts        real Vertex LRO adapter (no mocks)
  src/auth.ts          SA JWT minting + token cache
  src/gcs.ts           bucket checks + output download
  src/jobs.ts          idempotent async jobs + polling + cancel + webhooks + recovery
  src/db.ts            bun:sqlite schema (projects/elements/jobs/library/settings)
  src/media-store.ts   data/media file store
  src/images.ts        magic-byte sniffing + size gates
  src/frames.ts        MediaBunny extraction + hand-rolled PNG encoder
  src/backup.ts        tar.gz export/import
  src/routes.ts        Hono routes
  src/index.ts         entrypoint (Bun.serve)
  tests/               bun:test (validation, pricing, jobs, frames)
```

## Test / typecheck

```sh
bun --filter server test && bun --filter server typecheck
```

## Web integration

The Next app talks to this API exclusively through `lib/api.ts` — no mocks. Same-origin `/api` (Next rewrite to `API_PROXY_TARGET`) by default; override with `NEXT_PUBLIC_API_URL`. Browser calls need CORS: allowed origins come from `ALLOWED_ORIGINS`.

Server-owned: projects, elements, jobs, library, capabilities. Web-local (`localStorage veo-web-v1`): gen drafts, project settings, YouTube publish state. Uploaded-video playback URLs are session-only blobs; the server keeps provenance + thumbnails.
