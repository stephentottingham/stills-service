import { config } from './config';
import { queryAll, sendMessages } from './aws';
import { App, Company, WebhookEvent } from './model';

/**
 * Webhooks. emit() fans out one queue message per subscribed app, so a retry
 * to one app never re-sends to another. The webhooks worker signs and delivers.
 */
export interface WebhookMessage {
  app: string;
  url: string;
  secret?: string;
  event: WebhookEvent;
  id: string;
  at: string;
  data: unknown;
}

let appsCache: { apps: App[]; at: number } | undefined;

export async function listApps(): Promise<App[]> {
  if (appsCache && Date.now() - appsCache.at < 60_000) return appsCache.apps;
  const apps = await queryAll<App>({
    IndexName: 'gsi1',
    KeyConditionExpression: 'gsi1pk = :p',
    ExpressionAttributeValues: { ':p': 'APP' },
  });
  appsCache = { apps, at: Date.now() };
  return apps;
}

/**
 * Apps limited to some companies hear only about those. With `all`, an app must
 * be allowed every company listed (used for zips, which can mix companies).
 */
export async function emit(event: WebhookEvent, data: unknown, companies: Company[], opts: { all?: boolean } = {}): Promise<void> {
  const allowed = (a: App) =>
    !a.companies || (opts.all ? companies.every((c) => a.companies!.includes(c)) : companies.some((c) => a.companies!.includes(c)));
  const apps = (await listApps()).filter((a) => a.webhookUrl && (!a.events || a.events.includes(event)) && allowed(a));
  if (!apps.length) return;
  const at = new Date().toISOString();
  const id = `${event}:${at}:${Math.random().toString(36).slice(2, 10)}`;
  await sendMessages(
    config.webhookQueueUrl,
    apps.map((a): WebhookMessage => ({ app: a.app, url: a.webhookUrl!, secret: a.webhookSecret, event, id, at, data })),
  );
}
