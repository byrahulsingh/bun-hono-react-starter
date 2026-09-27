import { Hono } from 'hono';

import type { AppEnv } from '#/types/app.types';

// The only place a URL group is named. app.ts mounts this under `/api`, so a
// group added here as `routes.route('/jobs', jobRoutes)` serves `/api/jobs`.
export const routes = new Hono<AppEnv>();
