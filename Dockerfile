# syntax=docker/dockerfile:1

# Production image: the API, serving the built client from the same origin.
#
#   docker build -t app .
#   docker run -p 4000:4000 -e DATABASE_URL=... -e APP_URL=https://app.example.com app
#
# Migrations use the same image with a different command, run once before new
# app containers start:
#
#   docker run --rm -w /app/apps/api -e DATABASE_URL=... -e APP_URL=... app bun src/db/migrate.ts
#
# One image for every deployment: nothing environment-specific (domain, base
# path, keys) is baked in. All of it comes from environment variables at start.

ARG BUN_VERSION=1.4.2

# ─── All dependencies, to build the client ───────────────────────
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
# Manifests first: this layer (the slow install) is reused until a
# package.json or the lockfile changes, not on every source edit.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/client/package.json apps/client/
RUN bun install --frozen-lockfile

# ─── Client build → static files ─────────────────────────────────
FROM deps AS client
COPY tsconfig.base.json ./
COPY apps/client apps/client
RUN bun run --filter @repo/client build

# ─── API production dependencies only ────────────────────────────
FROM oven/bun:${BUN_VERSION} AS api-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
# Every workspace manifest must be present for --frozen-lockfile to match the
# lockfile; --filter then installs only what the API needs, without dev tools.
COPY apps/client/package.json apps/client/
RUN bun install --frozen-lockfile --production --filter @repo/api

# ─── Runtime ─────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    WEB_DIST=/app/apps/client/dist

# Bun runs the TypeScript source directly; there is no API build step.
# tsconfig.base.json is needed at runtime: the `#/*` import alias lives in
# apps/api/tsconfig.json, which extends it.
COPY --from=api-deps /app/node_modules node_modules
COPY --from=api-deps /app/apps/api/node_modules apps/api/node_modules
COPY package.json tsconfig.base.json ./
COPY apps/api apps/api
COPY --from=client /app/apps/client/dist apps/client/dist

# Never run as root. The `bun` user ships with the base image.
USER bun
WORKDIR /app/apps/api
EXPOSE 4000

# For Docker and Compose. Kubernetes ignores this and uses its own probes,
# which should also target /healthz.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://localhost:' + (process.env.PORT ?? 4000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "src/index.ts"]
