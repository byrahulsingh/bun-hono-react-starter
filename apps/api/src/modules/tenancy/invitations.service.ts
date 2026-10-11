/**
 * Invitations: the only way people other than the first owner get in.
 *
 *   org invite     tenant_id null, an org-scope role   (needs org.users.manage)
 *   tenant invite  tenant_id set, a tenant-scope role  (needs tenant.users.manage there)
 *
 * Creating runs as app_user (public tables only). Previewing and accepting
 * touch login data, so they run as iam_service.
 */

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';

import type { Tx } from '#/db/db';
import { withApp, withIam } from '#/db/db';
import {
  invitations,
  organization,
  profiles,
  rolePermissions,
  roles,
  tenantMemberships,
  tenants,
} from '#/db/schema';
import { hashToken, randomToken } from '#/libs/crypto';
import { AppError } from '#/libs/errors';
import { logger } from '#/libs/logger';
import type { RequestMeta } from '#/libs/request-meta';
import { recordAudit } from '#/modules/audit';
import type { AuthContext, SignInResult } from '#/modules/iam';
import {
  assertUsableDeviceKey,
  AUTH,
  createUser,
  emailSchema,
  findUserByEmail,
  getUser,
  hashPassword,
  rateLimit,
  RATE_LIMITS,
  ssoForEmail,
  ssoRequiredError,
  ssoRequiredForEmail,
  startSignIn,
} from '#/modules/iam';
import { enqueueEmail } from '#/modules/notifications';

import { invitationEmail } from './tenancy.emails';
import type { acceptExistingSchema, acceptNewSchema, bulkInvitationSchema, createInvitationSchema } from './tenancy.validators';

const LINK_INVALID = 'This invitation is invalid, used or expired. Ask for a new one.';

// ─── Create, list, revoke (signed-in admins and managers) ────────

/**
 * Refuses an invitation that would grant nothing new. Only says so when the
 * person already has access here, which the inviter can see in the people
 * list anyway; whether the email has an account elsewhere is never revealed.
 * (Accepting checks again, so a race here is harmless.)
 */
async function assertNoAccessYet(email: string, tenantId: string | null) {
  const problem = await withIam(async (tx) => {
    const user = await findUserByEmail(tx, email);
    if (!user) return null;
    if (user.status !== 'active') return 'This account is deactivated. Reactivate it on the People page first.';
    const [profile] = await tx
      .select({ orgRoleId: profiles.org_role_id })
      .from(profiles)
      .where(and(eq(profiles.id, user.id), isNull(profiles.deleted_at)));
    if (profile?.orgRoleId) {
      return tenantId
        ? 'Already has access to every tenant through their organization role.'
        : 'Already has an organization role.';
    }
    if (!tenantId) return null;
    const [membership] = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenant_id, tenantId),
          eq(tenantMemberships.user_id, user.id),
          isNull(tenantMemberships.deleted_at),
        ),
      );
    return membership ? 'Already a member of this tenant.' : null;
  });
  if (problem) throw new AppError('VALIDATION', 'Some fields are invalid.', { email: problem });
}

/** The role an invitation would hand out: right level, and nothing the inviter lacks. */
async function invitableRole(tx: Tx, roleId: string, tenantId: string | null, callerPermissions: Set<string>) {
  const [role] = await tx
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), isNull(roles.deleted_at)))
    // Held until commit: a delete of this role waits, then sees the invitation.
    .for('share');
  const scope = tenantId ? 'tenant' : 'org';
  if (!role || role.scope !== scope || (role.tenant_id && role.tenant_id !== tenantId)) {
    throw new AppError('VALIDATION', 'Some fields are invalid.', { role_id: `Choose a ${scope} role` });
  }

  // Nobody hands out more than they hold.
  const granted = await tx
    .select({ key: rolePermissions.permission_key })
    .from(rolePermissions)
    .where(eq(rolePermissions.role_id, role.id));
  if (granted.some(({ key }) => !callerPermissions.has(key))) {
    throw new AppError('FORBIDDEN', 'You cannot invite someone with more access than you have.');
  }
  return role;
}

export async function createInvitation(
  auth: AuthContext,
  tenantId: string | null,
  callerPermissions: Set<string>,
  input: z.infer<typeof createInvitationSchema>,
  meta: RequestMeta,
): Promise<{ id: string; expires_at: Date; replaced: boolean }> {
  await assertNoAccessYet(input.email, tenantId);
  return withApp(async (tx) => {
    const role = await invitableRole(tx, input.role_id, tenantId, callerPermissions);

    // Inviting the same email to the same place again replaces the old link.
    const replaced = await tx
      .update(invitations)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(invitations.email, input.email),
          tenantId ? eq(invitations.tenant_id, tenantId) : isNull(invitations.tenant_id),
          eq(invitations.status, 'pending'),
          isNull(invitations.deleted_at),
        ),
      )
      .returning({ id: invitations.id });

    const token = randomToken();
    const [invite] = await tx
      .insert(invitations)
      .values({
        email: input.email,
        tenant_id: tenantId,
        role_id: role.id,
        token_hash: Buffer.from(await hashToken(token)),
        expires_at: new Date(Date.now() + AUTH.invitationSeconds * 1000),
        invited_by: auth.userId,
      })
      .returning({ id: invitations.id, expires_at: invitations.expires_at });

    const [org] = await tx.select({ name: organization.name }).from(organization);
    const [inviter] = await tx.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, auth.userId));
    const [tenant] = tenantId
      ? await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId))
      : [];

    await enqueueEmail(
      tx,
      invitationEmail({
        to: input.email,
        token,
        inviterName: inviter?.name ?? 'Someone',
        placeName: tenant?.name ?? org?.name ?? 'the team',
        roleName: role.name,
      }),
    );
    await recordAudit(
      tx,
      {
        action: 'invitation.created',
        actorUserId: auth.userId,
        tenantId,
        targetType: 'invitation',
        targetId: invite!.id,
        changes: { email: input.email, role: role.name },
      },
      meta,
    );
    return { ...invite!, replaced: replaced.length > 0 };
  });
}

export type BulkInviteStatus = 'sent' | 'resent' | 'skipped' | 'invalid' | 'failed';

/**
 * Many addresses, one role. The role is checked once, up front: if it is
 * wrong, nothing is sent. Then each address on its own, so one that cannot be
 * invited (already a member, deactivated, not an email) does not stop the rest.
 */
export async function createInvitations(
  auth: AuthContext,
  tenantId: string | null,
  callerPermissions: Set<string>,
  input: z.infer<typeof bulkInvitationSchema>,
  meta: RequestMeta,
): Promise<{ email: string; status: BulkInviteStatus; message?: string }[]> {
  await withApp((tx) => invitableRole(tx, input.role_id, tenantId, callerPermissions));

  const results: { email: string; status: BulkInviteStatus; message?: string }[] = [];
  const seen = new Set<string>();
  for (const raw of input.emails) {
    const parsed = emailSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({ email: raw.trim(), status: 'invalid', message: 'Not an email address' });
      continue;
    }
    const email = parsed.data;
    if (seen.has(email)) continue;
    seen.add(email);
    try {
      const { replaced } = await createInvitation(auth, tenantId, callerPermissions, { email, role_id: input.role_id }, meta);
      results.push({ email, status: replaced ? 'resent' : 'sent' });
    } catch (err) {
      const reason = err instanceof AppError ? (err.details as Record<string, string> | undefined)?.email : undefined;
      if (reason) results.push({ email, status: 'skipped', message: reason });
      else {
        logger.http.error({ err }, 'Bulk invitation failed for one address');
        results.push({ email, status: 'failed', message: 'Could not be sent. Try this one again.' });
      }
    }
  }
  return results;
}

export async function listInvitations(tenantId: string | null) {
  return withApp(async (tx) => {
    const rows = await tx
      .select({
        id: invitations.id,
        email: invitations.email,
        status: invitations.status,
        role: { id: roles.id, name: roles.name },
        expires_at: invitations.expires_at,
        accepted_at: invitations.accepted_at,
        created_at: invitations.created_at,
      })
      .from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.role_id))
      .where(
        and(tenantId ? eq(invitations.tenant_id, tenantId) : isNull(invitations.tenant_id), isNull(invitations.deleted_at)),
      )
      .orderBy(desc(invitations.created_at))
      .limit(200);
    // "expired" is not stored: it is a pending invite whose time has run out.
    return rows.map((r) => ({
      ...r,
      status: r.status === 'pending' && r.expires_at.getTime() <= Date.now() ? 'expired' : r.status,
    }));
  });
}

export async function revokeInvitation(auth: AuthContext, tenantId: string | null, id: string, meta: RequestMeta) {
  await withApp(async (tx) => {
    const revoked = await tx
      .update(invitations)
      .set({ status: 'revoked' })
      .where(
        and(
          eq(invitations.id, id),
          tenantId ? eq(invitations.tenant_id, tenantId) : isNull(invitations.tenant_id),
          eq(invitations.status, 'pending'),
        ),
      )
      .returning({ id: invitations.id });
    if (revoked.length === 0) throw new AppError('NOT_FOUND', 'No pending invitation with that id.');
    await recordAudit(tx, { action: 'invitation.revoked', actorUserId: auth.userId, tenantId, targetType: 'invitation', targetId: id }, meta);
  });
}

// ─── Preview and accept (the invited person) ─────────────────────

type Invitation = typeof invitations.$inferSelect;

/** The pending, unexpired invitation for a raw token, locked for this transaction. */
async function findOpenInvitation(tx: Tx, token: string): Promise<Invitation | undefined> {
  const [invite] = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.token_hash, Buffer.from(await hashToken(token))),
        eq(invitations.status, 'pending'),
        isNull(invitations.deleted_at),
        gt(invitations.expires_at, sql`now()`),
      ),
    )
    .for('update');
  return invite;
}

export interface InvitationPreview {
  email: string;
  organization_name: string;
  tenant_name: string | null;
  role_name: string;
  inviter_name: string | null;
  expires_at: Date;
  /** The page shows "sign in to accept" instead of "choose a password". Only the link holder sees this. */
  account_exists: boolean;
  /** Single sign-on for the invited email's domain: offered, or (required) the only way in. */
  sso: { name: string; required: boolean } | null;
}

export async function previewInvitation(token: string, meta: RequestMeta): Promise<InvitationPreview> {
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  return withIam(async (tx) => {
    const invite = await findOpenInvitation(tx, token);
    if (!invite) throw new AppError('LINK_INVALID', LINK_INVALID);
    const [org] = await tx.select({ name: organization.name }).from(organization);
    const [role] = await tx.select({ name: roles.name }).from(roles).where(eq(roles.id, invite.role_id));
    const [tenant] = invite.tenant_id
      ? await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, invite.tenant_id))
      : [];
    const [inviter] = invite.invited_by
      ? await tx.select({ name: profiles.name }).from(profiles).where(eq(profiles.id, invite.invited_by))
      : [];
    return {
      email: invite.email,
      organization_name: org?.name ?? '',
      tenant_name: tenant?.name ?? null,
      role_name: role?.name ?? '',
      inviter_name: inviter?.name ?? null,
      expires_at: invite.expires_at,
      account_exists: Boolean(await findUserByEmail(tx, invite.email)),
      sso: await ssoForEmail(tx, invite.email),
    };
  });
}

/** Gives the person what the invitation grants, and marks it used. */
async function applyInvitation(tx: Tx, invite: Invitation, userId: string, meta: RequestMeta) {
  if (invite.tenant_id === null) {
    const [profile] = await tx.select({ orgRoleId: profiles.org_role_id }).from(profiles).where(eq(profiles.id, userId));
    if (profile?.orgRoleId) {
      throw new AppError('CONFLICT', 'You already have an organization role. Ask an admin to change it instead.');
    }
    await tx.update(profiles).set({ org_role_id: invite.role_id }).where(eq(profiles.id, userId));
  } else {
    const [existing] = await tx
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(
        and(
          eq(tenantMemberships.tenant_id, invite.tenant_id),
          eq(tenantMemberships.user_id, userId),
          isNull(tenantMemberships.deleted_at),
        ),
      );
    if (existing) throw new AppError('CONFLICT', 'You are already a member of this tenant.');
    await tx.insert(tenantMemberships).values({
      tenant_id: invite.tenant_id,
      user_id: userId,
      role_id: invite.role_id,
      created_by: invite.invited_by,
    });
  }
  await tx
    .update(invitations)
    .set({ status: 'accepted', accepted_at: new Date() })
    .where(eq(invitations.id, invite.id));
  await recordAudit(
    tx,
    { action: 'invitation.accepted', actorUserId: userId, tenantId: invite.tenant_id, targetType: 'invitation', targetId: invite.id },
    meta,
  );
}

/**
 * A new person: creates their account from the invitation and signs them in,
 * or, when the organization requires two-factor, sends them to set it up first.
 */
export async function acceptAsNewAccount(input: z.infer<typeof acceptNewSchema>, meta: RequestMeta): Promise<SignInResult> {
  await assertUsableDeviceKey(input.device_public_key);
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  const passwordHash = await hashPassword(input.password);

  return withIam(async (tx) => {
    const invite = await findOpenInvitation(tx, input.token);
    if (!invite) throw new AppError('LINK_INVALID', LINK_INVALID);
    if (await findUserByEmail(tx, invite.email)) {
      throw new AppError('CONFLICT', 'An account already exists for this email. Sign in, then open the link again.');
    }
    // Where SSO is required, the account is made by signing in with it, not with a password.
    const sso = await ssoRequiredForEmail(tx, invite.email);
    if (sso) throw ssoRequiredError(sso.name);
    // The link arrived at this address, which proves the person owns it.
    const user = await createUser(tx, { email: invite.email, passwordHash, emailConfirmed: true });
    await tx.insert(profiles).values({ id: user.id, name: input.name });
    await applyInvitation(tx, invite, user.id, meta);
    return startSignIn(tx, user.id, { devicePublicKey: input.device_public_key, browserId: input.browser_id }, meta);
  });
}

/** Someone already signed in: adds the invitation's access to their account. */
export async function acceptAsSignedIn(auth: AuthContext, input: z.infer<typeof acceptExistingSchema>, meta: RequestMeta) {
  await rateLimit(`link:ip:${meta.ip ?? 'unknown'}`, RATE_LIMITS.linkPerIp);
  await withIam(async (tx) => {
    const invite = await findOpenInvitation(tx, input.token);
    if (!invite) throw new AppError('LINK_INVALID', LINK_INVALID);
    const user = await getUser(tx, auth.userId);
    if (!user || user.email !== invite.email) {
      throw new AppError('FORBIDDEN', `This invitation is for ${invite.email}. Sign in with that account to accept it.`);
    }
    await applyInvitation(tx, invite, user.id, meta);
  });
}


/**
 * Someone signed in through SSO for the first time and has no account (the
 * iam module's provisionInvited hook, inside its transaction): their open
 * invitations create it and are all accepted. Null when nothing invites them.
 */
export async function provisionFromInvitations(
  tx: Tx,
  person: { email: string; name: string | null },
  meta: RequestMeta,
): Promise<string | null> {
  const open = await tx
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.email, person.email),
        eq(invitations.status, 'pending'),
        isNull(invitations.deleted_at),
        gt(invitations.expires_at, sql`now()`),
      ),
    )
    .for('update');
  if (open.length === 0) return null;
  // The provider vouched for the address, as an invitation link would have.
  const user = await createUser(tx, { email: person.email, passwordHash: null, emailConfirmed: true });
  await tx.insert(profiles).values({ id: user.id, name: (person.name ?? person.email.split('@')[0]!).slice(0, 100) });
  for (const invite of open) await applyInvitation(tx, invite, user.id, meta);
  return user.id;
}
