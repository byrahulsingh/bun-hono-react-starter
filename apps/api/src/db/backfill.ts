/**
 * Data the migrate job fills in after migrations, for installs that existed
 * before a column did. Code, not hand-written SQL migrations: each step looks
 * at the data, does nothing when there is nothing to do, and is safe to run
 * on every deploy.
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { Tx } from '#/db/db';
import { auditLogs, tenants } from '#/db/schema';

/**
 * `tenants.is_main` arrived after some installs were set up: mark the tenant
 * their setup created (recorded in the audit log), or else the oldest one.
 */
async function ensureMainTenant(tx: Tx): Promise<string | null> {
  const [main] = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.is_main, true), isNull(tenants.deleted_at)));
  if (main) return null;

  const [setup] = await tx
    .select({ tenantId: sql<string | null>`${auditLogs.changes}->>'default_tenant_id'` })
    .from(auditLogs)
    .where(eq(auditLogs.action, 'setup.completed'))
    .orderBy(asc(auditLogs.created_at))
    .limit(1);
  const live = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(isNull(tenants.deleted_at))
    .orderBy(asc(tenants.created_at));
  const pick = live.find((t) => t.id === setup?.tenantId) ?? live.at(0);
  if (!pick) return null; // not set up yet: setup will create it
  await tx.update(tenants).set({ is_main: true }).where(eq(tenants.id, pick.id));
  return pick.id;
}

export async function runBackfills(tx: Tx): Promise<Record<string, unknown>> {
  return { mainTenant: await ensureMainTenant(tx) };
}
