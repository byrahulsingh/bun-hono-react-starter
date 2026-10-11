import { z } from 'zod';

import { browserIdSchema, devicePublicKeySchema, emailSchema, newPasswordSchema } from '#/modules/iam';

const nameSchema = z.string().trim().min(1, 'Required').max(100);

export const setupSchema = z.object({
  token: z.string().min(1, 'Required').max(200),
  organization_name: nameSchema,
  name: nameSchema,
  email: emailSchema,
  password: newPasswordSchema,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const createInvitationSchema = z.object({
  email: emailSchema,
  role_id: z.uuid('Choose a role'),
});

/** Each address is checked on its own (a bad one is reported, not fatal). */
export const bulkInvitationSchema = z.object({
  emails: z.array(z.string().max(320)).min(1, 'Add at least one email').max(50, 'At most 50 at a time'),
  role_id: z.uuid('Choose a role'),
});

const linkToken = z.string().min(1, 'Required').max(200);

export const invitationTokenSchema = z.object({ token: linkToken });

export const acceptNewSchema = z.object({
  token: linkToken,
  name: nameSchema,
  password: newPasswordSchema,
  device_public_key: devicePublicKeySchema,
  browser_id: browserIdSchema,
});

export const acceptExistingSchema = z.object({ token: linkToken });

export const idParamSchema = z.object({ id: z.uuid('Not found') });

export const userIdParamSchema = z.object({ userId: z.uuid('Not found') });

export const createTenantSchema = z.object({ name: nameSchema });

export const changeRoleSchema = z.object({ role_id: z.uuid('Choose a role') });

export const updateProfileSchema = z.object({ name: nameSchema });

export const renameTenantSchema = z.object({ name: nameSchema });

export const tenantIdParamSchema = z.object({ id: z.uuid('Tenant not found.') });

const roleName = z.string().trim().min(1, 'Required').max(60, 'Use at most 60 characters');
const roleDescription = z.string().trim().max(300, 'Use at most 300 characters');
const permissionKeys = z.array(z.string().min(1).max(100)).max(200);

export const createRoleSchema = z.object({
  name: roleName,
  description: roleDescription.optional(),
  /** Fixed once created: who the role is for decides which permissions make sense. */
  scope: z.enum(['org', 'tenant'], 'Choose who the role is for'),
  permissions: permissionKeys,
});

export const updateRoleSchema = z.object({
  name: roleName.optional(),
  description: roleDescription.optional(),
  permissions: permissionKeys.optional(),
});

export const roleIdParamSchema = z.object({ id: z.uuid('Role not found.') });

export const auditQuerySchema = z.object({
  /** Cursor: the `next` of the previous page. */
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  category: z.enum(['security', 'people', 'roles', 'tenants', 'account', 'settings']).optional(),
  tenant: z.uuid().optional(),
  /** A person: what they did, and what was done to them. */
  actor: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const addToTenantSchema = z.object({
  tenant_id: z.uuid('Choose a tenant'),
  role_id: z.uuid('Choose a role'),
});
