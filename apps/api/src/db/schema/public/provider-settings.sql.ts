import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { bytea, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { createdAt, tstz } from '../column.helper';
import { profiles } from './profiles.sql';

/**
 * Settings for outside services made in the dashboard (the mail server now;
 * AI providers later), one row per service. Plain settings in `config`; the
 * secret part (a password, an API key) only encrypted, in `secret`.
 * Settings in the server's environment always win over these.
 */
export const providerSettings = pgTable('provider_settings', {
  /** Which service: `email`, … */
  key: text().primaryKey(),
  config: jsonb().$type<Record<string, unknown>>().notNull(),
  /** Encrypted (libs/crypto) JSON; never sent to the browser. */
  secret: bytea(),
  updated_by: uuid().references((): AnyPgColumn => profiles.id, { onDelete: 'set null' }),
  created_at: createdAt(),
  /** Set on every save: other processes (the worker) notice a change by it. */
  updated_at: tstz().notNull().defaultNow(),
});
