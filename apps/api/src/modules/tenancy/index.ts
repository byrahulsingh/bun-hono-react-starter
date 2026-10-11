import { configureSso, requireTwoFactorWhen } from '#/modules/iam';

import { provisionFromInvitations } from './invitations.service';
import { isOrgOwner } from './sso-policy';
import { twoFactorRequiredFor } from './two-factor-policy';

// Auth asks the organization's rules whenever someone signs in.
requireTwoFactorWhen(twoFactorRequiredFor);
configureSso({ provisionInvited: provisionFromInvitations, mayUsePasswordAnyway: isOrgOwner });

export { requirePermission, requireTenantAccess } from './permissions';
export { isOrgOwner } from './sso-policy';
export { announceSetupIfNeeded } from './tenancy.service';
export type { Me } from './tenancy.service';
export { auditRoutes, invitationRoutes, meRoutes, orgRoutes, rolesRoutes, setupRoutes, tenantRoutes, tenantsRoutes } from './tenancy.routes';
export type { PermissionKey } from './tenancy.catalog';
