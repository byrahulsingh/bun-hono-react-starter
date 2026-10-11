import type { Context } from 'hono';
import { Hono } from 'hono';

import { apiResponse } from '#/libs/api-response';
import { AppError } from '#/libs/errors';
import { requestMeta } from '#/libs/request-meta';
import { validate } from '#/middleware/validate.middleware';
import { requireAuth } from '#/modules/iam';
import type { AppEnv } from '#/types/app.types';

import {
  acceptAsNewAccount,
  acceptAsSignedIn,
  createInvitation,
  createInvitations,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from './invitations.service';
import { changeMemberRole, listMembers, removeMember, tenantRoles } from './members.service';
import { addToTenant, listOrgPeople, resetPersonTwoFactor, sendResetLink, setPersonActive } from './org-people.service';
import { changeOrgRole, listOrgMembers, orgRoles, removeOrgRole } from './org.service';
import { auditFilterOptions, listAudit } from './audit-log.service';
import { createRole, deleteRole, listRoles, updateRole } from './roles.service';
import { requirePermission, requireTenantAccess } from './permissions';
import { completeSetup, getMe, setupStatus, updateProfile } from './tenancy.service';
import {
  acceptExistingSchema,
  acceptNewSchema,
  addToTenantSchema,
  auditQuerySchema,
  bulkInvitationSchema,
  changeRoleSchema,
  createInvitationSchema,
  createRoleSchema,
  createTenantSchema,
  idParamSchema,
  invitationTokenSchema,
  renameTenantSchema,
  roleIdParamSchema,
  setupSchema,
  tenantIdParamSchema,
  updateProfileSchema,
  updateRoleSchema,
  userIdParamSchema,
} from './tenancy.validators';
import { createTenant, listTenants, renameTenant, setTenantArchived } from './tenants.service';

/** Mounted at /api/setup. Public until setup is done; gone afterwards. */
export const setupRoutes = new Hono<AppEnv>()
  .get('/status', async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await setupStatus() })))
  .post('/', validate('json', setupSchema), async (c) => {
    const data = await completeSetup(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Setup complete', data }), 201);
  });

/** Mounted at /api/me. */
export const meRoutes = new Hono<AppEnv>()
  .get('/', requireAuth, async (c) => c.json(apiResponse({ success: true, message: 'ok', data: await getMe(c.get('auth')) })))
  .patch('/', requireAuth, validate('json', updateProfileSchema), async (c) => {
    await updateProfile(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Profile updated' }));
  });

/**
 * Invitations. The same routes serve org invites (mounted at /api/invitations)
 * and tenant invites (mounted at /api/t/:tenantId/invitations): the tenant id
 * in the URL, or its absence, decides which.
 */
const manageInvitations = (permission: 'org.users.manage' | 'tenant.users.manage') =>
  new Hono<AppEnv>()
    .get('/', requireAuth, requirePermission(permission), async (c) => {
      const data = await listInvitations(c.req.param('tenantId') ?? null);
      return c.json(apiResponse({ success: true, message: 'ok', data }));
    })
    .post('/', requireAuth, requirePermission(permission), validate('json', createInvitationSchema), async (c) => {
      const data = await createInvitation(
        c.get('auth'),
        c.req.param('tenantId') ?? null,
        c.get('permissions'),
        c.req.valid('json'),
        requestMeta(c),
      );
      return c.json(apiResponse({ success: true, message: 'Invitation sent', data }), 201);
    })
    .post('/bulk', requireAuth, requirePermission(permission), validate('json', bulkInvitationSchema), async (c) => {
      const results = await createInvitations(
        c.get('auth'),
        c.req.param('tenantId') ?? null,
        c.get('permissions'),
        c.req.valid('json'),
        requestMeta(c),
      );
      return c.json(apiResponse({ success: true, message: 'ok', data: { results } }));
    })
    .delete('/:id', requireAuth, requirePermission(permission), validate('param', idParamSchema), async (c) => {
      await revokeInvitation(c.get('auth'), c.req.param('tenantId') ?? null, c.req.valid('param').id, requestMeta(c));
      return c.json(apiResponse({ success: true, message: 'Invitation revoked' }));
    });

/** Mounted at /api/invitations: org invites, plus the public accept flow. */
export const invitationRoutes = new Hono<AppEnv>()
  // The token travels in the body, never the URL, so it stays out of logs.
  .post('/preview', validate('json', invitationTokenSchema), async (c) => {
    const data = await previewInvitation(c.req.valid('json').token, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .post('/accept', validate('json', acceptNewSchema), async (c) => {
    const data = await acceptAsNewAccount(c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Welcome aboard', data }), 201);
  })
  .post('/accept-signed-in', requireAuth, validate('json', acceptExistingSchema), async (c) => {
    await acceptAsSignedIn(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Invitation accepted' }));
  })
  .route('/', manageInvitations('org.users.manage'));

/** Mounted at /api/tenants: org-level tenant management. */
const manageTenants = requirePermission('org.tenants.manage');
export const tenantsRoutes = new Hono<AppEnv>()
  .get('/', requireAuth, manageTenants, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listTenants() }));
  })
  .post('/', requireAuth, manageTenants, validate('json', createTenantSchema), async (c) => {
    const data = await createTenant(c.get('auth'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Tenant created', data }), 201);
  })
  .patch('/:id', requireAuth, manageTenants, validate('param', tenantIdParamSchema), validate('json', renameTenantSchema), async (c) => {
    await renameTenant(c.get('auth'), c.req.valid('param').id, c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Tenant renamed' }));
  })
  .post('/:id/archive', requireAuth, manageTenants, validate('param', tenantIdParamSchema), async (c) => {
    await setTenantArchived(c.get('auth'), c.req.valid('param').id, true, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Tenant archived' }));
  })
  .post('/:id/restore', requireAuth, manageTenants, validate('param', tenantIdParamSchema), async (c) => {
    await setTenantArchived(c.get('auth'), c.req.valid('param').id, false, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Tenant restored' }));
  });

/** Mounted at /api/org: the people with an organization role. Org invitations are under /api/invitations. */
const manageOrgUsers = requirePermission('org.users.manage');
export const orgRoutes = new Hono<AppEnv>()
  .get('/members', requireAuth, manageOrgUsers, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listOrgMembers() }));
  })
  .patch('/members/:userId', requireAuth, manageOrgUsers, validate('param', userIdParamSchema), validate('json', changeRoleSchema), async (c) => {
    await changeOrgRole(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Role changed' }));
  })
  .delete('/members/:userId', requireAuth, manageOrgUsers, validate('param', userIdParamSchema), async (c) => {
    await removeOrgRole(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Organization role removed' }));
  })
  // Org roles to choose from when inviting an admin or changing one.
  .get('/roles', requireAuth, manageOrgUsers, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await orgRoles(c.get('permissions')) }));
  })
  // The People directory: everyone with an account, and account-level actions.
  .get('/people', requireAuth, manageOrgUsers, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listOrgPeople() }));
  })
  .post('/people/:userId/deactivate', requireAuth, manageOrgUsers, validate('param', userIdParamSchema), async (c) => {
    await setPersonActive(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), false, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Account deactivated' }));
  })
  .post('/people/:userId/reactivate', requireAuth, manageOrgUsers, validate('param', userIdParamSchema), async (c) => {
    await setPersonActive(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), true, requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Account reactivated' }));
  })
  .post('/people/:userId/password-reset', requireAuth, manageOrgUsers, validate('param', userIdParamSchema), async (c) => {
    await sendResetLink(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Reset link sent' }));
  })
  .post('/people/:userId/two-factor/reset', requireAuth, manageOrgUsers, validate('param', userIdParamSchema), async (c) => {
    await resetPersonTwoFactor(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Two-factor sign-in reset' }));
  })
  .post(
    '/people/:userId/tenants',
    requireAuth,
    manageOrgUsers,
    validate('param', userIdParamSchema),
    validate('json', addToTenantSchema),
    async (c) => {
      await addToTenant(c.get('auth'), c.req.valid('param').userId, c.get('permissions'), c.req.valid('json'), requestMeta(c));
      return c.json(apiResponse({ success: true, message: 'Added to tenant' }), 201);
    },
  );

/** Mounted at /api/roles: the role editor. */
const manageRoles = requirePermission('org.roles.manage');
export const rolesRoutes = new Hono<AppEnv>()
  .get('/', requireAuth, manageRoles, async (c) => {
    // `held`: what the editor may tick (their own org-level permissions).
    const data = { ...(await listRoles()), held: [...c.get('permissions')].sort() };
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .post('/', requireAuth, manageRoles, validate('json', createRoleSchema), async (c) => {
    const data = await createRole(c.get('auth'), c.get('permissions'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Role created', data }), 201);
  })
  .patch('/:id', requireAuth, manageRoles, validate('param', roleIdParamSchema), validate('json', updateRoleSchema), async (c) => {
    await updateRole(c.get('auth'), c.req.valid('param').id, c.get('permissions'), c.req.valid('json'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Role saved' }));
  })
  .delete('/:id', requireAuth, manageRoles, validate('param', roleIdParamSchema), async (c) => {
    await deleteRole(c.get('auth'), c.req.valid('param').id, c.get('permissions'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Role deleted' }));
  });

/** Mounted at /api/audit: the organization's audit log, read-only. */
const viewAudit = requirePermission('org.audit.view');
export const auditRoutes = new Hono<AppEnv>()
  .get('/', requireAuth, viewAudit, validate('query', auditQuerySchema), async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listAudit(c.req.valid('query')) }));
  })
  .get('/filters', requireAuth, viewAudit, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await auditFilterOptions() }));
  });

/** The :tenantId of a route under /api/t/:tenantId (the permission guard has already checked it). */
function tenantIdOf(c: Context<AppEnv>): string {
  const id = c.req.param('tenantId');
  if (!id) throw new AppError('NOT_FOUND', 'Tenant not found.');
  return id;
}

/** Mounted at /api/t/:tenantId — everything inside one tenant. */
export const tenantRoutes = new Hono<AppEnv>()
  .get('/permissions', requireAuth, requireTenantAccess, async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: [...c.get('permissions')].sort() }));
  })
  .get('/members', requireAuth, requirePermission('tenant.users.view'), async (c) => {
    return c.json(apiResponse({ success: true, message: 'ok', data: await listMembers(tenantIdOf(c)) }));
  })
  .patch(
    '/members/:userId',
    requireAuth,
    requirePermission('tenant.users.manage'),
    validate('param', userIdParamSchema),
    validate('json', changeRoleSchema),
    async (c) => {
      const { userId } = c.req.valid('param');
      await changeMemberRole(c.get('auth'), tenantIdOf(c), userId, c.get('permissions'), c.req.valid('json'), requestMeta(c));
      return c.json(apiResponse({ success: true, message: 'Role changed' }));
    },
  )
  .delete('/members/:userId', requireAuth, requirePermission('tenant.users.manage'), validate('param', userIdParamSchema), async (c) => {
    await removeMember(c.get('auth'), tenantIdOf(c), c.req.valid('param').userId, c.get('permissions'), requestMeta(c));
    return c.json(apiResponse({ success: true, message: 'Removed from tenant' }));
  })
  // Roles to choose from when inviting or changing someone's role.
  .get('/roles', requireAuth, requirePermission('tenant.users.manage'), async (c) => {
    const data = await tenantRoles(tenantIdOf(c), c.get('permissions'));
    return c.json(apiResponse({ success: true, message: 'ok', data }));
  })
  .route('/invitations', manageInvitations('tenant.users.manage'));
