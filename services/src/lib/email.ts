import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from './config';

const ses = new SESv2Client({});

/** Plain, short emails. Skipped (with a log line) when no sender is set up. */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!config.mailFrom) {
    console.warn('MAIL_FROM is not set; not sending:', subject);
    return;
  }
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: config.mailFrom,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
    }),
  );
}

export function isEmail(s: unknown): s is string {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
