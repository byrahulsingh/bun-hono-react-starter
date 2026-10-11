/**
 * Runtime config, injected into index.html by the API server when it serves
 * the page (see apps/api/src/middleware/static.middleware.ts).
 *
 * The same build runs at `/` or under a subpath such as `/app`, so nothing
 * deployment-specific may be baked in at build time. In development vite serves
 * index.html without injection, so every value falls back to the root.
 */

import type { Branding } from '#/lib/api/settings'

interface ClientConfig {
  basePath: string
  /** The branding when the page was served (production only; see lib/branding.ts). */
  branding?: Branding
}

declare global {
  interface Window {
    __APP_CONFIG__?: ClientConfig
  }
}

/** `''` at the root, `/app` under a subpath. */
export const basePath = window.__APP_CONFIG__?.basePath ?? ''

/** Prefix for every API call: `apiUrl('/projects')` -> `/app/api/projects`. */
export function apiUrl(path: `/${string}`): string {
  return `${basePath}/api${path}`
}
