import { createHmac } from 'node:crypto';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { getSecret } from '../lib/aws';
import type { WebhookMessage } from '../lib/events';

/**
 * Delivers one webhook per message. Signed like Stripe's:
 *   X-Stills-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
 * Non-2xx answers retry (SQS), then go to the dead-letter queue.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (msg) => {
      try {
        const m: WebhookMessage = JSON.parse(msg.body);
        const body = JSON.stringify({ id: m.id, event: m.event, at: m.at, data: m.data });
        const t = Math.floor(Date.now() / 1000);
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'user-agent': 'stills-service-webhooks/1',
          'x-stills-event': m.event,
          'x-stills-delivery': m.id,
        };
        if (m.secret) {
          const sig = createHmac('sha256', await getSecret(m.secret)).update(`${t}.${body}`).digest('hex');
          headers['x-stills-signature'] = `t=${t},v1=${sig}`;
        }
        const res = await fetch(m.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${m.app} answered ${res.status}`);
      } catch (e) {
        console.error('Webhook failed', msg.messageId, e);
        failures.push({ itemIdentifier: msg.messageId });
      }
    }),
  );
  return { batchItemFailures: failures };
}
