import { createMiddleware } from 'hono/factory';

import { withIam } from '#/db/db';
import { AppError } from '#/libs/errors';
import { isOrgOwner } from '#/modules/tenancy';
import type { AppEnv } from '#/types/app.types';

/**
 * Owners only, for settings that could hand someone the owners' accounts: an
 * SSO connection vouches for anyone in its domains, and the mail server sees
 * every password reset link.
 */
export const ownersOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await withIam((tx) => isOrgOwner(tx, c.get('auth').userId)))) {
    throw new AppError('FORBIDDEN', 'Only owners can change this.');
  }
  await next();
});
