import { sql } from 'drizzle-orm';
import { check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { createdAt, id, timestamps, tstz } from '../column.helper';

/** The company that installed us. Exactly one row, ever. */
export const organization = pgTable(
  'organization',
  {
    id: id(),
    name: text().notNull(),
    /** Last time a test email was handed to the mail server without error. */
    email_checked_at: tstz(),
    /** Someone hid the getting-started checklist (for every settings manager). */
    onboarding_dismissed_at: tstz(),
    /** Who must use two-factor sign-in: off · org_roles · everyone. Applies at their next sign-in. */
    two_factor_policy: text().notNull().default('off'),
    created_at: createdAt(),
    updated_at: timestamps.updated_at,
  },
  // A unique index on a constant: every row would have the same value, so a
  // second row is a duplicate and Postgres refuses it.
  (t) => [
    uniqueIndex('organization_singleton').on(sql`(true)`),
    // A plain check, not a lookup table: a foreign key added to the existing
    // row would fail before the catalog sync could insert the lookup rows.
    check('organization_two_factor_policy', sql`${t.two_factor_policy} in ('off', 'org_roles', 'everyone')`),
  ],
);
