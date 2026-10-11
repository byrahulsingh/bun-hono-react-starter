import { env } from '#/libs/env';
import type { EmailContent } from '#/modules/notifications';

export function invitationEmail(input: {
  to: string;
  token: string;
  inviterName: string;
  placeName: string;
  roleName: string;
}): EmailContent {
  return {
    to: input.to,
    subject: `${input.inviterName} invited you to ${input.placeName}`,
    paragraphs: [`${input.inviterName} invited you to join ${input.placeName} as ${input.roleName}.`],
    action: { label: 'Accept the invitation', url: `${env.APP_URL}/invite?token=${encodeURIComponent(input.token)}` },
    note: 'The link works once and expires in 7 days. If you did not expect this, you can ignore this email.',
  };
}

export function addedToTenantEmail(input: { to: string; adderName: string; tenantName: string; roleName: string }): EmailContent {
  return {
    to: input.to,
    subject: `You now have access to ${input.tenantName}`,
    paragraphs: [
      `${input.adderName} gave you access to ${input.tenantName} as ${input.roleName}.`,
      'It is in your tenant switcher next time you sign in.',
    ],
    action: { label: 'Open', url: `${env.APP_URL}/` },
    note: 'If you did not expect this, tell your administrator.',
  };
}

export function twoFactorResetEmail(input: { to: string; adminName: string }): EmailContent {
  return {
    to: input.to,
    subject: 'Your two-factor sign-in was reset',
    paragraphs: [
      `${input.adminName} turned off two-factor sign-in for your account, and you were signed out everywhere.`,
      'Sign in with your password, then set two-factor up again from your Account page (you will be asked straight away if your organization requires it).',
    ],
    action: { label: 'Sign in', url: `${env.APP_URL}/login` },
    note: 'If you did not ask for this, tell your administrator.',
  };
}
