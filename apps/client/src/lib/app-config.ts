/**
 * Runtime config, injected into index.html by the API server when it serves
 * the page (see apps/api/src/middleware/static.middleware.ts).
 *
 * The same build runs at `/` or under a subpath such as `/app`, so nothing
 * deployment-specific may be baked in at build time. In development vite serves
 * index.html without injection, so every value falls back to the root.
 */

interface ClientConfig {
  basePath: string
}

declare global {
  interface Window {
    __APP_CONFIG__?: ClientConfig
  }
}

/** `''` at the root, `/app` under a subpath. */
export const basePath = window.__APP_CONFIG__?.basePath ?? ''

/** Prefix for every API call: `apiUrl('/orders')` -> `/app/api/orders`. */
export function apiUrl(path: `/${string}`): string {
  return `${basePath}/api${path}`
}
