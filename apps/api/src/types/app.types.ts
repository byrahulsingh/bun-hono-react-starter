import type { RequestIdVariables } from 'hono/request-id';

import type { Logger } from '#/libs/logger';

/** Hono generics for this app: what `c.get()` / `c.var` can hold. */
export type AppEnv = {
  Variables: RequestIdVariables & {
    /** Per-request child logger, tagged with the request id (set in app.ts). */
    log: Logger;
  };
};
