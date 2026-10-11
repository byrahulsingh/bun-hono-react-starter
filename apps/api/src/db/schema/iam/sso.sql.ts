import { sql } from 'drizzle-orm';
import { boolean, bytea, check, index, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, tstz } from '../column.helper';
import { iam } from './schema';
import { users } from './users.sql';

/**
 * Single sign-on through an OpenID Connect provider (Okta, Microsoft Entra,
 * Google Workspace…). A connection vouches only for the email domains listed
 * for it (sso_domains).
 */
export const ssoConnections = iam.table('sso_connections', {
  id: id(),
  /** Shown on the sign-in button: "Continue with Acme SSO". */
  name: text().notNull(),
  /** Its discovery document is at <issuer>/.well-known/openid-configuration. */
  issuer: text().notNull(),
  client_id: text().notNull(),
  /** Encrypted (libs/crypto); never sent back to the browser. */
  client_secret: bytea().notNull(),
  /** Password sign-in is refused for these domains (owners excepted, so a broken provider cannot lock everyone out). */
  required: boolean().notNull().default(false),
  /** The last successful test sign-in. Cleared when the provider settings change; needed before `required`. */
  tested_at: tstz(),
  created_by: uuid().references(() => users.id, { onDelete: 'set null' }),
  created_at: createdAt(),
  updated_at: tstz()
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

/** Email domains a connection vouches for. A domain belongs to one connection at most. */
export const ssoDomains = iam.table(
  'sso_domains',
  {
    domain: text().primaryKey(),
    connection_id: uuid()
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    created_at: createdAt(),
  },
  (t) => [index('sso_domains_connection_id').on(t.connection_id), check('sso_domains_lowercase', sql`${t.domain} = lower(${t.domain})`)],
);

/**
 * "Subject X at this provider is user Y". After the first sign-in, people are
 * matched by this, never by email.
 */
export const ssoIdentities = iam.table(
  'sso_identities',
  {
    id: id(),
    connection_id: uuid()
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    /** The provider's `sub`: stable and unique per provider. */
    subject: text().notNull(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The email the provider gave when the identity was linked. */
    email: text().notNull(),
    last_sign_in_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [uniqueIndex('sso_identities_subject').on(t.connection_id, t.subject), index('sso_identities_user_id').on(t.user_id)],
);

/**
 * One trip to the provider and back: short-lived, single use. `state` finds
 * it again; the nonce and PKCE verifier tie the provider's answer to it.
 */
export const ssoAttempts = iam.table(
  'sso_attempts',
  {
    id: id(),
    connection_id: uuid()
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    /** sign_in: someone signing in. test: an owner trying the connection out (no session). */
    purpose: text().notNull(),
    state_hash: bytea().notNull(),
    nonce_hash: bytea().notNull(),
    /** Encrypted: needed in the clear once, to exchange the code. */
    code_verifier: bytea().notNull(),
    /** sign_in: SHA-256 of the device key the session will be for; the code must come back from that device. */
    device_key_hash: bytea(),
    /** test: the owner who started it; only they see the result. */
    started_by: uuid().references(() => users.id, { onDelete: 'cascade' }),
    expires_at: tstz().notNull(),
    consumed_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [
    uniqueIndex('sso_attempts_state').on(t.state_hash),
    check('sso_attempts_purpose', sql`${t.purpose} in ('sign_in', 'test')`),
  ],
);
