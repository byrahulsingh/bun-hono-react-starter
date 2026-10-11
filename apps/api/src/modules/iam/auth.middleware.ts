import { createMiddleware } from 'hono/factory';

import { AppError } from '#/libs/errors';
import type { AppEnv } from '#/types/app.types';

import { isSessionAlive } from './sessions';
import { verifyAccessToken } from './tokens';

/**
 * Every protected route. Two checks:
 *   1. the access token is ours and unexpired (offline, no database)
 *   2. its session is still alive and its user active (cached ~15 s)
 *
 * The two failures differ on purpose. UNAUTHORIZED: the access token expired,
 * the client should refresh and retry. SESSION_EXPIRED: the session itself is
 * over, the client should sign out.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw new AppError('UNAUTHORIZED', 'Please sign in to continue.');

  const claims = await verifyAccessToken(token);
  if (!claims) throw new AppError('UNAUTHORIZED', 'Your sign-in has expired.');

  if (!(await isSessionAlive(claims.sid, claims.sub))) {
    throw new AppError('SESSION_EXPIRED', 'Your session has ended. Please sign in again.');
  }

  c.set('auth', { userId: claims.sub, sessionId: claims.sid });
  await next();
});
