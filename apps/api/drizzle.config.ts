import { defineConfig } from 'drizzle-kit';

// Reads process.env directly, the one exception to "only libs/env.ts reads the
// environment": drizzle-kit is a dev tool that needs DATABASE_URL alone, and
// must not refuse to run because an unrelated server variable is missing.
// Bun loads .env automatically, so no dotenv import is needed.
export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema/index.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
