/**
 * The source of truth for modules, permissions and built-in roles. The migrate
 * job copies this into the database (db/catalog.ts); nothing else writes those
 * tables. A permission only means something if code checks it, which is why
 * the list lives in code and the role editor can only combine these.
 *
 * To add a permission: add it here (and to a built-in role if they should have
 * it), then check it in a route with requirePermission(). Custom roles get new
 * permissions unticked.
 */

export const ROLE_SCOPES = [
  { key: 'org', label: 'Organization', sort_order: 1 },
  { key: 'tenant', label: 'Tenant', sort_order: 2 },
] as const;

export const TENANT_STATUSES = [
  { key: 'active', label: 'Active', sort_order: 1 },
  { key: 'archived', label: 'Archived', sort_order: 2 },
] as const;

export const INVITATION_STATUSES = [
  { key: 'pending', label: 'Pending', sort_order: 1 },
  { key: 'accepted', label: 'Accepted', sort_order: 2 },
  { key: 'revoked', label: 'Revoked', sort_order: 3 },
] as const;

export const TWO_FACTOR_POLICIES = [
  { key: 'off', label: 'Nobody required', sort_order: 1 },
  { key: 'org_roles', label: 'Owners and admins', sort_order: 2 },
  { key: 'everyone', label: 'Everyone', sort_order: 3 },
] as const;

export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number]['key'];

export const MODULES = [
  { key: 'org', label: 'Organization', sort_order: 1 },
  { key: 'tenant', label: 'Tenant', sort_order: 2 },
  // The example module (modules/projects); your own modules go here too.
  { key: 'projects', label: 'Projects', sort_order: 3 },
] as const;

type ModuleKey = (typeof MODULES)[number]['key'];
type Scope = (typeof ROLE_SCOPES)[number]['key'];

interface PermissionDef {
  key: string;
  module_key: ModuleKey;
  action: string;
  scope: Scope;
  label: string;
  requires?: string;
}

export const PERMISSIONS = [
  { key: 'org.settings.manage', module_key: 'org', action: 'manage_settings', scope: 'org', label: 'Org settings' },
  { key: 'org.keys.manage', module_key: 'org', action: 'manage_keys', scope: 'org', label: 'Provider keys' },
  { key: 'org.tenants.manage', module_key: 'org', action: 'manage_tenants', scope: 'org', label: 'Create / archive tenants' },
  { key: 'org.users.manage', module_key: 'org', action: 'manage_users', scope: 'org', label: 'Org admins and users' },
  { key: 'org.roles.manage', module_key: 'org', action: 'manage_roles', scope: 'org', label: 'Create / edit roles' },
  { key: 'org.overview.view', module_key: 'org', action: 'view_overview', scope: 'org', label: 'Cross-tenant overview' },
  { key: 'org.audit.view', module_key: 'org', action: 'view_audit', scope: 'org', label: 'Audit log' },
  { key: 'org.billing.manage', module_key: 'org', action: 'manage_billing', scope: 'org', label: 'Billing and usage' },

  { key: 'tenant.users.view', module_key: 'tenant', action: 'view_users', scope: 'tenant', label: 'See tenant people' },
  { key: 'tenant.users.manage', module_key: 'tenant', action: 'manage_users', scope: 'tenant', label: 'Add / remove people', requires: 'tenant.users.view' },
  { key: 'tenant.branding.manage', module_key: 'tenant', action: 'manage_branding', scope: 'tenant', label: 'Tenant branding' },

  { key: 'projects.view', module_key: 'projects', action: 'view', scope: 'tenant', label: 'See projects' },
  { key: 'projects.create', module_key: 'projects', action: 'create', scope: 'tenant', label: 'Create projects', requires: 'projects.view' },
  { key: 'projects.edit', module_key: 'projects', action: 'edit', scope: 'tenant', label: 'Edit projects', requires: 'projects.view' },
  { key: 'projects.delete', module_key: 'projects', action: 'delete', scope: 'tenant', label: 'Delete projects', requires: 'projects.view' },
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

const keys = (scope: Scope) => PERMISSIONS.filter((p) => p.scope === scope).map((p) => p.key);
const ALL_TENANT = keys('tenant');

/** Built-in roles: created and kept in sync by the migrate job, locked in the app. */
export const BUILT_IN_ROLES: readonly {
  key: string;
  name: string;
  description: string;
  scope: Scope;
  permissions: readonly PermissionKey[];
}[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Everything, including billing. Every tenant.',
    scope: 'org',
    permissions: [...keys('org'), ...ALL_TENANT],
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Everything except billing. Every tenant.',
    scope: 'org',
    permissions: [...keys('org').filter((k) => k !== 'org.billing.manage'), ...ALL_TENANT],
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Everything in their tenant, including its people and branding.',
    scope: 'tenant',
    permissions: ALL_TENANT,
  },
  {
    key: 'editor',
    name: 'Editor',
    description: 'Works with everything in their tenant. Cannot manage people.',
    scope: 'tenant',
    permissions: ALL_TENANT.filter((k) => k !== 'tenant.users.manage' && k !== 'tenant.branding.manage'),
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Can see everything in their tenant, but not change it.',
    scope: 'tenant',
    permissions: ['projects.view'],
  },
];
