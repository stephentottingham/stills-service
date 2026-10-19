import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { getItem, putItem, queryAll, clean, getSecret } from './aws';
import { Gallery, GalleryEvent, Principal, COMPANIES, Company, DownloadSizes, Still } from './model';
import { badRequest, gone, notFound } from './errors';
import { newToken } from './ids';
import { getAlbum } from './albums';
import { albumStillIds, getStills, canSee } from './stills';
import { config } from './config';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const EXPIRY_DAYS = [30, 90, 365];
const DOWNLOADS: DownloadSizes[] = ['none', 'web', 'full', 'both'];

export function galleryItem(g: Gallery): Record<string, unknown> {
  return {
    pk: `GALLERY#${g.token}`,
    sk: 'META',
    type: 'gallery',
    ...g,
    gsi1pk: 'GALLERY',
    gsi1sk: `${g.createdAt}#${g.token}`,
    gsi2pk: g.jobId ? `JOB#${g.jobId}` : undefined,
    gsi2sk: g.jobId ? `GALLERY#${g.createdAt}` : undefined,
  };
}

export async function createGallery(body: Record<string, any>, who: Principal): Promise<Gallery> {
  if (!body.album && !Array.isArray(body.ids)) throw badRequest('Give an album or a list of ids');
  if (typeof body.title !== 'string' || !body.title.trim()) throw badRequest('title is required');
  if (!COMPANIES.includes(body.company)) throw badRequest(`company must be one of: ${COMPANIES.join(', ')}`);
  const expiresDays = body.expiresDays ?? 90;
  if (!EXPIRY_DAYS.includes(expiresDays)) throw badRequest(`expiresDays must be one of: ${EXPIRY_DAYS.join(', ')}`);
  const downloads: DownloadSizes = body.downloads ?? 'both';
  if (!DOWNLOADS.includes(downloads)) throw badRequest(`downloads must be one of: ${DOWNLOADS.join(', ')}`);
  if (!canSee(who, [body.company])) throw badRequest('This app cannot make galleries for that company');

  let jobId: string | undefined;
  let client: string | undefined;
  if (body.watermark === true) throw badRequest('Watermarks come in phase 3');
  if (body.album) {
    const album = await getAlbum(String(body.album), who);
    jobId = album.jobId;
    client = album.client;
    // An album can draw stills from other companies; an app may only publish what it can see.
    const stills = await getStills(await albumStillIds(album.id));
    if (stills.some((s) => !canSee(who, s.companies))) throw badRequest('This album holds stills that are not available to this app');
  } else {
    if (!body.ids.length || body.ids.length > 5000) throw badRequest('ids must hold 1 to 5,000 stills');
    const stills = await getStills(body.ids.map(String));
    if (stills.length !== body.ids.length) throw badRequest('Some ids are not stills');
    if (stills.some((s) => !canSee(who, s.companies))) throw badRequest('Some stills are not available to this app');
  }

  const now = new Date();
  const g: Gallery = {
    token: newToken(),
    title: body.title.trim().slice(0, 200),
    company: body.company as Company,
    albumId: body.album ? String(body.album) : undefined,
    stillIds: body.album ? undefined : body.ids.map(String),
    jobId: typeof body.jobId === 'string' ? body.jobId : jobId,
    client: typeof body.client === 'string' ? body.client : client,
    passwordHash: body.password ? await hashPassword(String(body.password)) : undefined,
    expiresAt: new Date(now.getTime() + expiresDays * 86400_000).toISOString(),
    downloads,
    createdBy: who.id,
    createdAt: now.toISOString(),
  };
  await putItem(galleryItem(g), 'attribute_not_exists(pk)');
  return g;
}

export async function getGallery(token: string): Promise<Gallery> {
  const item = await getItem<Record<string, any>>(`GALLERY#${token}`);
  if (!item) throw notFound('This gallery does not exist');
  return clean<Gallery>(item);
}

/** Throws unless the gallery can be opened now. */
export function assertOpen(g: Gallery) {
  if (g.withdrawnAt) throw gone('This gallery has been withdrawn');
  if (g.expiresAt < new Date().toISOString()) throw gone('This gallery has expired');
}

export async function galleryStills(g: Gallery): Promise<Still[]> {
  const ids = g.albumId ? await albumStillIds(g.albumId) : (g.stillIds ?? []);
  return (await getStills(ids)).filter((s) => s.status === 'ready');
}

export async function logEvent(token: string, e: Omit<GalleryEvent, 'at'>): Promise<void> {
  const at = new Date().toISOString();
  await putItem({
    pk: `GALLERY#${token}`,
    sk: `EVT#${at}#${randomBytes(3).toString('hex')}`,
    type: 'event',
    at,
    ...e,
  });
}

export async function activity(token: string): Promise<GalleryEvent[]> {
  const rows = await queryAll<Record<string, any>>({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `GALLERY#${token}`, ':s': 'EVT#' },
    ScanIndexForward: false,
  });
  return rows.map((r) => clean<GalleryEvent>(r));
}

export function galleryView(g: Gallery) {
  const { passwordHash, ...rest } = g;
  return { ...rest, hasPassword: !!passwordHash, url: `${config.publicBase}/g/${g.token}` };
}

// Passwords: scrypt with a random salt. Stored as scrypt$<salt>$<hash>.
export async function hashPassword(pw: string): Promise<string> {
  if (pw.length < 6) throw badRequest('Passwords need at least 6 characters');
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split('$');
  const got = await scryptAsync(pw, Buffer.from(salt, 'base64'), 32);
  const want = Buffer.from(hash, 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

// The unlock cookie: gallery token + expiry, signed. It only opens one gallery.
export async function unlockCookieValue(token: string, hours = 12): Promise<string> {
  const exp = Date.now() + hours * 3600_000;
  const mac = createHmac('sha256', await getSecret(config.cookieKeySecret)).update(`${token}.${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}

export async function checkUnlockCookie(token: string, value: string | undefined): Promise<boolean> {
  if (!value) return false;
  const [exp, mac] = value.split('.');
  if (!exp || !mac || Number(exp) < Date.now()) return false;
  const want = createHmac('sha256', await getSecret(config.cookieKeySecret)).update(`${token}.${exp}`).digest('base64url');
  return want.length === mac.length && timingSafeEqual(Buffer.from(want), Buffer.from(mac));
}

export function cookieName(token: string): string {
  return `g_${token.slice(0, 12)}`;
}
