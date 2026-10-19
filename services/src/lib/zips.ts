import { PassThrough } from 'node:stream';
import archiver from 'archiver';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config';
import { s3, getItem, putItem, getObjectBuffer, sendMessages, clean } from './aws';
import { ZipJob, Principal, Still, Company } from './model';
import { newId } from './ids';
import { badRequest, notFound } from './errors';
import { getStills, canSee } from './stills';
import { renditionExists, makeRendition } from './renditions';
import { renditionKey, Size } from './sizes';
import { signPath } from './signing';
import { sendEmail, isEmail } from './email';
import { emit } from './events';

export function zipItem(z: ZipJob) {
  // Zip records tidy themselves away after 30 days (the files after 7, by S3 lifecycle).
  const ttl = Math.floor(Date.parse(z.createdAt) / 1000) + 30 * 86400;
  return { pk: `ZIP#${z.id}`, sk: 'META', type: 'zip', ...z, ttl };
}

export async function requestZip(
  opts: { stillIds: string[]; size: 'web' | 'full'; email?: string; galleryToken?: string },
  who: Principal | { id: string },
): Promise<ZipJob> {
  if (!opts.stillIds.length) throw badRequest('Nothing to zip');
  if (opts.stillIds.length > 2000) throw badRequest('Zips hold up to 2,000 stills');
  if (opts.size !== 'web' && opts.size !== 'full') throw badRequest('size must be web or full');
  if (opts.email !== undefined && !isEmail(opts.email)) throw badRequest('That email address does not look right');
  const z: ZipJob = {
    id: newId('zip'),
    status: 'queued',
    size: opts.size,
    stillIds: opts.stillIds,
    email: opts.email,
    galleryToken: opts.galleryToken,
    requestedBy: who.id,
    createdAt: new Date().toISOString(),
  };
  await putItem(zipItem(z));
  await sendMessages(config.workQueueUrl, [{ kind: 'zip', id: z.id }]);
  return z;
}

export async function getZip(id: string): Promise<ZipJob> {
  const item = await getItem<Record<string, any>>(`ZIP#${id}`);
  if (!item) throw notFound('No such zip');
  return clean<ZipJob>(item);
}

export async function zipStillsFor(ids: string[], who: Principal): Promise<string[]> {
  const stills = await getStills(ids);
  return stills.filter((s) => s.status === 'ready' && canSee(who, s.companies)).map((s) => s.id);
}

/** Builds the zip, streaming each rendition into a multipart upload. */
export async function buildZip(id: string): Promise<void> {
  const z = await getZip(id);
  if (z.status === 'ready') return;
  await putItem(zipItem({ ...z, status: 'working' }));
  try {
    const size: Size = z.size === 'full' ? 'full' : 'm';
    const stills = (await getStills(z.stillIds)).filter((s) => s.status === 'ready');
    const key = `z/${z.id}/stills-${z.size}.zip`;
    const body = new PassThrough();
    const archive = archiver('zip', { store: true }); // JPEGs do not compress further
    archive.on('warning', (e) => console.warn(e));
    archive.pipe(body);
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: config.renditionsBucket,
        Key: key,
        Body: body,
        ContentType: 'application/zip',
        ContentDisposition: `attachment; filename="stills-${z.size}.zip"`,
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
    });
    const uploading = upload.done();
    const names = new Set<string>();
    for (const s of stills) {
      const jpeg = (await renditionExists(s.id, size, s.version))
        ? await getObjectBuffer(config.renditionsBucket, renditionKey(s.id, size, s.version))
        : await makeRendition(s, size, s.version);
      // Wait for each entry to go through, so memory holds one picture at a time.
      await new Promise<void>((resolve, reject) => {
        archive.once('error', reject);
        archive.once('entry', () => {
          archive.off('error', reject);
          resolve();
        });
        archive.append(jpeg, { name: uniqueName(s, names) });
      });
    }
    await archive.finalize();
    await uploading;

    const ready: ZipJob = { ...z, status: 'ready', key, readyAt: new Date().toISOString() };
    await putItem(zipItem(ready));
    await notify(ready, [...new Set(stills.flatMap((s) => s.companies))]);
  } catch (e: any) {
    console.error('Zip failed', id, e);
    await putItem(zipItem({ ...z, status: 'failed', error: String(e?.message ?? e).slice(0, 300) }));
    throw e;
  }
}

async function notify(z: ZipJob, companies: Company[]) {
  // Gallery zips link back through the gallery, so withdrawing it also stops the zip.
  const link = z.galleryToken ? `${config.publicBase}/g/${z.galleryToken}/z/${z.id}` : await signPath(z.key!, { days: 7 });
  if (z.email) {
    await sendEmail(
      z.email,
      'Your pictures are ready',
      `Your zip of ${z.stillIds.length} pictures is ready to download:\n\n${link}\n\nThe link works for 7 days.`,
    );
  }
  // Only apps that may see every company in the zip hear about it.
  await emit('zip.ready', { id: z.id, url: link, count: z.stillIds.length, size: z.size, galleryToken: z.galleryToken }, companies, { all: true });
}

function uniqueName(s: Still, used: Set<string>): string {
  const base = (s.filename || s.id).replace(/\.[^.]+$/, '').replace(/[^\w.\- ]+/g, '_').slice(0, 100) || s.id;
  let name = `${base}.jpg`;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}.jpg`;
  used.add(name.toLowerCase());
  return name;
}
