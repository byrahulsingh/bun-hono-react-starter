# Bun + Hono + React starter

A monorepo for a full-stack TypeScript app that ships as **one Docker image**: a Hono API on Bun that also serves a static React client from the same origin. Everything environment-specific (domain, base path, keys) is set at runtime, so the same image runs anywhere, at `/` or under a subpath.

| Path | Package | What it is |
|---|---|---|
| `apps/api` | `@repo/api` | Bun + Hono API. Serves `/api/*` and the built `apps/client`. |
| `apps/client` | `@repo/client` | Vite + React + TanStack Router + shadcn/ui + Tailwind v4. Built to static files. |
| `packages/*` | `@repo/*` | Internal packages, added when needed. |

## What's included

**API (`apps/api`)**
- `libs/env.ts` — the only module that reads `process.env`; validated with Zod, fails fast at boot.
- `libs/logger.ts` — pino with typed subsystem loggers (`logger.auth.info(...)`), pretty in dev, JSON in production, secrets redacted.
- `libs/api-response.ts` — one response envelope: `{ success, message, data?, error?: { code, details? } }`.
- `libs/errors.ts` — `ERROR_CODES` (one list, each code tied to its HTTP status) and `throw new AppError('NOT_FOUND', '…')`.
- `middleware/validate.middleware.ts` — `validate('json' | 'query' | …, zodSchema)`; failures become 422 with `{ field: message }`.
- Request IDs, structured request logs, CORS off by default, graceful shutdown, `/healthz`.
- Drizzle ORM 1.0 on Bun's built-in Postgres client: connection pool, UUIDv7 ids, snake_case columns, timestamps helper, migrator with an advisory lock.

**Client (`apps/client`)**
- `lib/api/api.ts` — the only file that calls `fetch`: base-path URLs, envelope unwrapping, one `ApiError` type with stable codes, timeouts, 401 handling with a single shared refresh, `fieldErrors()` for forms.
- `lib/api/<feature>.ts` — one file per feature describing its endpoints (see `health.ts`).
- `lib/app-config.ts` — runtime config injected by the API (base path).

**Conventions**
- `#/*` import alias in both apps (tsconfig `paths`).
- The client and the API share **no code or types**, only the HTTP contract. Types that cross it (the envelope, error codes) are kept in sync by hand.
- The brand lives in runtime config, never in code; package names use the neutral `@repo/*` scope.

## After creating a project from this template

1. Rename the root `package.json` `name`, and the `<title>` in `apps/client/index.html`.
2. `cp apps/api/.env.example apps/api/.env`.
3. Replace the sample `users` table in `apps/api/src/db/schema/` with your own, then `bun run db:generate`.
4. Add your subsystems to `SUBSYSTEMS` in `apps/api/src/libs/logger.ts` and feature error codes to `ERROR_CODES` (mirror them in `apps/client/src/lib/api/api.ts`).
5. Replace the starter page in `apps/client/src/routes/index.tsx`.

## Local development

Requires Bun and Docker.

```bash
bun install
cp apps/api/.env.example apps/api/.env   # defaults point at the local database below
bun run db:up                            # Postgres 17 in Docker, port 5432 (POSTGRES_PORT to change)
bun run db:migrate                       # apply migrations
bun run dev                              # api on :4000, client on :3000 (proxies /api to the api)
```

| Command | Does |
|---|---|
| `bun run db:up` / `db:down` | Start / stop local Postgres (data survives in a Docker volume) |
| `bun run db:generate` | Create a migration from schema changes in `apps/api/src/db/schema` |
| `bun run db:migrate` | Apply pending migrations |
| `bun run db:studio` | Browse the database |
| `bun run typecheck` | Type-check every app |
| `docker compose down -v` | Delete the local database completely |

## Production image

One image for every deployment: the API serves the built client from the same origin. Nothing environment-specific is baked in; configure it with environment variables (see `apps/api/.env.example`).

```bash
bun run docker:build     # docker build -t app:local .
bun run docker:up        # run it locally: Postgres -> migrate (one-off) -> app on :4000
bun run docker:down
```

Deploy order: run migrations once with the same image, then start or roll the app containers.

```bash
docker run --rm -w /app/apps/api -e DATABASE_URL=... -e APP_URL=... <image> bun src/db/migrate.ts
docker run -p 4000:4000 -e DATABASE_URL=... -e APP_URL=https://app.example.com <image>
```

- Health: `GET /healthz` (container probe, always at the root) and `GET <base>/api/health` (public).
- Subpath installs: set `APP_URL=https://example.com/app`; the proxy must forward the full path without stripping the prefix.
- Runs as the non-root `bun` user; stops cleanly on SIGTERM.
