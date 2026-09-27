import { pgTable, varchar } from 'drizzle-orm/pg-core';

import { id, timestamps } from './column.helper';

// Sample table: replace it with your own schema, then run `bun run db:generate`.
export const usersTable = pgTable('users', {
  id: id(),
  name: varchar({ length: 255 }).notNull(),
  email: varchar({ length: 255 }).notNull().unique(),
  ...timestamps,
});
