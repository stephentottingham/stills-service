import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { config } from './config';
import { getSecret } from './aws';
import { Size, renditionKey } from './sizes';

/**
 * Private files (/r/ renditions and /z/ zips) are only served by CloudFront with
 * a signed URL. We use signed URLs rather than signed cookies: a cookie would
 * open every still on the distribution, while a gallery must only open its own.
 *
 * Expiry is rounded up to the end of the next day (UTC), so a still's URL stays
 * the same for a day and browsers can cache it.
 */
export async function signPath(path: string, opts: { days?: number } = {}): Promise<string> {
  const days = opts.days ?? 1;
  const now = new Date();
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1 + days);
  const url = `${config.publicBase}/${path.replace(/^\//, '')}`;
  return getSignedUrl({
    url,
    keyPairId: config.signingKeyPairId,
    privateKey: await getSecret(config.signingKeySecret),
    dateLessThan: new Date(end).toISOString(),
  });
}

export async function renditionUrl(stillId: string, size: Size, version: number, days?: number): Promise<string> {
  return signPath(renditionKey(stillId, size, version), { days });
}

export async function renditionUrls(stillId: string, version: number, days?: number) {
  const [t, m, l, full] = await Promise.all(
    (['t', 'm', 'l', 'full'] as Size[]).map((s) => renditionUrl(stillId, s, version, days)),
  );
  return { t, m, l, full };
}
