import { bytea, index, inet, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, id, tstz } from '../column.helper';
import { iam } from './schema';
import { sessions } from './sessions.sql';
import { users } from './users.sql';

/**
 * Browsers a person has signed in from. Each browser keeps a random id that
 * outlives sign-out (the device key does not: it is new at every sign-in);
 * only its keyed hash is stored. A sign-in from a browser not listed here
 * emails the person.
 */
export const knownDevices = iam.table(
  'known_devices',
  {
    id: id(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    browser_hash: bytea().notNull(),
    /** As of the last sign-in from it. */
    user_agent: text(),
    first_seen_at: createdAt(),
    last_seen_at: tstz().notNull().defaultNow(),
  },
  (t) => [uniqueIndex('known_devices_user_browser').on(t.user_id, t.browser_hash), index('known_devices_last_seen').on(t.last_seen_at)],
);

/**
 * "New sign-in to your account" emails. The link in one lets the person sign
 * that session out without signing in themselves.
 */
export const signInAlerts = iam.table(
  'sign_in_alerts',
  {
    id: id(),
    user_id: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    session_id: uuid()
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** The browser that signed in, if it sent its id: forgotten again when reported. */
    browser_hash: bytea(),
    user_agent: text(),
    ip: inet(),
    token_hash: bytea().notNull(),
    expires_at: tstz().notNull(),
    reported_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [uniqueIndex('sign_in_alerts_hash').on(t.token_hash), index('sign_in_alerts_user_id').on(t.user_id)],
);
