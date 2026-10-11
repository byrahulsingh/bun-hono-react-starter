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
import type { Branding } from '#/modules/branding';
import { getBranding } from '#/modules/branding';

const root = env.WEB_DIST ? path.resolve(env.WEB_DIST) : undefined;
const base = env.BASE_PATH;

export const servesWeb = root !== undefined;

/**
 * What the client reads from `window.__APP_CONFIG__`. Keep it to values that
 * are safe to show anyone who opens the page: it is readable in page source.
 * Branding is here so the first paint already has the right name and colour
 * (the same as GET /api/branding, which development uses instead).
 */
export interface ClientConfig {
  basePath: string;
  branding: Omit<Branding, 'customized'>;
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

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * `./x` -> `${base}/x` in src/href attributes, plus the runtime config before
 * `</head>`. The config is JSON inside a <script>, so `<` is escaped: a value
 * containing `</script>` must not be able to close the tag.
 */
function renderIndex(html: string, brand: Branding): { html: string; csp: string } {
  const { customized: _, ...branding } = brand;
  const config: ClientConfig = { basePath: base, branding };
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const inline = `window.__APP_CONFIG__=${json}`;

  return {
    html: html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(brand.product_name)}</title>`)
      .replace(/\b(src|href)="\.\//g, `$1="${base}/`)
      .replace('</head>', `<script>${inline}</script></head>`),
    csp: contentSecurityPolicy(inline),
  };
}

/**
 * The page may only run our own scripts: the bundle from this origin, plus the
 * one inline config script, allowed by its exact hash. An injected <script>
 * (the usual XSS) does not run, so it cannot use the session's device key.
 * Styles allow inline attributes, which the UI components set.
 */
function contentSecurityPolicy(inlineScript: string): string {
  const hash = new Bun.CryptoHasher('sha256').update(inlineScript).digest('base64');
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${hash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

// The build does not change while the process runs, so read it once; render
// it again only when the branding changes (its version is in the config).
let indexFile: Promise<string | null> | undefined;
let rendered: { version: string; page: { html: string; csp: string } | null } | undefined;

async function loadIndex(): Promise<{ html: string; csp: string } | null> {
  indexFile ??= (async () => {
    const file = Bun.file(path.join(root!, 'index.html'));
    return (await file.exists()) ? file.text() : null;
  })();
  const [html, brand] = await Promise.all([indexFile, getBranding()]);
  if (rendered?.version !== brand.version) {
    rendered = { version: brand.version, page: html === null ? null : renderIndex(html, brand) };
  }
  return rendered.page;
}

/**
 * The client's `index.html` for a browser asking for a page (a client-side
 * route such as /app/projects/123), or null so the caller can send a JSON 404.
 * `no-cache`, so a deploy is picked up on the next load.
 */
export async function webIndex(c: Context): Promise<Response | null> {
  if (!root || pagePath(c) === null) return null;
  if (!c.req.header('Accept')?.includes('text/html')) return null;

  const page = await loadIndex();
  if (page === null) return null;

  return c.html(page.html, 200, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': page.csp });
}
