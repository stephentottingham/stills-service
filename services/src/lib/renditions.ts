import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config';
import { s3, getObjectBuffer } from './aws';
import { Still } from './model';
import { Size, renditionKey } from './sizes';
import { renderJpeg } from './images';
import { getVersion } from './stills';
import { notFound } from './errors';

/** Keeps the last few originals in memory: a still's t, m and l are usually asked for together. */
const sourceCache = new Map<string, Buffer>();
const CACHE_BYTES = 400 * 1024 * 1024;

export async function sourceOf(s: Still): Promise<Buffer> {
  const key = s.masterKey ?? s.originalKey;
  const hit = sourceCache.get(key);
  if (hit) {
    sourceCache.delete(key);
    sourceCache.set(key, hit);
    return hit;
  }
  const buf = await getObjectBuffer(config.originalsBucket, key);
  sourceCache.set(key, buf);
  let total = 0;
  for (const b of sourceCache.values()) total += b.length;
  for (const [k, b] of sourceCache) {
    if (total <= CACHE_BYTES || sourceCache.size <= 1) break;
    sourceCache.delete(k);
    total -= b.length;
  }
  return buf;
}

/** Renders a rendition and stores it. Returns the JPEG bytes. */
export async function makeRendition(s: Still, size: Size, version: number, source?: Buffer): Promise<Buffer> {
  if (s.status !== 'ready' || !s.w || !s.h) throw notFound('Still is not ready');
  if (version > s.version) throw notFound('No such version');
  const v = await getVersion(s.id, version);
  if (!v) throw notFound('No such version');
  const jpeg = await renderJpeg(source ?? (await sourceOf(s)), v.recipe, size, s.w, s.h, {
    credit: s.credit,
    copyright: s.rights?.who,
    title: s.title,
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: config.renditionsBucket,
      Key: renditionKey(s.id, size, version),
      Body: jpeg,
      ContentType: 'image/jpeg',
      // The address changes with every version, so the content at an address never does.
      CacheControl: 'max-age=31536000, immutable',
    }),
  );
  return jpeg;
}

export async function renditionExists(stillId: string, size: Size, version: number): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: config.renditionsBucket, Key: renditionKey(stillId, size, version) }));
    return true;
  } catch (e: any) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

export async function ensureRendition(s: Still, size: Size, version = s.version): Promise<void> {
  if (!(await renditionExists(s.id, size, version))) await makeRendition(s, size, version);
}
