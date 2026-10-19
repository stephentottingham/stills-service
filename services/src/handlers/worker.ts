import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { buildZip } from '../lib/zips';
import { getStill } from '../lib/stills';
import { ensureRendition } from '../lib/renditions';
import { Size, isSize } from '../lib/sizes';

/**
 * Background work: zips, and renditions for new versions (so galleries show
 * the new version straight away). Step Functions take over for very large
 * batches in phase 2.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const msg of event.Records) {
    try {
      const job = JSON.parse(msg.body);
      if (job.kind === 'zip') await buildZip(job.id);
      else if (job.kind === 'render') {
        const s = await getStill(job.stillId);
        // Skip if deleted or already moved on to a newer version.
        if (s && s.status === 'ready' && s.version === job.version) {
          for (const size of (job.sizes as string[]).filter(isSize)) await ensureRendition(s, size as Size, job.version);
        }
      } else console.warn('Unknown job', job);
    } catch (e) {
      console.error('Job failed', msg.messageId, e);
      failures.push({ itemIdentifier: msg.messageId });
    }
  }
  return { batchItemFailures: failures };
}
