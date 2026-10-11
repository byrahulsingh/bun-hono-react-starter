/**
 * The role editor's tick rules, mirroring the API (roles.service.ts), which
 * applies them again on save:
 *   - ticking a permission also ticks what it requires (projects.edit → projects.view);
 *   - unticking one also unticks everything that requires it.
 */

import type { CatalogPermission, RoleScope } from '#/lib/api/roles'

export function permissionsForScope(
  all: CatalogPermission[],
  scope: RoleScope,
): CatalogPermission[] {
  // Org roles apply in every tenant, so they may carry tenant permissions too.
  return scope === 'org' ? all : all.filter((p) => p.scope === 'tenant')
}

export function tick(
  selected: ReadonlySet<string>,
  key: string,
  all: CatalogPermission[],
): Set<string> {
  const next = new Set(selected)
  const byKey = new Map(all.map((p) => [p.key, p]))
  for (
    let k: string | null = key;
    k && !next.has(k);
    k = byKey.get(k)?.requires ?? null
  )
    next.add(k)
  return next
}

export function untick(
  selected: ReadonlySet<string>,
  key: string,
  all: CatalogPermission[],
): Set<string> {
  const next = new Set(selected)
  const drop = (k: string) => {
    if (!next.delete(k)) return
    for (const p of all) if (p.requires === k) drop(p.key)
  }
  drop(key)
  return next
}
