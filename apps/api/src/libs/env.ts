/**
 * Environment validation — the ONLY module in the codebase that reads
 * `process.env` (drizzle.config.ts is the one exception: it is a dev tool that
 * only needs DATABASE_URL, and must not fail on unrelated variables).
 *
 * Everything else imports `env` from here and gets validated, typed, coerced
 * values. A raw `process.env.PORT` is `string | undefined` at every call site,
 * a typo compiles fine, and a missing variable shows up as `undefined` deep
 * inside a request instead of at boot.
 *
 * Import order matters. This module has NO local imports — not even the logger —
 * because the logger is configured FROM these values. `env` -> `logger` ->
 * everything else, in one direction.
 *
 * No dotenv: Bun loads `.env` from the working directory itself. The Docker
 * image never contains a `.env` (see .dockerignore), so in production only the
 * variables the platform injects exist.
 */

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy it from .env.example'),

  /**
   * Connections in this process's pool. Every container has its own pool, so
   * the database sees (app replicas + worker replicas) × DB_POOL_MAX. Keep that
   * below Postgres `max_connections` (100 by default).
   */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  /**
   * The public address of the product, INCLUDING any subpath the host mounts it
   * under: `https://app.example.com` or `https://example.com/app`.
   *
   * The single source of truth for where we live. Every absolute link we send
   * out (emails, messages, OAuth callbacks) is built from it — never from the
   * request's Host header, which a caller can forge. BASE_PATH is derived from
   * it below and is never set separately, so the two cannot disagree. The API
   * is always `${BASE_PATH}/api` on the same host, so there is no API_URL.
   *
   * Required in production; defaults to the vite dev server in development.
   */
  APP_URL: z
    .url({ protocol: /^https?$/ })
    .optional()
    .refine((u) => u === undefined || (!u.includes('?') && !u.includes('#')), {
      message: 'APP_URL must not contain a query string or #fragment',
    }),

  /**
   * Comma-separated. Empty (the default) means no CORS headers at all, which is
   * correct for us: the client is served from this server (same origin), and in
   * development vite proxies `/api`. Only list a DIFFERENT site whose browser
   * code must call this API, e.g. a partner's portal.
   */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),

  /**
   * Absolute path to the built client (`apps/client/dist`).
   *
   * Set by the Docker image; left unset in development, where vite serves the
   * client on its own port with hot reload. Unset means no static routes are
   * mounted at all — the server is an API and a 404 stays JSON.
   */
  WEB_DIST: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

// Empty values (`LOG_LEVEL=` in .env) count as unset, so defaults and
// `.optional()` apply instead of failing validation on "".
const raw = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));

const parsed = envSchema
  .superRefine((value, ctx) => {
    // A default here would send users links to localhost.
    if (value.NODE_ENV === 'production' && value.APP_URL === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL is required in production, e.g. https://app.example.com or https://example.com/app',
      });
    }
  })
  .safeParse(raw);

if (!parsed.success) {
  // The one place `console` is used instead of the app logger, and it has to
  // be: the logger's level and format come from the values that just failed to
  // parse, so there is nothing configured to log through yet.
  console.error('\nInvalid environment:\n' + z.prettifyError(parsed.error) + '\n');
  process.exit(1);
}

const appUrl = new URL(parsed.data.APP_URL ?? 'http://localhost:3000');

export const env = {
  ...parsed.data,
  /** APP_URL without a trailing slash: `https://example.com/app`. */
  APP_URL: appUrl.origin + appUrl.pathname.replace(/\/+$/, ''),
  /** `https://example.com` — what a browser sends as its Origin header. */
  APP_ORIGIN: appUrl.origin,
  /**
   * The subpath from APP_URL: `/app`, or `''` when served at the root. Every
   * public route — client pages, assets, `/api` — lives under it.
   */
  BASE_PATH: appUrl.pathname.replace(/\/+$/, ''),
};

export const isDev = env.NODE_ENV === 'development';
export const isProd = env.NODE_ENV === 'production';
