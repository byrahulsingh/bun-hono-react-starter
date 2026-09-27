/**
 * Serves the built client (`WEB_DIST`) from the API server, so production is
 * one origin: no CORS, one container, one port.
 *
 * With WEB_DIST unset (development) nothing here does anything: vite serves the
 * client, and every miss stays a JSON 404.
 *
 * Base path at serve time, not build time. The client is built once with
 * relative asset URLs (vite `base: './'`), and the same image then runs at `/`
 * or under any subpath such as `/app`. Only `index.html` needs the base path,
 * and it gets it here: its `./assets/...` URLs are rewritten to absolute ones
 * and the runtime config is injected. JS chunks and CSS resolve their own
 * imports relative to their own URL, so they need nothing.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { Context, MiddlewareHandler } from 'hono';

import { env } from '#/libs/env';

const root = env.WEB_DIST ? path.resolve(env.WEB_DIST) : undefined;
const base = env.BASE_PATH;

export const servesWeb = root !== undefined;

/**
 * What the client reads from `window.__APP_CONFIG__`. Keep it to values that
 * are safe to show anyone who opens the page: it is readable in page source.
 * Add other public per-deployment settings here (e.g. product name, logo).
 */
export interface ClientConfig {
  basePath: string;
}

/** The request path relative to the base path, or null when outside it. */
function relativePath(c: Context): string | null {
  const p = c.req.path;
  if (base === '') return p;
  if (p === base) return '/';
  return p.startsWith(base + '/') ? p.slice(base.length) : null;
}

/** A GET/HEAD for something under the base path that is not the API. */
function pagePath(c: Context): string | null {
  const method = c.req.method;
  if (method !== 'GET' && method !== 'HEAD') return null;
  const rel = relativePath(c);
  if (rel === null || rel === '/api' || rel.startsWith('/api/')) return null;
  return rel;
}

/**
 * Answers real files on disk and nothing else; a miss calls next(). Hashed
 * files under /assets never change, so browsers may cache them for a year.
 */
export const webAssets: MiddlewareHandler = async (c, next) => {
  const rel = root ? pagePath(c) : null;
  // index.html is never sent raw: it would carry no base path or config.
  if (!root || rel === null || rel === '/index.html') return next();

  let filePath: string;
  try {
    filePath = path.join(root, decodeURIComponent(rel));
  } catch {
    return next(); // malformed percent-encoding: not a file we serve
  }

  // `..` segments must not escape the build folder.
  if (!filePath.startsWith(root + path.sep)) return next();

  const isFile = await stat(filePath).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!isFile) return next();

  const immutable = rel.startsWith('/assets/');
  return new Response(Bun.file(filePath), {
    headers: {
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
};

/**
 * `./x` -> `${base}/x` in src/href attributes, plus the runtime config before
 * `</head>`. The config is JSON inside a <script>, so `<` is escaped: a value
 * containing `</script>` must not be able to close the tag.
 */
function renderIndex(html: string): string {
  const config: ClientConfig = { basePath: base };
  const json = JSON.stringify(config).replace(/</g, '\\u003c');

  return html
    .replace(/\b(src|href)="\.\//g, `$1="${base}/`)
    .replace('</head>', `<script>window.__APP_CONFIG__=${json}</script></head>`);
}

// The build does not change while the process runs, so render it once.
let indexHtml: Promise<string | null> | undefined;

function loadIndex(): Promise<string | null> {
  indexHtml ??= (async () => {
    const file = Bun.file(path.join(root!, 'index.html'));
    return (await file.exists()) ? renderIndex(await file.text()) : null;
  })();
  return indexHtml;
}

/**
 * The client's `index.html` for a browser asking for a page (a client-side
 * route such as /app/orders/123), or null so the caller can send a JSON 404.
 * `no-cache`, so a deploy is picked up on the next load.
 */
export async function webIndex(c: Context): Promise<Response | null> {
  if (!root || pagePath(c) === null) return null;
  if (!c.req.header('Accept')?.includes('text/html')) return null;

  const html = await loadIndex();
  if (html === null) return null;

  return c.html(html, 200, { 'Cache-Control': 'no-cache' });
}
