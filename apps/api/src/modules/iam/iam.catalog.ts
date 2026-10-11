/** Lookup rows for schema `iam`, synced by the migrate job (db/catalog.ts). */

export const USER_STATUSES = [
  { key: 'active', label: 'Active', sort_order: 1 },
  { key: 'disabled', label: 'Disabled', sort_order: 2 },
] as const;

export const TOKEN_TYPES = [
  { key: 'setup', label: 'First-owner setup', sort_order: 1 },
  { key: 'recovery', label: 'Password reset', sort_order: 2 },
] as const;
