import type { EmailMessage, EmailSender } from './email.port';

/** Keeps messages in memory. For tests: nothing leaves the process. */
export function memorySender(): EmailSender & { sent: EmailMessage[]; failNext: number } {
  const sender = {
    name: 'memory',
    sent: [] as EmailMessage[],
    /** Make the next N sends throw, to test retries. */
    failNext: 0,
    async send(message: EmailMessage) {
      if (sender.failNext > 0) {
        sender.failNext--;
        throw new Error('memory sender: simulated failure');
      }
      sender.sent.push(message);
    },
    async verify() {},
  };
  return sender;
}
