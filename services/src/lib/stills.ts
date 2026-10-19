import { TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ListObjectVersionsCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { normalise, Recipe } from '@stills/recipe';
import { config } from './config';
import { ddb, s3, getItem, putItem, queryAll, batchGet, batchDelete, clean } from './aws';
import { Still, Version, Principal, Company, People, COMPANIES } from './model';
import { badRequest, conflict, notFound, forbidden } from './errors';
import { renditionUrls, renditionUrl } from './signing';

const cloudfront = new CloudFrontClient({});

export function stillItem(s: Still): Record<string, unknown> {
  return {
    pk: `STILL#${s.id}`,
    sk: 'META',
    type: 'still',
    ...s,
    gsi1pk: 'STILL',
    gsi1sk: `${s.uploadedAt}#${s.id}`,
    gsi2pk: s.jobId ? `JOB#${s.jobId}` : undefined,
    gsi2sk: s.jobId ? `STILL#${s.id}` : undefined,
    gsi3pk: s.client ? `CLIENT#${norm(s.client)}` : undefined,
    gsi3sk: s.client ? `STILL#${s.id}` : undefined,
  };
}

export async function getStill(id: string): Promise<Still | undefined> {
  const item = await getItem<Record<string, any>>(`STILL#${id}`);
  return item ? clean<Still>(item) : undefined;
}

export async function mustGetStill(id: string, who?: Principal): Promise<Still> {
  const s = await getStill(id);
  if (!s) throw notFound('No such still');
  if (who && !canSee(who, s.companies)) throw notFound('No such still');
  return s;
}

/**
 * Writes the whole still. Pass the version you read to make sure a recipe saved
 * in the meantime is not overwritten (409 if it was).
 */
export async function saveStill(s: Still, expectVersion?: number): Promise<void> {
  if (expectVersion === undefined) return putItem(stillItem(s));
  try {
    await putItem(stillItem(s), 'version = :v', { ':v': expectVersion });
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') throw conflict('The still changed while saving. Reload and try again.');
    throw e;
  }
}

/** For changes: an app limited to some companies may only use those. */
export function assertCompanies(who: Principal, companies: Company[]) {
  if (who.kind === 'app' && who.companies && companies.some((c) => !who.companies!.includes(c)))
    throw forbidden('This app cannot use that company');
}

export function canSee(who: Principal, companies: Company[]): boolean {
  if (who.kind === 'app' && who.companies) return companies.some((c) => who.companies!.includes(c));
  return true;
}

export interface StillFilters {
  q?: string;
  tags?: string[];
  client?: string;
  jobId?: string;
  album?: string;
  company?: string;
  people?: string;
  orientation?: string;
  camera?: string;
  colour?: string;
  from?: string;
  to?: string;
  ai?: string;
  status?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Library search. Picks the narrowest index for the first filter, then filters
 * the rest in memory. Good for tens of thousands of stills; past that, see
 * docs/DECISIONS.md (Aurora or OpenSearch).
 */
export async function searchStills(f: StillFilters, who: Principal): Promise<{ stills: Still[]; next?: string; total: number }> {
  let candidates: Still[];
  if (f.album) {
    const ids = await albumStillIds(f.album);
    candidates = await getStills(ids);
  } else if (f.jobId) {
    candidates = await queryAll<Still>({
      IndexName: 'gsi2',
      KeyConditionExpression: 'gsi2pk = :p AND begins_with(gsi2sk, :s)',
      ExpressionAttributeValues: { ':p': `JOB#${f.jobId}`, ':s': 'STILL#' },
    });
  } else if (f.client) {
    candidates = await queryAll<Still>({
      IndexName: 'gsi3',
      KeyConditionExpression: 'gsi3pk = :p AND begins_with(gsi3sk, :s)',
      ExpressionAttributeValues: { ':p': `CLIENT#${norm(f.client)}`, ':s': 'STILL#' },
    });
  } else {
    candidates = await queryAll<Still>(
      {
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :p',
        ExpressionAttributeValues: { ':p': 'STILL' },
        ScanIndexForward: false,
      },
      20000,
    );
  }

  const words = (f.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const tags = (f.tags ?? []).map((t) => t.toLowerCase());
  const status = f.status ?? 'ready';
  const matches = candidates.map((c) => clean<Still>(c as any)).filter((s) => {
    if (status !== 'any' && s.status !== status) return false;
    if (!canSee(who, s.companies)) return false;
    if (f.client && norm(s.client ?? '') !== norm(f.client)) return false;
    if (f.jobId && s.jobId !== f.jobId) return false;
    if (f.company && !s.companies.includes(f.company as Company)) return false;
    if (f.people && s.people !== f.people) return false;
    if (f.orientation && s.orientation !== f.orientation) return false;
    if (f.colour && s.colourName !== f.colour.toLowerCase()) return false;
    if (f.ai === 'true' && !s.ai) return false;
    if (f.ai === 'false' && s.ai) return false;
    if (f.camera && !`${s.exif?.camera ?? ''} ${s.exif?.lens ?? ''}`.toLowerCase().includes(f.camera.toLowerCase())) return false;
    const date = s.exif?.takenAt ?? s.uploadedAt;
    if (f.from && date < f.from) return false;
    if (f.to && date > f.to + (f.to.length === 10 ? 'T23:59:59Z' : '')) return false;
    const stillTags = (s.tags ?? []).map((t) => t.toLowerCase());
    if (tags.some((t) => !stillTags.includes(t))) return false;
    if (words.length) {
      const hay = [s.title, s.description, s.filename, s.client, s.credit, s.jobId, ...(s.tags ?? []), s.exif?.camera]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (words.some((w) => !hay.includes(w))) return false;
    }
    return true;
  });

  // Newest first (ids are time-ordered).
  matches.sort((a, b) => (a.id < b.id ? 1 : -1));
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const start = f.cursor ? Number(Buffer.from(f.cursor, 'base64url').toString()) || 0 : 0;
  const page = matches.slice(start, start + limit);
  const next = start + limit < matches.length ? Buffer.from(String(start + limit)).toString('base64url') : undefined;
  return { stills: page, next, total: matches.length };
}

export async function getStills(ids: string[]): Promise<Still[]> {
  const items = await batchGet<Record<string, any>>(ids.map((id) => ({ pk: `STILL#${id}`, sk: 'META' })));
  const byId = new Map(items.map((i) => [i.id as string, clean<Still>(i)]));
  return ids.map((id) => byId.get(id)).filter((s): s is Still => !!s);
}

export async function albumStillIds(albumId: string): Promise<string[]> {
  const rows = await queryAll<{ stillId: string }>({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `ALBUM#${albumId}`, ':s': 'STILL#' },
    ProjectionExpression: 'stillId',
  });
  return rows.map((r) => r.stillId);
}

const PEOPLE: People[] = ['none', 'crowd', 'identifiable'];

/** Editable details. Anything not listed here cannot be changed through the API. */
export function applyDetails(s: Still, body: Record<string, any>): Still {
  const out = { ...s };
  const str = (v: unknown, max = 500) => {
    if (v === null || v === undefined) return undefined;
    if (typeof v !== 'string') throw badRequest('Expected text');
    return v.trim().slice(0, max) || undefined;
  };
  if ('title' in body) out.title = str(body.title, 200);
  if ('description' in body) out.description = str(body.description, 2000);
  if ('credit' in body) out.credit = str(body.credit, 200);
  if ('client' in body) out.client = str(body.client, 200);
  if ('jobId' in body) out.jobId = str(body.jobId, 100);
  if ('tags' in body) {
    if (!Array.isArray(body.tags)) throw badRequest('tags must be a list');
    out.tags = [...new Set(body.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 100) as string[];
  }
  if ('companies' in body) {
    if (!Array.isArray(body.companies) || !body.companies.length || body.companies.some((c: string) => !COMPANIES.includes(c as Company)))
      throw badRequest(`companies must be a list from: ${COMPANIES.join(', ')}`);
    out.companies = body.companies;
  }
  if ('people' in body) {
    if (body.people !== null && !PEOPLE.includes(body.people)) throw badRequest('people must be none, crowd or identifiable');
    out.people = body.people ?? undefined;
  }
  if ('ai' in body) out.ai = body.ai === true;
  if ('rights' in body) {
    const r = body.rights ?? {};
    out.rights = { who: str(r.who), where: str(r.where), until: str(r.until, 10), notes: str(r.notes, 2000) };
    if (out.rights.until && !/^\d{4}-\d{2}-\d{2}$/.test(out.rights.until)) throw badRequest('rights.until must be YYYY-MM-DD');
  }
  if ('release' in body) {
    const r = body.release ?? { status: 'none' };
    if (!['none', 'pending', 'signed', 'not-needed'].includes(r.status)) throw badRequest('release.status is not valid');
    out.release = { status: r.status, url: str(r.url, 1000) };
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

/**
 * Saves a new version. basedOnVersion must be the version the editor started
 * from; if someone has saved since, this fails with 409 and nothing changes.
 */
export async function saveRecipe(s: Still, input: unknown, basedOnVersion: number, by: string, note?: string): Promise<Still> {
  if (!Number.isInteger(basedOnVersion)) throw badRequest('basedOnVersion is required');
  if (s.status !== 'ready') throw conflict('The still is not ready yet');
  const recipe = normalise(input);
  const version = basedOnVersion + 1;
  const at = new Date().toISOString();
  const v: Version = { stillId: s.id, version, recipe, by, at, basedOn: basedOnVersion, note };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: config.table,
              Key: { pk: `STILL#${s.id}`, sk: 'META' },
              UpdateExpression: 'SET recipe = :r, version = :v, versionAt = :at, versionBy = :by',
              ConditionExpression: 'version = :b',
              ExpressionAttributeValues: { ':r': recipe, ':v': version, ':at': at, ':by': by, ':b': basedOnVersion },
            },
          },
          {
            Put: {
              TableName: config.table,
              Item: { pk: `STILL#${s.id}`, sk: versionSk(version), type: 'version', ...v },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
      }),
    );
  } catch (e: any) {
    if (e.name === 'TransactionCanceledException') {
      throw conflict(`Someone has changed this still since version ${basedOnVersion}. Reload to see their changes.`);
    }
    throw e;
  }
  return { ...s, recipe, version, versionAt: at, versionBy: by };
}

export function versionSk(n: number): string {
  return `VER#${String(n).padStart(7, '0')}`;
}

export async function getVersion(stillId: string, version: number): Promise<Version | undefined> {
  if (version === 0) return { stillId, version: 0, recipe: { v: 1 }, by: 'original', at: '', basedOn: 0 };
  const v = await getItem<Record<string, any>>(`STILL#${stillId}`, versionSk(version));
  return v ? clean<Version>(v) : undefined;
}

export async function listVersions(stillId: string): Promise<Version[]> {
  const rows = await queryAll<Record<string, any>>({
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': `STILL#${stillId}`, ':s': 'VER#' },
    ScanIndexForward: false,
  });
  return rows.map((r) => clean<Version>(r));
}

/** The API's view of a still: no table keys, GPS hidden unless asked for, signed rendition links. */
export async function stillView(s: Still, opts: { gps?: boolean } = {}) {
  const exif = s.exif ? { ...s.exif } : undefined;
  if (exif && !opts.gps) delete exif.gps;
  const ready = s.status === 'ready';
  const renditions = ready ? await renditionUrls(s.id, s.version) : undefined;
  // The unedited picture at 2560 px: the editor's starting point.
  const base = ready ? await renditionUrl(s.id, 'l', 0) : undefined;
  return { ...s, exif, renditions, base, rightsExpired: !!(s.rights?.until && s.rights.until < new Date().toISOString().slice(0, 10)) };
}

/** Adds stills to an album (memberships and the still's albumIds). */
export async function addToAlbum(albumId: string, stillIds: string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const id of stillIds) {
    await putItem({ pk: `ALBUM#${albumId}`, sk: `STILL#${id}`, type: 'member', stillId: id, addedAt: at });
    await ddb.send(
      new UpdateCommand({
        TableName: config.table,
        Key: { pk: `STILL#${id}`, sk: 'META' },
        UpdateExpression: 'SET albumIds = list_append(if_not_exists(albumIds, :empty), :a)',
        ConditionExpression: 'attribute_exists(pk) AND NOT contains(albumIds, :id)',
        ExpressionAttributeValues: { ':empty': [], ':a': [albumId], ':id': albumId },
      }),
    ).catch((e) => {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    });
  }
}

export async function removeFromAlbum(albumId: string, stillId: string): Promise<void> {
  await batchDelete([{ pk: `ALBUM#${albumId}`, sk: `STILL#${stillId}` }]);
  // Read, then write only if nobody changed the list meanwhile (and the still still exists).
  for (let attempt = 0; attempt < 5; attempt++) {
    const s = await getStill(stillId);
    if (!s || !(s.albumIds ?? []).includes(albumId)) return;
    try {
      await setStillFields(stillId, { albumIds: s.albumIds.filter((a) => a !== albumId) }, 'attribute_exists(pk) AND albumIds = :old', {
        ':old': s.albumIds,
      });
      return;
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    }
  }
  throw conflict('The still kept changing; please try again');
}

/**
 * Deletes everything for a still: the original (every S3 version), the master,
 * every rendition, cached copies at CloudFront, its versions, album
 * memberships and the duplicate-hash record.
 */
export async function deleteStill(id: string, opts: { invalidate?: boolean } = {}): Promise<void> {
  const s = await getStill(id);
  // Records first, so a half-finished delete never leaves a "ready" still without files.
  const own = await queryAll<{ pk: string; sk: string }>({
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `STILL#${id}` },
    ProjectionExpression: 'pk, sk',
  });
  const keys = own.map(({ pk, sk }) => ({ pk, sk }));
  for (const albumId of s?.albumIds ?? []) keys.push({ pk: `ALBUM#${albumId}`, sk: `STILL#${id}` });
  if (s?.sha256) {
    const h = await getItem<{ stillId: string }>(`HASH#${s.sha256}`);
    if (h?.stillId === id) keys.push({ pk: `HASH#${s.sha256}`, sk: 'META' });
  }
  await batchDelete(keys);
  await deleteAllObjectVersions(config.originalsBucket, `o/${id}/`);
  await deleteAllObjectVersions(config.originalsBucket, `m/${id}/`);
  await deletePrefix(config.renditionsBucket, `r/${id}/`);
  if (opts.invalidate !== false) await invalidate([`/r/${id}/*`]);
}

/**
 * Clears CloudFront's cached copies. Best effort: CloudFront allows only 15
 * wildcard invalidations in progress, and signed links expire within two days anyway.
 */
export async function invalidate(paths: string[]): Promise<void> {
  if (!config.distributionId || !paths.length) return;
  try {
    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: config.distributionId,
        InvalidationBatch: { CallerReference: `${Date.now()}-${Math.random()}`, Paths: { Quantity: paths.length, Items: paths } },
      }),
    );
  } catch (e) {
    console.error('Invalidation failed (cached copies expire with their signed links)', paths, e);
  }
}

async function deleteAllObjectVersions(bucket: string, prefix: string) {
  let KeyMarker: string | undefined;
  let VersionIdMarker: string | undefined;
  do {
    const r = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }));
    const objects = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    KeyMarker = r.IsTruncated ? r.NextKeyMarker : undefined;
    VersionIdMarker = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (KeyMarker);
}

async function deletePrefix(bucket: string, prefix: string) {
  let ContinuationToken: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    const objects = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

export function norm(s: string): string {
  return s.trim().toLowerCase();
}


export type { Recipe };

/**
 * Sets (or, for undefined values, removes) just these fields on a still, so a
 * concurrent recipe, album or details change is never overwritten.
 */
export async function setStillFields(
  id: string,
  fields: Record<string, unknown>,
  condition = 'attribute_exists(pk)',
  conditionValues: Record<string, unknown> = {},
): Promise<void> {
  const set: string[] = [];
  const remove: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ...conditionValues };
  for (const [k, v] of Object.entries(fields)) {
    names[`#${k}`] = k;
    if (v === undefined) remove.push(`#${k}`);
    else {
      set.push(`#${k} = :${k}`);
      values[`:${k}`] = v;
    }
  }
  await ddb.send(
    new UpdateCommand({
      TableName: config.table,
      Key: { pk: `STILL#${id}`, sk: 'META' },
      UpdateExpression: [set.length ? `SET ${set.join(', ')}` : '', remove.length ? `REMOVE ${remove.join(', ')}` : ''].join(' ').trim(),
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: Object.keys(values).length ? values : undefined,
    }),
  );
}

const DETAIL_FIELDS = ['title', 'description', 'credit', 'client', 'jobId', 'tags', 'companies', 'people', 'ai', 'rights', 'release', 'updatedAt'] as const;

/**
 * Saves edited details with a targeted update, so it never overwrites a recipe
 * or album change made at the same time. Keeps the index keys in step.
 */
export async function updateDetails(updated: Still): Promise<void> {
  const keys = stillItem(updated);
  const fields: Record<string, unknown> = {};
  for (const f of DETAIL_FIELDS) fields[f] = (updated as any)[f];
  for (const k of ['gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk']) fields[k] = keys[k];
  await setStillFields(updated.id, fields);
}
