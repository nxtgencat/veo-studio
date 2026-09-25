# Veo Studio

AI video studio for Veo on Vertex AI. A Next.js web app backed by a Bun-first headless API — generate, extend, and manage video clips with live capabilities, pricing, and provenance.

## Overview

Veo Studio is a monorepo with two parts:

- **Web (`/app`, `/components`, `/stores`, `/lib`)** — project workspace for composing generations (text, image, frames, reference, extend), tracking jobs, and browsing a video library. Talks to the API exclusively through `lib/api.ts`; no mocks.
- **Server (`/server`)** — Hono API on Bun + `bun:sqlite` + MediaBunny. Submits real Vertex AI long-running operations, polls them, archives outputs, and enforces the Veo capability/pricing rules documented in `server/KNOWLEDGE.md`.

> [!NOTE]
> Without Vertex credentials the app still runs, but jobs fail honestly with `E_SA_MISSING` / `E_VERTEX_NOT_CONFIGURED`. Nothing is mocked.

## Features

- Five generation modes: text (`t2v`), image (`i2v`), first+last frame (`f2v`), reference/assets (`r2v`), extend (`extend`, +7s per call up to 37s total)
- Six Veo models (Veo 3.1 Standard/Fast/Lite, Veo 3/3 Fast, Veo 2) with machine-readable capabilities at `GET /models/capabilities`
- Live cost estimates from official per-second pricing; disabling audio roughly halves Standard cost
- Async jobs with idempotency keys, polling (`queued → running → succeeded | failed | cancelled`), best-effort cancel, and optional webhooks
- Projects, reusable elements (characters / locations / assets / frames), video library with provenance
- Service-account auth pasted in Settings (verified live before saving) or env-token auth per project
- GCS bucket integration so outputs are chainable for Extend; media store with Range downloads; tar.gz backup/restore
- Frame/metadata extraction via MediaBunny, no ffmpeg

## Architecture

```text
Browser (Next.js :3000)
  └─ /api/* ──proxy──▶ Hono API (Bun :8787)
                          ├─ bun:sqlite (projects / elements / jobs / library / settings)
                          ├─ data/media/ file store
                          └─ Vertex AI (predictLongRunning → fetchPredictOperation)
                               └─ optional gs:// bucket for outputs
```

Web-local state (drafts, YouTube publish state) lives in `localStorage` under `veo-web-v1`. Everything else is server-owned.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) 1.4.2 (`packageManager: bun@1.4.2`)
- A Google Cloud project with `aiplatform.googleapis.com` enabled and billing on
- Either a service-account JSON (Storage Object User is enough) or `VERTEX_ACCESS_TOKEN`

### Run locally

```sh
bun install
bun run dev              # web :3000 + API :8787 in parallel
# or individually:
bun run dev:web          # next dev
bun run --filter server dev
```

Open [http://localhost:3000](http://localhost:3000). The API serves on `http://localhost:8787` (`GET /health`).

> [!TIP]
> The web app calls same-origin `/api` by default (rewritten to the backend). Set `NEXT_PUBLIC_API_URL=http://localhost:8787` to call the backend origin directly, and `ALLOWED_ORIGINS` on the server to match.

### Configure credentials

1. Open a project → Settings.
2. Paste the service-account JSON and (recommended) a GCS bucket name, keep `useBucket` on.
3. Save — the server mints a token with the fresh key and checks bucket access *before* persisting. Failures return coded errors (`E_SA_*`, `E_BUCKET_*`) and save nothing.

For headless/env auth instead, set per-project `authMode: env` and export:

```sh
GOOGLE_CLOUD_PROJECT=… VERTEX_ACCESS_TOKEN=… VERTEXAI_LOCATION=us-central1
```

## Usage

1. Create a project.
2. Add elements (reference stills) or upload a video (`POST /media/upload` → import).
3. Compose a job — model, mode, resolution, aspect, duration, audio, seed. The UI disables invalid combos from `/models/capabilities` and shows the live price.
4. Submit (`POST /composer/jobs` with `Idempotency-Key`), poll `GET /jobs/:id`, find finished clips in the library.
5. Extend a finished clip to grow it +7s at a time (same resolution/aspect, bucket-backed sources preferred).

Generation modes at a glance:

| Mode | Input | Notes |
| --- | --- | --- |
| `t2v` | prompt | Any model |
| `i2v` | 1 image (≤20 MB JPEG/PNG) | Any model |
| `f2v` | first + last frame | Veo 3.1 family + Veo 2 |
| `r2v` | 1–3 refs, 8s only | 3.1 Standard/Fast, Veo 2 (not Lite, not Veo 3) |
| `extend` | source video | 3.1 family only, +7s, ≤37s total |

1080p/4K require 8s; Veo 3 models retire 2026-06-30 (still selectable with a warning).

## Configuration

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | web | `/api` | Backend origin override |
| `API_PROXY_TARGET` | web | `http://127.0.0.1:8787` | Next rewrite target for `/api/*` |
| `PORT` / `API_PORT` | server | `8787` | API listen port |
| `API_HOST` | server | `127.0.0.1` | API bind address |
| `ALLOWED_ORIGINS` | server | `http://localhost:3000` | CORS allowlist (comma-separated) |
| `SQLITE_FILE` / `MEDIA_DIR` | server | `server/data/*` | DB path / media store |
| `GOOGLE_CLOUD_PROJECT`, `VERTEX_ACCESS_TOKEN`, `VERTEXAI_LOCATION` | server | — | Env-mode Vertex auth (`us-central1` default) |
| `VEO_PASSWORD` | server | — (open) | Access password: all API routes except `/health` + `/auth/status` require `Authorization: Bearer`. Web prompts once, stays signed in (lock from header) |
| `LOG_LEVEL` | server | info | pino log level |

## Scripts

```sh
bun run dev          # web + server in parallel
bun run build        # next build
bun run start        # next start
bun run lint         # oxlint
bun run typecheck    # tsc --noEmit
bun run verify:hygiene
bun run ci           # typecheck + build + hygiene
bun --filter server test && bun --filter server typecheck
```

## Deploy with Docker

Single container (web :3000 + backend on loopback via `/api` proxy):

```sh
docker compose pull && docker compose up -d
```

Images publish to `ghcr.io/nxtgencat/veo-studio`. Persisted state lives in the `veo-data` volume (`/app/data`). Optional `.env` next to `docker-compose.yml` for `VERTEX_ACCESS_TOKEN`, `GOOGLE_CLOUD_PROJECT`, `VERTEXAI_LOCATION`, `LOG_LEVEL`. See [server/README.md](server/README.md) for the backend contract.

## Project structure

```text
app/            Next.js routes (project workspace under app/p/[projectId])
components/     studio + slate + shadcn/ui components
stores/         zustand stores (studio, ui)
lib/            typed API client (lib/api.ts), schemas, pricing, media helpers
server/         headless Bun API (see server/README.md + KNOWLEDGE.md)
scripts/        container startup
Dockerfile / docker-compose.yml   single-container production build
```

## Troubleshooting

- `API server unreachable` — start the backend (`bun run dev`), check `NEXT_PUBLIC_API_URL` / `API_PROXY_TARGET` and CORS `ALLOWED_ORIGINS`.
- `E_SA_MISSING` / `E_VERTEX_NOT_CONFIGURED` — add a service-account key in project Settings or switch the project to `env` auth with `VERTEX_ACCESS_TOKEN` set.
- `EXTEND_NEEDS_GCS` / `EXTEND_NEEDS_SOURCE` — enable a bucket in Settings; extends need a `gs://` source or archived on-disk bytes.
- Cancelled but still charged? Cancel is best-effort: `cancelled` means no output and no charge; `already_done` means the clip completed and the full per-second charge applies.

## Resources

- [server/README.md](server/README.md) — API contract, validation rules, auth, pricing
- [server/KNOWLEDGE.md](server/KNOWLEDGE.md) — researched Veo capability/pricing source of truth
- [Veo docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate) · [Extend videos](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/video/extend-videos) · [Vertex pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing)
