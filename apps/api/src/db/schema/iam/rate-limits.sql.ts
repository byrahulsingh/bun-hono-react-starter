import { integer, text } from 'drizzle-orm/pg-core';

import { tstz } from '../column.helper';
import { iam } from './schema';

/** Fixed-window counters, e.g. `login:ip:203.0.113.7`. Old windows are deleted as they are reused. */
export const rateLimits = iam.table('rate_limits', {
  key: text().primaryKey(),
  count: integer().notNull(),
  window_start: tstz().notNull(),
});
