/**
 * Who is calling, for rate limits and audit rows: IP address, user agent and
 * request id, read once per request.
 */

import { isIP } from 'node:net';
import type { Context } from 'hono';
import { getConnInfo } from 'hono/bun';

import { env } from '#/libs/env';

export interface RequestMeta {
  /** Null when unknown; never a made-up value, since it is stored as `inet`. */
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * From the socket, or from the header the client's reverse proxy sets
 * (CLIENT_IP_SOURCE). For `x-forwarded-for` ("client, proxy1, proxy2") the
 * right-most entry is the one added by the proxy we trust; entries to its left
 * were sent by the caller and can be anything.
 */
export function clientIp(c: Context): string | null {
  let ip: string | undefined;
  if (env.CLIENT_IP_SOURCE === 'socket') {
    try {
      ip = getConnInfo(c).remote.address;
    } catch {
      ip = undefined; // no Bun server behind this request (tests calling app.fetch directly)
    }
  } else {
    ip = c.req.header(env.CLIENT_IP_SOURCE)?.split(',').at(-1)?.trim();
  }
  if (!ip) return null;
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return isIP(bare) ? bare : null;
}

export function requestMeta(c: Context): RequestMeta {
  return {
    ip: clientIp(c),
    userAgent: c.req.header('user-agent')?.slice(0, 512) ?? null,
    requestId: (c.get('requestId') as string | undefined) ?? null,
  };
}
