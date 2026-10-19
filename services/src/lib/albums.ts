import { normalise } from '@stills/recipe';
import { getItem, putItem, queryAll, clean } from './aws';
import { Album, Company, COMPANIES, Principal } from './model';
import { badRequest, notFound } from './errors';
import { canSee, norm } from './stills';
import { newId } from './ids';

export function albumItem(a: Album): Record<string, unknown> {
  return {
    pk: `ALBUM#${a.id}`,
    sk: 'META',
    type: 'album',
    ...a,
    gsi1pk: 'ALBUM',
    gsi1sk: `${a.createdAt}#${a.id}`,
    gsi2pk: a.jobId ? `JOB#${a.jobId}` : undefined,
    gsi2sk: a.jobId ? `ALBUM#${a.createdAt}#${a.id}` : undefined,
    gsi3pk: a.client ? `CLIENT#${norm(a.client)}` : undefined,
    gsi3sk: a.client ? `ALBUM#${a.createdAt}#${a.id}` : undefined,
  };
}

export async function getAlbum(id: string, who?: Principal): Promise<Album> {
  const item = await getItem<Record<string, any>>(`ALBUM#${id}`);
  if (!item) throw notFound('No such album');
  const a = clean<Album>(item);
  if (who && !canSee(who, [a.company])) throw notFound('No such album');
  return a;
}

/** Validates the fields people may set on an album. */
export function albumFields(body: Record<string, any>, existing?: Album): Partial<Album> {
  const out: Partial<Album> = {};
  if ('name' in body || !existing) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('name is required');
    out.name = body.name.trim().slice(0, 200);
  }
  if ('company' in body || !existing) {
    if (!COMPANIES.includes(body.company)) throw badRequest(`company must be one of: ${COMPANIES.join(', ')}`);
    out.company = body.company as Company;
  }
  if ('client' in body) out.client = typeof body.client === 'string' && body.client.trim() ? body.client.trim().slice(0, 200) : undefined;
  if ('jobId' in body) out.jobId = typeof body.jobId === 'string' && body.jobId.trim() ? body.jobId.trim().slice(0, 100) : undefined;
  if ('look' in body) out.look = body.look ? normalise(body.look) : undefined;
  if ('retentionDays' in body) {
    if (body.retentionDays === null) out.retentionDays = undefined;
    else if (!Number.isInteger(body.retentionDays) || body.retentionDays < 1 || body.retentionDays > 36500)
      throw badRequest('retentionDays must be a whole number of days');
    else out.retentionDays = body.retentionDays;
  }
  return out;
}

export async function createAlbum(body: Record<string, any>, who: Principal): Promise<Album> {
  const fields = albumFields(body);
  const a: Album = {
    id: newId('al'),
    ...(fields as Pick<Album, 'name' | 'company'>),
    ...fields,
    createdAt: new Date().toISOString(),
    createdBy: who.id,
  };
  if (!canSee(who, [a.company])) throw badRequest('This app cannot create albums for that company');
  await putItem(albumItem(a), 'attribute_not_exists(pk)');
  return a;
}

export async function saveAlbum(a: Album): Promise<void> {
  await putItem(albumItem(a));
}

export async function listAlbums(f: { company?: string; client?: string; jobId?: string }, who: Principal): Promise<Album[]> {
  let rows: Record<string, any>[];
  if (f.jobId) {
    rows = await queryAll({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :p AND begins_with(gsi2sk, :s)',
      ExpressionAttributeValues: { ':p': `JOB#${f.jobId}`, ':s': 'ALBUM#' },
    });
  } else if (f.client) {
    rows = await queryAll({
      IndexName: 'gsi3',
      KeyConditionExpression: 'gsi3pk = :p AND begins_with(gsi3sk, :s)',
      ExpressionAttributeValues: { ':p': `CLIENT#${norm(f.client)}`, ':s': 'ALBUM#' },
      ScanIndexForward: false,
    });
  } else {
    rows = await queryAll(
      { IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': 'ALBUM' }, ScanIndexForward: false },
      5000,
    );
  }
  return rows
    .map((r) => clean<Album>(r))
    .filter((a) => (!f.company || a.company === f.company) && canSee(who, [a.company]))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
