import { sql } from 'drizzle-orm';
import { bytea, jsonb, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { JWK } from 'jose';

import { createdAt, tstz } from '../column.helper';
import { iam } from './schema';

/**
 * Keys that sign access tokens (ES256). Exactly one is current (not retired);
 * retired keys keep verifying until every token they signed has expired.
 */
export const signingKeys = iam.table(
  'signing_keys',
  {
    /** Goes into each token's header, so verification knows which key to use. */
    kid: text().primaryKey(),
    alg: text().notNull().default('ES256'),
    public_jwk: jsonb().$type<JWK>().notNull(),
    /** The private JWK, encrypted with libs/crypto. */
    private_key: bytea().notNull(),
    activated_at: tstz().notNull().defaultNow(),
    retired_at: tstz(),
    created_at: createdAt(),
  },
  (t) => [uniqueIndex('signing_keys_one_current').on(sql`(true)`).where(sql`retired_at is null`)],
);
