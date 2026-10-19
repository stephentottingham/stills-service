import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { processUpload } from '../lib/ingest';

/** S3 "object created" events for originals, via SQS (so failures retry, then land in the dead-letter queue). */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const msg of event.Records) {
    try {
      const body = JSON.parse(msg.body);
      for (const r of body.Records ?? []) {
        const key = decodeURIComponent(String(r.s3?.object?.key ?? '').replace(/\+/g, ' '));
        await processUpload(key);
      }
    } catch (e) {
      console.error('Upload processing failed', msg.messageId, e);
      failures.push({ itemIdentifier: msg.messageId });
    }
  }
  return { batchItemFailures: failures };
}
