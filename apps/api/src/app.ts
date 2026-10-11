import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';

import { apiResponse } from '#/libs/api-response';
import { env } from '#/libs/env';
import { AppError, codeForStatus, defaultMessage } from '#/libs/errors';
import { logger, rootLogger } from '#/libs/logger';
import { webAssets, webIndex } from '#/middleware/static.middleware';
import { routes } from '#/routes';
import type { AppEnv } from '#/types/app.types';

const log = logger.http;

// `strict: false` — `/api/projects` and `/api/projects/` both resolve. Hono's default
// 404s the trailing slash for every method, so a POST with a stray slash fails
// in a way that looks like a missing route rather than a typo.
// `trimTrailingSlash()` is not an alternative: it only redirects GET and HEAD.
const app = new Hono<AppEnv>({ strict: false });

// First, before anything that logs. Reuses an inbound `X-Request-Id` when the
// caller sent a valid one and generates one otherwise, so a trace started at
// the load balancer survives into these logs. It also echoes the id back in the
// response header, which is what a support ticket quotes.
app.use('*', requestId());

// Browser hardening on every response: no MIME sniffing, no framing (stops
// clickjacking), no Referer — links carrying single-use tokens must not leak
// the token to another site through it. The page's Content-Security-Policy is
// added where index.html is served (static.middleware.ts).
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
    // Nothing uses them; a feature that needs the camera allows camera: ['self'].
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    // Set below instead, so a route can choose otherwise.
    crossOriginResourcePolicy: false,
  }),
);

// Other sites may not embed our responses, unless a route says so (branding
// images, which emails show).
app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cross-Origin-Resource-Policy')) c.header('Cross-Origin-Resource-Policy', 'same-origin');
});

// Request logging through pino rather than hono/logger, so HTTP lines carry the
// same structure and level as everything else.
app.use('*', async (c, next) => {
  const start = performance.now();
  const id = c.get('requestId');

  // Derived from the root logger, not from `log` above: this one belongs to the
  // request, not to the http subsystem, and handlers name themselves.
  c.set('log', rootLogger.child({ requestId: id }));

  await next();

  // Hashed asset hits are the bulk of traffic once the client is served from
  // here, and health probes arrive every few seconds; none of them are worth
  // reading. Demoting the successful ones keeps production logs to API calls,
  // plus every asset or probe that fails.
  const noise =
    c.res.status < 400 &&
    (c.req.path.startsWith(`${env.BASE_PATH}/assets/`) || c.req.path === '/healthz');

  log[noise ? 'debug' : 'info'](
    {
      requestId: id,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
    },
    'request',
  );
});

// Container liveness probe. Always at the root, outside BASE_PATH: probes hit
// the container directly and should not need to know where the host mounted
// the product. The host's reverse proxy only forwards BASE_PATH, so this is not
// reachable from outside. It does not touch the database: a database outage
// must not make the orchestrator restart every healthy app container.
app.get('/healthz', (c) => c.json(apiResponse({ success: true, message: 'ok' })));

// Everything public lives under BASE_PATH (`''` or e.g. `/app`). The host's
// reverse proxy must forward the full path without stripping the prefix.
const site = env.BASE_PATH ? app.basePath(env.BASE_PATH) : app;

// Before CORS and before the routes: a real file on disk is answered and
// nothing else runs. A miss calls next(), so the API is untouched by this.
site.use('*', webAssets);

// Only when another site's browser code must call this API. The client itself
// is same-origin, and browsers make no CORS checks for same-origin requests.
if (env.CORS_ORIGINS.length > 0) {
  site.use(
    '/api/*',
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 3600,
    }),
  );
}

const api = site.basePath('/api');

// API answers carry tokens and personal data: no browser or proxy may keep a
// copy. A route serving something public and fixed (a logo) sets its own.
api.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// Every group hangs off `src/routes/index.ts`, which is the only place a URL is
// named. `${BASE_PATH}/api` is prefixed once, here.
api.route('/', routes);

// Public health check, through the host's proxy — for uptime monitors.
api.get('/health', (c) =>
  c.json(
    apiResponse({
      success: true,
      message: 'ok',
      data: { env: env.NODE_ENV, uptime: Math.round(process.uptime()) },
    }),
  ),
);

app.notFound(async (c) => {
  // A browser asking for a page it cannot find gets the client's shell and lets
  // the client router decide. Everything else — curl, any /api path — gets the
  // envelope it expects.
  const shell = await webIndex(c);
  if (shell) return shell;

  return c.json(
    apiResponse({ success: false, message: 'Route not found', error: { code: 'NOT_FOUND' } }),
    404,
  );
});

app.onError((err, c) => {
  const reqLog = c.get('log') ?? log;

  // Our own errors: the code, status and message were chosen on purpose, so
  // they go out as they are. A 5xx AppError (e.g. UNAVAILABLE) is still an
  // outage worth a log line; a 4xx is the client's mistake and the request
  // log already records its status.
  if (err instanceof AppError) {
    if (err.status >= 500) reqLog.error({ err, path: c.req.path }, err.message);
    return c.json(
      apiResponse({
        success: false,
        message: err.message,
        error: { code: err.code, ...(err.details !== undefined && { details: err.details }) },
      }),
      err.status,
    );
  }

  // Hono's own errors (malformed JSON, body too large, …) get a code from
  // their status, so the client never sees an error without one.
  if (err instanceof HTTPException) {
    const code = codeForStatus(err.status);
    return c.json(
      apiResponse({ success: false, message: err.message || defaultMessage(code), error: { code } }),
      err.status,
    );
  }

  // Anything else is a bug. Log the real error, return a generic one: stack
  // traces and driver messages leak schema details to anyone who can trigger a
  // 500. Falls back to the module logger: onError also catches anything thrown
  // by middleware registered above the one that sets `log`.
  reqLog.error({ err, path: c.req.path }, 'Unhandled error');

  return c.json(
    apiResponse({
      success: false,
      message: 'Internal server error',
      // Also in the X-Request-Id header, but someone reading an error screen
      // can't see headers. In the body it is something they can quote.
      error: { code: 'INTERNAL', details: { requestId: c.get('requestId') } },
    }),
    500,
  );
});

export { api };
export default app;
