# @repo/api

The server: Bun + Hono + Drizzle on Postgres. Setup and commands are in the [root README](../../README.md).

| Path | What it holds |
|---|---|
| `src/index.ts` | The HTTP server: the API under `<base>/api`, and the built client. |
| `src/worker.ts` | Background work: sending the email outbox, cleanup. |
| `src/routes/index.ts` | The only place URL groups are named. |
| `src/db/schema/` | Every table (`iam/` for auth, `public/` for the rest). |
| `src/db/migrate.ts` | The deploy-time step: migrations, then grants, catalogs and backfills from code. |
| `src/modules/` | One folder per area; `index.ts` is what the rest of the app uses from it. |
| `src/libs/` | Small shared pieces: env, errors, logger, crypto, response envelope. |
| `test/` | API tests against a real `*_test` database (`bun run test`). |
| `scripts/` | `init.ts` (first run) and the browser tests' server and database. |
