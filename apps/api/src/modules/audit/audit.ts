import type { Tx } from '#/db/db';
import { auditLogs } from '#/db/schema';
import type { RequestMeta } from '#/libs/request-meta';

export interface AuditEntry {
  action: string;
  actorUserId?: string | null;
  tenantId?: string | null;
  targetType?: string;
  targetId?: string;
  changes?: Record<string, unknown>;
}

/**
 * Adds an audit row inside the caller's transaction: the change and its record
 * commit together or not at all. Never put secrets in `changes`.
 */
export async function recordAudit(tx: Tx, entry: AuditEntry, meta?: RequestMeta): Promise<void> {
  await tx.insert(auditLogs).values({
    action: entry.action,
    actor_user_id: entry.actorUserId ?? null,
    tenant_id: entry.tenantId ?? null,
    target_type: entry.targetType,
    target_id: entry.targetId,
    changes: entry.changes,
    request_id: meta?.requestId,
    ip: meta?.ip,
    user_agent: meta?.userAgent,
  });
}
