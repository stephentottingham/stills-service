import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { autoRecipe, normalise } from '@stills/recipe';
import { Router, Event, Ctx, noContent, json } from '../lib/http';
import { principalOf } from '../lib/principal';
import { config } from '../lib/config';
import { s3, putItem, queryAll, deleteItem, clean, sendMessages } from '../lib/aws';
import { badRequest, notFound, forbidden } from '../lib/errors';
import { newId, ID_PATTERN, TOKEN_PATTERN } from '../lib/ids';
import { Still, Principal } from '../lib/model';
import { ACCEPTED_TYPES, smallPixels } from '../lib/images';
import {
  mustGetStill,
  searchStills,
  stillView,
  applyDetails,
  updateDetails,
  saveRecipe,
  listVersions,
  getVersion,
  deleteStill,
  saveStill,
  addToAlbum,
  removeFromAlbum,
  getStills,
  canSee,
  albumStillIds,
  assertCompanies,
} from '../lib/stills';
import { createAlbum, getAlbum, listAlbums, albumFields, saveAlbum } from '../lib/albums';
import { createGallery, getGallery, galleryView, activity, galleryStills, galleryItem } from '../lib/galleries';
import { requestZip, getZip, zipStillsFor } from '../lib/zips';
import { sourceOf } from '../lib/renditions';
import { signPath } from '../lib/signing';
import { emit } from '../lib/events';

const MAX_UPLOADS_PER_CALL = 500;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const who = (c: Ctx): Principal => principalOf(c.event);
const id = (c: Ctx, key = 'id'): string => {
  const v = c.params[key];
  if (!ID_PATTERN.test(v)) throw notFound();
  return v;
};

const router = new Router()
  .on('GET', '/api/me', async (c) => who(c))

  // Albums
  .on('POST', '/api/albums', async (c) => createAlbum(c.body, who(c)))
  .on('GET', '/api/albums', async (c) =>
    ({ albums: await listAlbums({ company: c.query.company, client: c.query.client, jobId: c.query.jobId }, who(c)) }),
  )
  .on('GET', '/api/albums/{id}', async (c) => {
    const a = await getAlbum(id(c), who(c));
    return { ...a, count: (await albumStillIds(a.id)).length };
  })
  .on('PATCH', '/api/albums/{id}', async (c) => {
    const a = await getAlbum(id(c), who(c));
    const updated = { ...a, ...albumFields(c.body, a), updatedAt: new Date().toISOString() };
    assertCompanies(who(c), [updated.company]);
    await saveAlbum(updated);
    return updated;
  })
  .on('POST', '/api/albums/{id}/uploads', async (c) => {
    const p = who(c);
    const album = await getAlbum(id(c), p);
    const files = c.body.files;
    if (!Array.isArray(files) || !files.length) throw badRequest('files is required: [{name, type, size}]');
    if (files.length > MAX_UPLOADS_PER_CALL) throw badRequest(`Up to ${MAX_UPLOADS_PER_CALL} files per call`);
    const now = new Date().toISOString();
    const uploads = [];
    for (const f of files) {
      const type = String(f.type ?? '').toLowerCase();
      const ext = ACCEPTED_TYPES[type];
      if (!ext) throw badRequest(`${f.name}: JPEG, PNG, HEIC and TIFF only for now`);
      if (!(f.size > 0 && f.size <= MAX_UPLOAD_BYTES)) throw badRequest(`${f.name}: too big (500 MB limit)`);
      const still: Still = {
        id: newId('st'),
        status: 'pending',
        filename: String(f.name ?? 'untitled').slice(0, 255),
        contentType: type,
        originalKey: '',
        companies: [album.company],
        client: album.client,
        jobId: album.jobId,
        albumIds: [album.id],
        recipe: { v: 1 },
        version: 0,
        uploadedBy: p.id,
        uploadedAt: now,
      };
      still.originalKey = `o/${still.id}/original.${ext}`;
      await saveStill(still);
      await putItem({ pk: `ALBUM#${album.id}`, sk: `STILL#${still.id}`, type: 'member', stillId: still.id, addedAt: now });
      const url = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: config.originalsBucket, Key: still.originalKey, ContentType: type, ContentLength: f.size }),
        { expiresIn: 3600 },
      );
      uploads.push({ stillId: still.id, name: still.filename, url, method: 'PUT', headers: { 'content-type': type } });
    }
    return { uploads };
  })
  .on('POST', '/api/albums/{id}/import', async () => json(501, { error: 'Imports from Drive, OneDrive and Frame.io come in phase 2' }))
  .on('POST', '/api/albums/{id}/stills', async (c) => {
    const p = who(c);
    const album = await getAlbum(id(c), p);
    const ids: string[] = Array.isArray(c.body.ids) ? c.body.ids.map(String) : [];
    const stills = (await getStills(ids)).filter((s) => canSee(p, s.companies));
    await addToAlbum(album.id, stills.map((s) => s.id));
    return { added: stills.map((s) => s.id) };
  })
  .on('DELETE', '/api/albums/{id}/stills/{stillId}', async (c) => {
    const album = await getAlbum(id(c), who(c));
    await removeFromAlbum(album.id, id(c, 'stillId'));
    return noContent();
  })

  // Stills
  .on('GET', '/api/stills', async (c) => {
    const q = c.query;
    const result = await searchStills(
      { ...q, tags: q.tags ? q.tags.split(',') : undefined, limit: q.limit ? Number(q.limit) : undefined },
      who(c),
    );
    return { ...result, stills: await Promise.all(result.stills.map((s) => stillView(s))) };
  })
  .on('GET', '/api/stills/{id}', async (c) => {
    const p = who(c);
    return stillView(await mustGetStill(id(c), p), { gps: c.query.gps === '1' && p.kind === 'user' });
  })
  .on('PATCH', '/api/stills/{id}', async (c) => {
    const s = await mustGetStill(id(c), who(c));
    const p = who(c);
    const updated = applyDetails(s, c.body);
    assertCompanies(p, updated.companies);
    await updateDetails(updated);
    return stillView(updated);
  })
  .on('PUT', '/api/stills/{id}/recipe', async (c) => {
    const p = who(c);
    const s = await mustGetStill(id(c), p);
    const saved = await saveRecipe(s, c.body.recipe, Number(c.body.basedOnVersion), p.id, c.body.note);
    await afterNewVersion(saved);
    return stillView(saved);
  })
  .on('POST', '/api/stills/{id}/auto', async (c) => {
    const s = await mustGetStill(id(c), who(c));
    if (s.status !== 'ready') throw badRequest('The still is not ready yet');
    const current = c.body.recipe ? normalise(c.body.recipe) : s.recipe;
    const small = await smallPixels(await sourceOf(s));
    return { recipe: autoRecipe(small, current, s.w!, s.h!), basedOnVersion: s.version };
  })
  .on('GET', '/api/stills/{id}/versions', async (c) => {
    const s = await mustGetStill(id(c), who(c));
    const versions = await listVersions(s.id);
    // Each version's thumbnail, so the history shows before and after.
    const withThumbs = await Promise.all(
      [...versions, { stillId: s.id, version: 0, recipe: { v: 1 }, by: 'original', at: s.uploadedAt, basedOn: 0 }].map(
        async (v) => ({ ...v, thumb: await signPath(`r/${s.id}/t/v${v.version}.jpg`) }),
      ),
    );
    return { current: s.version, versions: withThumbs };
  })
  .on('POST', '/api/stills/{id}/revert', async (c) => {
    // "Back to this version": a new version with the old recipe. Nothing is lost.
    const p = who(c);
    const s = await mustGetStill(id(c), p);
    const target = await getVersion(s.id, Number(c.body.version));
    if (!target) throw notFound('No such version');
    const saved = await saveRecipe(s, target.recipe, Number(c.body.basedOnVersion), p.id, `Back to version ${target.version}`);
    await afterNewVersion(saved);
    return stillView(saved);
  })
  .on('DELETE', '/api/stills/{id}', async (c) => {
    const s = await mustGetStill(id(c), who(c));
    await deleteStill(s.id);
    return noContent();
  })

  // Galleries
  .on('POST', '/api/galleries', async (c) => galleryView(await createGallery(c.body, who(c))))
  .on('GET', '/api/galleries', async (c) => {
    const p = who(c);
    const rows = c.query.jobId
      ? await queryAll<Record<string, any>>({
          IndexName: 'gsi2',
          KeyConditionExpression: 'gsi2pk = :p AND begins_with(gsi2sk, :s)',
          ExpressionAttributeValues: { ':p': `JOB#${c.query.jobId}`, ':s': 'GALLERY#' },
        })
      : await queryAll<Record<string, any>>(
          { IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': 'GALLERY' }, ScanIndexForward: false },
          500,
        );
    const galleries = rows
      .map((r) => clean<any>(r))
      .filter((g) => canSee(p, [g.company]) && (!c.query.albumId || g.albumId === c.query.albumId));
    return { galleries: galleries.map(galleryView) };
  })
  .on('GET', '/api/galleries/{token}', async (c) => galleryView(await ownGallery(c)))
  .on('POST', '/api/galleries/{token}/withdraw', async (c) => {
    const g = await ownGallery(c);
    const withdrawn = { ...g, withdrawnAt: g.withdrawnAt ?? new Date().toISOString() };
    await putItem(galleryItem(withdrawn));
    return galleryView(withdrawn);
  })
  .on('GET', '/api/galleries/{token}/activity', async (c) => {
    const g = await ownGallery(c);
    const events = await activity(g.token);
    const count = (k: string) => events.filter((e) => e.kind === k).length;
    return { views: count('view'), downloads: count('download'), zips: count('zip'), events, selects: [], comments: [] };
  })

  // Zips
  .on('POST', '/api/zips', async (c) => {
    const p = who(c);
    let ids: string[];
    let galleryToken: string | undefined;
    if (c.body.gallery) {
      const g = await getGallery(String(c.body.gallery));
      if (!canSee(p, [g.company])) throw notFound();
      ids = (await galleryStills(g)).filter((s) => canSee(p, s.companies)).map((s) => s.id);
      galleryToken = g.token;
    } else {
      ids = await zipStillsFor(Array.isArray(c.body.ids) ? c.body.ids.map(String) : [], p);
    }
    const z = await requestZip({ stillIds: ids, size: c.body.size ?? 'web', email: c.body.email, galleryToken }, p);
    return json(202, { id: z.id, status: z.status });
  })
  .on('GET', '/api/zips/{id}', async (c) => {
    const p = who(c);
    const z = await getZip(id(c));
    // People can see any zip; an app only its own.
    if (p.kind === 'app' && z.requestedBy !== p.id) throw notFound();
    return { id: z.id, status: z.status, count: z.stillIds.length, url: z.status === 'ready' ? await signPath(z.key!, { days: 7 }) : undefined };
  })

  // Saved searches (per person)
  .on('GET', '/api/searches', async (c) => {
    const p = who(c);
    const rows = await queryAll<Record<string, any>>({
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': `USER#${p.id}`, ':s': 'SEARCH#' },
    });
    return { searches: rows.map((r) => clean(r)) };
  })
  .on('POST', '/api/searches', async (c) => {
    const p = who(c);
    if (typeof c.body.name !== 'string' || typeof c.body.query !== 'object') throw badRequest('name and query are required');
    const s = { id: newId('srch'), name: c.body.name.slice(0, 100), query: c.body.query, createdAt: new Date().toISOString() };
    await putItem({ pk: `USER#${p.id}`, sk: `SEARCH#${s.id}`, type: 'search', ...s });
    return s;
  })
  .on('DELETE', '/api/searches/{id}', async (c) => {
    await deleteItem(`USER#${who(c).id}`, `SEARCH#${id(c)}`);
    return noContent();
  });

async function ownGallery(c: Ctx) {
  const token = c.params.token;
  if (!TOKEN_PATTERN.test(token)) throw notFound();
  const g = await getGallery(token);
  if (!canSee(who(c), [g.company])) throw forbidden();
  return g;
}

/** After a new version: make its t and m in the background and tell the apps. */
async function afterNewVersion(s: Still) {
  await sendMessages(config.workQueueUrl, [{ kind: 'render', stillId: s.id, version: s.version, sizes: ['t', 'm'] }]);
  await emit('still.version', { id: s.id, version: s.version, recipe: s.recipe }, s.companies);
}

export async function handler(event: Event) {
  return router.handle(event);
}
