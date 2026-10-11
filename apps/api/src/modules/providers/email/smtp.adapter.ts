import nodemailer from 'nodemailer';

import type { EmailMessage, EmailSender } from './email.port';

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

/** `Name <a@b>` as configured; a bare address gets `fromName`, quoted by nodemailer. */
function sender(from: string, fromName?: string): string | { name: string; address: string } {
  if (from.includes('<') || !fromName) return from;
  return { name: fromName, address: from.trim() };
}

/** Any SMTP server: Gmail (app password), Amazon SES, SendGrid, Microsoft 365, Mailpit. */
export function smtpSender(config: SmtpConfig): EmailSender {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    // Reuse connections across a batch instead of a TCP + TLS handshake per email.
    pool: true,
    maxConnections: 3,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    name: 'smtp',
    async send({ fromName, ...message }: EmailMessage) {
      await transport.sendMail({ from: sender(config.from, fromName), ...message });
    },
    async verify() {
      await transport.verify();
    },
    close() {
      transport.close();
    },
  };
}
