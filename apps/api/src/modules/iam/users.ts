import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import type { User } from '#/db/schema';
import { users } from '#/db/schema';
import { AppError } from '#/libs/errors';

export type { User };

export async function findUserByEmail(tx: Tx, email: string): Promise<User | undefined> {
  const [user] = await tx
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.deleted_at)));
  return user;
}

export async function getUser(tx: Tx, id: string): Promise<User | undefined> {
  const [user] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deleted_at)));
  return user;
}

export interface AccountSummary {
  email: string;
  last_login_at: Date | null;
  /** False when deactivated: sign-in refused, no sessions. */
  active: boolean;
}

/** Login email, last sign-in and status by user id, for lists of people. Deleted accounts are left out. */
export async function accountsFor(tx: Tx, ids: string[]): Promise<Map<string, AccountSummary>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: users.id, email: users.email, last_login_at: users.last_login_at, active: sql<boolean>`${users.status} = 'active'` })
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.deleted_at)));
  return new Map(rows.map(({ id, ...account }) => [id, account]));
}

/**
 * A new login identity. `emailConfirmed`: the person proved they own the
 * address (they opened a link sent to it, or set the install up).
 */
export async function createUser(
  tx: Tx,
  input: { email: string; passwordHash: string | null; emailConfirmed: boolean },
): Promise<User> {
  if (await findUserByEmail(tx, input.email)) {
    throw new AppError('CONFLICT', 'An account with this email already exists.');
  }
  const [user] = await tx
    .insert(users)
    .values({
      email: input.email,
      password_hash: input.passwordHash,
      email_confirmed_at: input.emailConfirmed ? new Date() : null,
    })
    .returning();
  return user!;
}
