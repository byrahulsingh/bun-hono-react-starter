/**
 * The single-use token that protects the first-owner setup page. Either the
 * fixed SETUP_TOKEN from the environment, or a random one printed in the log
 * at startup (only its hash is stored).
 */

import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { oneTimeTokens } from '#/db/schema';
import { hashToken, randomToken, safeEqual } from '#/libs/crypto';
import { env } from '#/libs/env';

import { AUTH } from './iam.config';

/** A fresh setup token; any earlier unused one stops working. Returns the raw token. */
export async function issueSetupToken(tx: Tx): Promise<string> {
  const token = randomToken();
  await tx.delete(oneTimeTokens).where(and(eq(oneTimeTokens.type, 'setup'), isNull(oneTimeTokens.consumed_at)));
  await tx.insert(oneTimeTokens).values({
    type: 'setup',
    token_hash: Buffer.from(await hashToken(token)),
    expires_at: new Date(Date.now() + AUTH.setupTokenSeconds * 1000),
  });
  return token;
}

/** True, and the token is used up, if `token` is the valid setup token. */
export async function consumeSetupToken(tx: Tx, token: string): Promise<boolean> {
  const presented = await hashToken(token);
  if (env.SETUP_TOKEN) {
    // Compare hashes: equal length, constant time, whatever was typed.
    return safeEqual(presented, await hashToken(env.SETUP_TOKEN));
  }
  const consumed = await tx
    .update(oneTimeTokens)
    .set({ consumed_at: new Date() })
    .where(
      and(
        eq(oneTimeTokens.token_hash, Buffer.from(presented)),
        eq(oneTimeTokens.type, 'setup'),
        isNull(oneTimeTokens.consumed_at),
        gt(oneTimeTokens.expires_at, sql`now()`),
      ),
    )
    .returning({ id: oneTimeTokens.id });
  return consumed.length === 1;
}
