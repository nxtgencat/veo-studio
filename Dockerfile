# syntax=docker/dockerfile:1.12
# Single container: Next.js web (:3000) + Bun API (loopback :8787, via /api proxy).

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION}-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY server/package.json ./server/package.json
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
# Stage the runtime files for external pino (worker-based, must not be bundled)
# into one dir so the runner needs a single COPY (multi-source COPY would merge
# contents instead of keeping package dirs). Re-check list after dep changes.
RUN mkdir -p /staging/node_modules/@pinojs && \
    for p in pino thread-stream sonic-boom on-exit-leak-free pino-std-serializers quick-format-unescaped safe-stable-stringify real-require atomic-sleep split2 process-warning pino-abstract-transport; do \
      cp -r /app/node_modules/$p /staging/node_modules/; \
    done && \
    cp -r /app/node_modules/@pinojs/redact /staging/node_modules/@pinojs/

FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# pino stays external (its thread-stream worker crashes when bundled).
# --env disable keeps PORT/SQLITE_FILE/etc. readable at runtime.
RUN --mount=type=cache,id=bun-install,target=/root/.bun/install/cache \
    --mount=type=cache,id=next-cache,target=/app/.next/cache \
    bun --bun run build && \
    bun build ./server/src/index.ts --target=bun --minify \
      --env disable \
      --external pino --external thread-stream \
      --outfile=./backend-dist/api.js

FROM oven/bun:${BUN_VERSION}-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    API_PORT=8787 \
    SQLITE_FILE=/app/data/veo.sqlite \
    MEDIA_DIR=/app/data/media

COPY --from=builder /app/public ./public
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static
COPY --from=builder --chown=bun:bun /app/backend-dist/api.js ./backend/api.js
COPY --from=builder --chown=bun:bun /app/scripts/container-start.ts ./scripts/container-start.ts
# Runtime files for external pino (see deps stage).
COPY --from=deps --chown=bun:bun /staging/node_modules/ ./node_modules/

RUN mkdir -p /app/data && chown bun:bun /app/data
VOLUME /app/data

USER bun
EXPOSE 3000/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "scripts/container-start.ts"]
