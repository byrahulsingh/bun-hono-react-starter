import { sql } from 'drizzle-orm';
import { bigint, bytea, check, index, integer, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, tstz } from '../column.helper';
import { iam } from './schema';
import { users } from './users.sql';

/**
 * A person's authenticator app (TOTP, RFC 6238): the secret both sides share.
 * One per person. Its own table, so passkeys can sit beside it later.
 */
export const totpFactors = iam.table('totp_factors', {
  user_id: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Encrypted (libs/crypto): needed in the clear to check each code. */
  secret: bytea().notNull(),
  /** Null while being set up: the app has not yet shown a working code. */
  confirmed_at: tstz(),
  /** The 30-second step of the last accepted code: each code works once. */
  last_used_step: bigint({ mode: 'number' }),
  created_at: createdAt(),
});

/** Single-use codes for when the phone is lost. Only their keyed hash is kept. */
export const recoveryCodes = iam.table(
  'recovery_codes',
  {
    id: id(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    code_hash: bytea().notNull(),
    used_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [uniqueIndex('recovery_codes_hash').on(t.code_hash), index('recovery_codes_user_id').on(t.user_id)],
);

/**
 * The step between a correct password and a session, when a code is needed:
 * a single-use ticket, short-lived, usable only from the device that entered
 * the password, and void after a few wrong codes.
 */
export const signInChallenges = iam.table(
  'sign_in_challenges',
  {
    id: id(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token_hash: bytea().notNull(),
    /** verify: enter a code. setup: the organization requires 2FA, so set it up first. */
    step: text().notNull(),
    /** SHA-256 of the device public key the password came with. */
    device_key_hash: bytea().notNull(),
    attempts: integer().notNull().default(0),
    expires_at: tstz().notNull(),
    consumed_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [
    uniqueIndex('sign_in_challenges_hash').on(t.token_hash),
    index('sign_in_challenges_user_id').on(t.user_id),
    check('sign_in_challenges_step', sql`${t.step} in ('verify', 'setup')`),
  ],
);
