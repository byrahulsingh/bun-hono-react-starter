/**
 * What the rest of the app knows about sending email. Nothing outside this
 * folder imports an adapter: swapping SMTP for, say, an SES API adapter is a
 * new adapter file and a config change, not a change to anything that sends.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Display name for the sender (the product name). Used only when MAIL_FROM
   * is a bare address; a name written in MAIL_FROM wins.
   */
  fromName?: string;
}

export interface EmailSender {
  /** Which adapter, for logs: `smtp`, `memory`, … */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
  /** Checks the connection and credentials without sending (the dashboard's "Test connection"). */
  verify(): Promise<void>;
  /** Lets go of open connections, when the settings change and a new sender replaces it. */
  close?(): void;
}
