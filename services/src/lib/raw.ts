import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config';
import { s3, putItem, getItem, queryAll, clean } from './aws';
import { Album, RawFile } from './model';
import { albumStillIds, getStills, setStillFields } from './stills';

/**
 * RAW files are not processed or shown. They wait in the RAW inbox (an S3
 * bucket, under raw/) until the Synology's Cloud Sync pulls them down, and the
 * bucket clears them after 30 days. Each is paired with the JPEG of the same
 * name in its album, so the still shows where its RAW lives on the server.
 *
 * Folder on the Synology: <company>/<date>-<album name>_<album id>/<file>
 */

export const RAW_EXTENSIONS = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'dng',
  'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'mos', 'mef', 'erf', 'kdc', 'dcr',
];

export function isRaw(filename: string): boolean {
  return RAW_EXTENSIONS.includes(extOf(filename));
}

export function extOf(filename: string): string {
  return (filename.split('.').pop() ?? '').toLowerCase();
}

/** The name without its extension, for pairing IMG_0001.CR3 with IMG_0001.jpg. */
export function baseOf(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').toLowerCase();
}

function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .slice(0, 60) || 'album'
  );
}

export function rawFolder(album: Album): string {
  return `${album.company}/${album.createdAt.slice(0, 10)}-${slug(album.name)}_${album.id}`;
}

export function safeName(filename: string): string {
  return filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200);
}

export async function requestRawUpload(album: Album, filename: string, size: number, by: string) {
  const name = safeName(filename);
  const path = `${rawFolder(album)}/${name}`;
  const key = `raw/${path}`;
  const raw: RawFile = {
    albumId: album.id,
    filename: name,
    path,
    key,
    bytes: size,
    status: 'requested',
    requestedAt: new Date().toISOString(),
    uploadedBy: by,
  };
  await putItem({ pk: `ALBUM#${album.id}`, sk: `RAW#${name.toLowerCase()}`, type: 'raw', ...raw });
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: config.rawBucket, Key: key, ContentType: 'application/octet-stream', ContentLength: size }),
    { expiresIn: 6 * 3600 }, // RAW batches on slow connections take a while
  );
  return { kind: 'raw' as const, name, path, url, method: 'PUT', headers: { 'content-type': 'application/octet-stream' } };
}

export async function listRaws(albumId: string): Promise<RawFile[]> {
  const rows = await queryAll<Record<string, any>>({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `ALBUM#${albumId}`, ':s': 'RAW#' },
  });
  return rows.map((r) => clean<RawFile>(r));
}

/** S3 says a RAW has arrived in the inbox: record it and pair it with its JPEG. */
export async function rawArrived(key: string, bytes: number): Promise<void> {
  const m = /^raw\/[^/]+\/[^/]*_(al_[0-9a-z]+)\/(.+)$/.exec(key);
  if (!m) return;
  const [, albumId, name] = m;
  const item = await getItem<Record<string, any>>(`ALBUM#${albumId}`, `RAW#${name.toLowerCase()}`);
  if (!item) return;
  const raw = clean<RawFile>(item);
  const arrived: RawFile = { ...raw, status: 'arrived', bytes, arrivedAt: new Date().toISOString() };
  const stills = await getStills(await albumStillIds(albumId));
  const partner = stills.find((s) => s.status === 'ready' && baseOf(s.filename) === baseOf(name));
  if (partner) {
    arrived.stillId = partner.id;
    await setStillFields(partner.id, { raw: { filename: raw.filename, path: raw.path, bytes } });
  }
  await putItem({ pk: `ALBUM#${albumId}`, sk: `RAW#${name.toLowerCase()}`, type: 'raw', ...arrived });
}

/** A JPEG is ready: link it to its RAW if that is already here. */
export async function pairStillWithRaw(stillId: string, filename: string, albumIds: string[]): Promise<void> {
  for (const albumId of albumIds) {
    const raw = (await listRaws(albumId)).find((r) => r.status === 'arrived' && baseOf(r.filename) === baseOf(filename));
    if (!raw) continue;
    await setStillFields(stillId, { raw: { filename: raw.filename, path: raw.path, bytes: raw.bytes } });
    await putItem({ pk: `ALBUM#${albumId}`, sk: `RAW#${raw.filename.toLowerCase()}`, type: 'raw', ...raw, stillId });
    return;
  }
}
