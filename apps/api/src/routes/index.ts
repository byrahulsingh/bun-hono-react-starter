import { Hono } from 'hono';

import { brandingRoutes } from '#/modules/branding';
import { authRoutes } from '#/modules/iam';
import { projectRoutes } from '#/modules/projects';
import { settingsRoutes } from '#/modules/settings';
import {
  auditRoutes,
  invitationRoutes,
  meRoutes,
  orgRoutes,
  rolesRoutes,
  setupRoutes,
  tenantRoutes,
  tenantsRoutes,
} from '#/modules/tenancy';
import type { AppEnv } from '#/types/app.types';

// The only place a URL group is named. app.ts mounts this under `/api`, so a
// group added here as `routes.route('/things', thingRoutes)` serves `/api/things`.
export const routes = new Hono<AppEnv>()
  .route('/auth', authRoutes)
  .route('/setup', setupRoutes)
  .route('/me', meRoutes)
  .route('/invitations', invitationRoutes)
  .route('/tenants', tenantsRoutes)
  .route('/org', orgRoutes)
  .route('/roles', rolesRoutes)
  .route('/audit', auditRoutes)
  .route('/settings', settingsRoutes)
  // Public: the sign-in page and emails need it before anyone signs in.
  .route('/branding', brandingRoutes)
  // Everything inside one tenant: the tenant id is in the URL, never in the token.
  .route('/t/:tenantId', tenantRoutes)
  // The example module; a feature inside a tenant is mounted the same way.
  .route('/t/:tenantId/projects', projectRoutes);
