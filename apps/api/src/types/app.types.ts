import type { RequestIdVariables } from 'hono/request-id';

import type { Logger } from '#/libs/logger';
import type { AuthContext } from '#/modules/iam/iam.service';

/** Hono generics for this app: what `c.get()` / `c.var` can hold. */
export type AppEnv = {
  Variables: RequestIdVariables & {
    /** Per-request child logger, tagged with the request id (set in app.ts). */
    log: Logger;
    /** Who is calling. Set by requireAuth; only read it on routes that use it. */
    auth: AuthContext;
    /** The caller's permission keys here (org level, or the tenant in the URL). Set by requirePermission. */
    permissions: Set<string>;
  };
};
