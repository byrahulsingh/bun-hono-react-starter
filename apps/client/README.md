# @repo/client

The browser app: React, TanStack Router (file-based routes) and shadcn/ui on Base UI. In production the API serves the build; in development Vite runs on :3000 and proxies `/api` to :4000. Setup and commands are in the [root README](../../README.md).

| Path | What it holds |
|---|---|
| `src/routes/` | Pages. `_auth/` is signed-out pages (sign-in, setup, reset); `_app/t/$tenantId/` is everything inside a tenant; `org/` is the organization pages. `routeTree.gen.ts` is generated: don't edit it. |
| `src/components/ui/` | shadcn components, added with the shadcn CLI. |
| `src/components/` | The app's own components, by area. |
| `src/lib/api/` | One file per API area: its calls and response types, written by hand (the client shares no code with the API). |
| `src/lib/auth/` | Sessions: the device key and refresh token in IndexedDB, the access token in memory. No cookies. |

A page that needs a permission spreads `pageNeeds('some.permission', 'Title')` into its route options. Buttons follow `context.permissions`; the API checks again either way.
