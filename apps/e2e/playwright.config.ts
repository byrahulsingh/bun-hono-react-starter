import { defineConfig } from '@playwright/test'

/**
 * Browser tests against a real stack of their own, next to the developer's:
 *
 *   :4100  API + worker, on a fresh `app_e2e` database (apps/api/scripts/e2e-server.ts)
 *   :3100  the client, through vite, proxying /api to :4100
 *   :8025  Mailpit from compose.yaml (`bun run db:up`), where test emails land
 *
 * Every run starts from an empty install. `onboarding` runs first and does
 * the setup (it also checks the brand-new install); every other spec then
 * works in that install with its own people and tenants, named per run.
 * One browser at a time: specs share the install, and a few change
 * organization-wide things (branding).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3100',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'onboarding', testMatch: /onboarding\.spec\.ts/ },
    {
      name: 'features',
      testIgnore: /onboarding\.spec\.ts/,
      dependencies: ['onboarding'],
    },
  ],
  webServer: [
    {
      command: 'bun scripts/e2e-server.ts',
      cwd: '../api',
      url: 'http://localhost:4100/api/health',
      timeout: 60_000,
      // Always fresh: a server left running from before would have old data.
      reuseExistingServer: false,
    },
    {
      command: 'bunx --bun vite dev --port 3100 --strictPort',
      cwd: '../client',
      url: 'http://localhost:3100',
      env: { API_PROXY_TARGET: 'http://localhost:4100' },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
})
