# veo headless server

Bun-first video-generation backend for Veo on Vertex AI.
Hono (`Bun.serve`) + `bun:sqlite` + `pino` + MediaBunny. No ffmpeg.

## Quick start

```sh
bun install          # from repo root (workspaces)
bun --filter server dev   # API on :8787
# or everything: bun run dev   (Next :3000 + API :8787 in parallel)
```

Vertex calls need (otherwise jobs fail honestly with `E_VERTEX_NOT_CONFIGURED`):

```sh
GOOGLE_CLOUD_PROJECT=… VERTEX_ACCESS_TOKEN=… VERTEXAI_LOCATION=us-central1
```

## Contract

- `POST /composer/jobs` (header `Idempotency-Key` required) → `202 { jobId }`.
  Never blocks: the job is submitted to Vertex in the background and polled
  (`predictLongRunning` → `operations.get`).
- `GET /jobs/:id` — poll for `queued → running → succeeded|failed|cancelled`.
- `POST /jobs/:id/cancel` — best-effort Vertex `operations.cancel`.
  `cancelled` = no output produced = no per-second charge;
  `already_done` = full charge applies (see `KNOWLEDGE.md` §7).
- `GET /library[?projectId=]`, `GET /library/:id` — finished videos + provenance.
- `GET /models/capabilities` — machine-readable matrix from `KNOWLEDGE.md`
  (models × modes, resolutions, durations, audio) + per-second pricing.
  Drive all UI enable/disable + live price math from this.
- `POST /frames/extract` (multipart `video`, optional `count`) — MediaBunny
  demux: duration, dimensions, codec, keyframe index. Pixel thumbnails are
  best-effort: Bun has no WebCodecs `VideoDecoder`, so headless responses
  carry `thumbnailStatus: "decoder-unavailable-in-this-runtime"` with
  `thumbnails: []`; the same code returns base64 PNGs where a decoder exists.
- CRUD: `/projects`, `/projects/:id/elements` (`characters|locations|assets|frames`).

## Rules enforced (see `src/validation.ts`)

- `f2v` needs first+last frame; `r2v` needs 1–3 refs (and 8s);
  `i2v` needs an image; `extend` needs `sourceVideoId`.
- `extend`: exactly +7s, total ≤ 37s, **same resolution/aspect as source**
  (switches are rejected, not silently upscaled).
- Errors: `{ error: { code, message, details? } }`.

## Layout

```
server/
  KNOWLEDGE.md      researched capability/pricing source of truth
  src/capabilities.ts  typed matrix (transcription of KNOWLEDGE.md)
  src/pricing.ts       per-second rates + estimateCost()
  src/validation.ts    zod schemas + mode/extend rules
  src/vertex.ts        real Vertex LRO adapter (no mocks)
  src/jobs.ts          idempotent async jobs + polling + cancel + webhooks
  src/db.ts            bun:sqlite schema (projects/elements/jobs/library)
  src/frames.ts        MediaBunny extraction + hand-rolled PNG encoder
  src/routes.ts        Hono routes
  src/index.ts         entrypoint (Bun.serve)
  tests/               bun:test (validation, pricing, jobs, frames)
```

## Test / typecheck

```sh
bun --filter server test && bun --filter server typecheck
```
