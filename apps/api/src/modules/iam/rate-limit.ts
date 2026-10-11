/**
 * Fixed-window counters in `iam.rate_limits`, shared by every API replica.
 *
 * Each call runs in its own short transaction, on purpose: a counter must
 * survive even when the request it belongs to fails and rolls back — a failed
 * sign-in is exactly what has to be counted.
 */

import { sql } from 'drizzle-orm';

import { withIam } from '#/db/db';
import { AppError } from '#/libs/errors';

type Limit = readonly [max: number, windowSeconds: number];

interface Counter {
  count: number;
  retryAfter: number;
}

async function bump(key: string, [, windowSeconds]: Limit): Promise<Counter> {
  const rows = await withIam((tx) =>
    tx.execute<{ count: number; retry_after: number }>(sql`
      insert into iam.rate_limits as r (key, count, window_start) values (${key}, 1, now())
      on conflict (key) do update set
        count = case when r.window_start <= now() - make_interval(secs => ${windowSeconds}) then 1 else r.count + 1 end,
        window_start = case when r.window_start <= now() - make_interval(secs => ${windowSeconds}) then now() else r.window_start end
      returning count, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}) - now())))::int as retry_after`),
  );
  // Old windows are rewritten when their key comes back; keys that never come
  // back are swept now and then instead of by a scheduled job.
  if (Math.random() < 0.01) {
    void withIam((tx) => tx.execute(sql`delete from iam.rate_limits where window_start < now() - interval '1 day'`));
  }
  const row = rows[0]!;
  return { count: Number(row.count), retryAfter: Math.max(1, Number(row.retry_after)) };
}

/** Counts one attempt; throws RATE_LIMITED once the window's maximum is passed. */
export async function rateLimit(key: string, limit: Limit): Promise<void> {
  const { count, retryAfter } = await bump(key, limit);
  if (count > limit[0]) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Wait a moment and try again.', { retry_after: retryAfter });
  }
}

/** Counts one attempt and says whether it was within the limit, without throwing. */
export async function withinLimit(key: string, limit: Limit): Promise<boolean> {
  const { count } = await bump(key, limit);
  return count <= limit[0];
}

/** Attempts so far in the current window, without counting one. */
export async function attempts(key: string, [, windowSeconds]: Limit): Promise<Counter> {
  const rows = await withIam((tx) =>
    tx.execute<{ count: number; retry_after: number }>(sql`
      select count, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}) - now())))::int as retry_after
      from iam.rate_limits
      where key = ${key} and window_start > now() - make_interval(secs => ${windowSeconds})`),
  );
  const row = rows[0];
  return row ? { count: Number(row.count), retryAfter: Math.max(1, Number(row.retry_after)) } : { count: 0, retryAfter: 0 };
}

export async function resetLimit(key: string): Promise<void> {
  await withIam((tx) => tx.execute(sql`delete from iam.rate_limits where key = ${key}`));
}
