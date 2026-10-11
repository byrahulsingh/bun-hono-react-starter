import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackRouter } from '@tanstack/router-plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const config = defineConfig({
  // Relative asset URLs, so one build runs at `/` or under any subpath. The API
  // server rewrites index.html's URLs to the real base path when it serves it.
  // Import images through vite (`import logo from './logo.svg'`); never
  // hard-code `/logo.svg`, which would ignore the base path.
  base: './',
  resolve: { tsconfigPaths: true },
  plugins: [
    // Console piping keeps one connection open per tab. Browsers allow six
    // per host, so with a handful of tabs open the next page's modules queue
    // behind them and it hangs on "Loading…".
    devtools({ consolePiping: { enabled: false } }),
    tailwindcss(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
  ],
  server: {
    // Same origin in development as in production (where apps/api serves the
    // built client): the browser calls `/api/...` and vite forwards it, so no
    // CORS and no API URL baked into the bundle.
    proxy: {
      '/api': process.env.API_PROXY_TARGET ?? 'http://localhost:4000',
    },
  },
})

export default config
