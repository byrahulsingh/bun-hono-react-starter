/** Lookup rows for the projects module, synced by the migrate job (db/catalog.ts). */

export const PROJECT_STATUSES = [
  { key: 'active', label: 'Active', sort_order: 1 },
  { key: 'on_hold', label: 'On hold', sort_order: 2 },
  { key: 'done', label: 'Done', sort_order: 3 },
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number]['key'];
