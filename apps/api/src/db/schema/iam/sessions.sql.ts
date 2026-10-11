import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { bigint, bytea, check, index, inet, jsonb, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, tstz } from '../column.helper';
import { iam } from './schema';
import { ssoConnections } from './sso.sql';
import { users } from './users.sql';

/** A public key as a JWK (P-256), registered by the browser at sign-in. */
export interface DevicePublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/**
 * One row per signed-in device. Refresh tokens are not stored: a token is
 * session id + counter + an HMAC under `refresh_hmac_key`, so checking one
 * means loading this row (see modules/iam/tokens.ts).
 */
export const sessions = iam.table(
  'sessions',
  {
    id: id(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Refresh needs a proof signed by the matching private key, which never leaves the browser. */
    device_public_key: jsonb().$type<DevicePublicKey>().notNull(),
    /** 32 random bytes, encrypted with libs/crypto. */
    refresh_hmac_key: bytea().notNull(),
    /** The counter inside the one refresh token that is currently valid. */
    refresh_counter: bigint({ mode: 'number' }).notNull().default(0),
    /** Last rotation; the idle limit is measured from here. */
    refreshed_at: tstz().notNull().defaultNow(),
    /** Absolute end of the session, whatever happens. */
    not_after: tstz().notNull(),
    auth_method: text().notNull().default('password'),
    /** The SSO connection that created the session; removing the connection ends it. */
    sso_connection_id: uuid().references((): AnyPgColumn => ssoConnections.id, { onDelete: 'set null' }),
    ip: inet(),
    user_agent: text(),
    revoked_at: tstz(),
    revoked_reason: text(),
    created_at: createdAt(),
  },
  (t) => [
    index('sessions_user_id').on(t.user_id),
    index('sessions_not_after').on(t.not_after),
    check('sessions_auth_method', sql`auth_method in ('password', 'sso')`),
  ],
);

export type Session = typeof sessions.$inferSelect;
