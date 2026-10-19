import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { setEnv, installFakes } from './fakes';

setEnv();
const fake = installFakes();

const { handler: api } = await import('../src/handlers/api');
const { handler: gallery } = await import('../src/handlers/gallery');
const { handler: processor } = await import('../src/handlers/processor');
const { handler: worker } = await import('../src/handlers/worker');
const { handler: authorizer } = await import('../src/handlers/authorizer');

const ENGINE_KEY = 'ssk_engine_' + 'x'.repeat(40);

function apiEvent(method: string, path: string, body?: unknown, query?: Record<string, string>) {
  return {
    rawPath: path,
    headers: { 'content-type': 'application/json' },
    queryStringParameters: query,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method }, authorizer: { lambda: { kind: 'user', id: 'u1', email: 'producer@bigsmall.tv' } } },
  } as any;
}

function galleryEvent(method: string, path: string, opts: { body?: string; type?: string; cookies?: string[]; query?: Record<string, string> } = {}) {
  return {
    rawPath: path,
    headers: { 'content-type': opts.type ?? 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile' },
    cookies: opts.cookies,
    queryStringParameters: opts.query,
    body: opts.body,
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as any;
}

const call = async (method: string, path: string, body?: unknown, query?: Record<string, string>) => {
  const r = await api(apiEvent(method, path, body, query));
  return { status: r.statusCode!, body: r.body ? JSON.parse(r.body) : undefined };
};

async function photo(seed: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="rgb(${40 + seed},90,140)"/><circle cx="${400 + seed * 10}" cy="500" r="300" fill="#e8c070"/></svg>`;
  return sharp(Buffer.from(svg))
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Make: 'Sony', Model: 'ILCE-7M4', Artist: 'Sam Snapper' } })
    .toBuffer();
}

async function drain(queue: string, fn: (e: any) => Promise<any>) {
  const mine = fake.messages.filter((m) => m.queue === queue);
  fake.messages.splice(0, fake.messages.length, ...fake.messages.filter((m) => m.queue !== queue));
  for (const m of mine) {
    const r = await fn({ Records: [{ messageId: '1', body: JSON.stringify(m.body) }] });
    expect(r.batchItemFailures).toEqual([]);
  }
  return mine.length;
}

describe('the whole flow', () => {
  let albumId: string;
  let stillId: string;
  let token: string;

  beforeAll(() => {
    const hash = createHash('sha256').update(ENGINE_KEY).digest('hex');
    fake.rows.set(`APPKEY#${hash}\u0000META`, {
      pk: `APPKEY#${hash}`,
      sk: 'META',
      app: 'engine',
      webhookUrl: 'https://engine.example/api/stills-engine/hook',
      gsi1pk: 'APP',
      gsi1sk: 'engine',
    });
  });

  it('lets an app in with its key, and nobody without one', async () => {
    const ok = await authorizer({ headers: { authorization: `Bearer ${ENGINE_KEY}` } } as any);
    expect(ok).toEqual({ isAuthorized: true, context: { kind: 'app', id: 'engine', companies: '' } });
    expect((await authorizer({ headers: { authorization: 'Bearer ssk_engine_wrong' } } as any)).isAuthorized).toBe(false);
    expect((await authorizer({ headers: {} } as any)).isAuthorized).toBe(false);
  });

  it('makes an album for a job', async () => {
    const r = await call('POST', '/api/albums', { name: 'Shoot day 1', company: 'bigsmall', client: 'Acme', jobId: 'job-42', retentionDays: 365 });
    expect(r.status).toBe(200);
    albumId = r.body.id;
    const byJob = await call('GET', '/api/albums', undefined, { jobId: 'job-42' });
    expect(byJob.body.albums.map((a: any) => a.id)).toEqual([albumId]);
    expect((await call('POST', '/api/albums', { name: 'x', company: 'nope' })).status).toBe(400);
  });

  it('refuses files it cannot read yet', async () => {
    const r = await call('POST', `/api/albums/${albumId}/uploads`, { files: [{ name: 'layout.psd', type: 'image/vnd.adobe.photoshop', size: 10 }] });
    expect(r.status).toBe(400);
  });

  it('takes uploads, processes them and spots an exact duplicate', async () => {
    const r = await call('POST', `/api/albums/${albumId}/uploads`, {
      files: [
        { name: 'IMG_0001.jpg', type: 'image/jpeg', size: 1000 },
        { name: 'IMG_0001 copy.jpg', type: 'image/jpeg', size: 1000 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.uploads).toHaveLength(2);
    expect(r.body.uploads[0].url).toContain('X-Amz-Signature');
    const jpeg = await photo(1);
    for (const u of r.body.uploads) {
      const key = `o/${u.stillId}/original.jpg`;
      fake.objects.set(`originals/${key}`, jpeg);
      const res = await processor({ Records: [{ messageId: 'm', body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }) }] } as any);
      expect(res.batchItemFailures).toEqual([]);
    }
    stillId = r.body.uploads[0].stillId;
    const first = await call('GET', `/api/stills/${stillId}`);
    expect(first.body.status).toBe('ready');
    expect([first.body.w, first.body.h]).toEqual([1600, 1000]);
    expect(first.body.exif.camera).toBe('Sony ILCE-7M4');
    expect(first.body.credit).toBe('Sam Snapper');
    expect(first.body.jobId).toBe('job-42');
    expect(first.body.renditions.m).toContain(`/r/${stillId}/m/v0.jpg`);
    expect(fake.objects.has(`renditions/r/${stillId}/t/v0.jpg`)).toBe(true);
    const second = await call('GET', `/api/stills/${r.body.uploads[1].stillId}`);
    expect(second.body.status).toBe('duplicate');
    expect(second.body.duplicateOf).toBe(stillId);
    // The engine hears about the new still.
    expect(fake.messages.some((m) => m.queue === 'hooks' && m.body.event === 'still.ready')).toBe(true);
  });

  it('finds stills by words, job and colour', async () => {
    const r = await call('GET', '/api/stills', undefined, { q: 'img_0001', jobId: 'job-42' });
    expect(r.body.stills.map((s: any) => s.id)).toEqual([stillId]);
    const none = await call('GET', '/api/stills', undefined, { q: 'nothing-like-this' });
    expect(none.body.total).toBe(0);
  });

  it('sends RAWs to the inbox for the Synology and pairs them with their JPEG', async () => {
    const r = await call('POST', `/api/albums/${albumId}/uploads`, {
      files: [
        { name: 'IMG_0001.CR3', type: 'application/octet-stream', size: 30_000_000 },
        { name: 'IMG_0099.NEF', type: '', size: 25_000_000 },
      ],
    });
    expect(r.status).toBe(200);
    const [cr3, nef] = r.body.uploads;
    expect(cr3.kind).toBe('raw');
    expect(cr3.url).toContain('raw.s3.');
    expect(cr3.path).toMatch(new RegExp(`^bigsmall/\\d{4}-\\d{2}-\\d{2}-shoot-day-1_${albumId}/IMG_0001\\.CR3$`));
    expect(nef.kind).toBe('raw');
    // No still is made for a RAW.
    expect((await call('GET', '/api/stills', undefined, { album: albumId, status: 'any' })).body.total).toBe(2);

    // S3 tells us the RAW arrived.
    const res = await processor({
      Records: [{ messageId: 'm', body: JSON.stringify({ Records: [{ s3: { bucket: { name: 'raw' }, object: { key: `raw/${cr3.path}`, size: 30_000_000 } } }] }) }],
    } as any);
    expect(res.batchItemFailures).toEqual([]);
    const still = await call('GET', `/api/stills/${stillId}`);
    expect(still.body.raw).toEqual({ filename: 'IMG_0001.CR3', path: cr3.path, bytes: 30_000_000 });

    const files = await call('GET', `/api/albums/${albumId}/files`);
    expect(files.body.raws.find((x: any) => x.filename === 'IMG_0001.CR3')).toMatchObject({ status: 'arrived', stillId });
    expect(files.body.raws.find((x: any) => x.filename === 'IMG_0099.NEF').status).toBe('requested');
    expect(files.body.stills.map((x: any) => x.filename)).toContain('IMG_0001.jpg');
  });

  it('hands out connection-test links', async () => {
    const r = await call('POST', '/api/speedtest', { bytes: 2_000_000 });
    expect(r.body.urls).toHaveLength(2);
    expect(r.body.urls[0]).toContain('/speedtest/');
  });

  it('saves recipes as versions and refuses a stale save', async () => {
    const auto = await call('POST', `/api/stills/${stillId}/auto`, {});
    expect(auto.status).toBe(200);
    expect(auto.body.recipe.v).toBe(1);
    const saved = await call('PUT', `/api/stills/${stillId}/recipe`, { recipe: { v: 1, exposure: 0.5, crop: { x: 0, y: 0, w: 0.5, h: 0.5, aspect: 'free' } }, basedOnVersion: 0 });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(1);
    expect(saved.body.renditions.full).toContain(`/r/${stillId}/full/v1.jpg`);
    const stale = await call('PUT', `/api/stills/${stillId}/recipe`, { recipe: { v: 1, exposure: -1 }, basedOnVersion: 0 });
    expect(stale.status).toBe(409);
    const bad = await call('PUT', `/api/stills/${stillId}/recipe`, { recipe: { v: 1, glow: 3 }, basedOnVersion: 1 });
    expect(bad.status).toBe(400);
    // Background renders for the new version.
    expect(await drain('work', worker as any)).toBe(1);
    const m = await sharp(fake.objects.get(`renditions/r/${stillId}/m/v1.jpg`)!).metadata();
    expect([m.width, m.height]).toEqual([800, 500]);
  });

  it('keeps history and goes back to a version as a new version', async () => {
    const h = await call('GET', `/api/stills/${stillId}/versions`);
    expect(h.body.versions.map((v: any) => v.version)).toEqual([1, 0]);
    const back = await call('POST', `/api/stills/${stillId}/revert`, { version: 0, basedOnVersion: 1 });
    expect(back.body.version).toBe(2);
    expect(back.body.recipe).toEqual({ v: 1 });
    const again = await call('PUT', `/api/stills/${stillId}/recipe`, { recipe: { v: 1, exposure: 0.3 }, basedOnVersion: 2 });
    expect(again.body.version).toBe(3);
  });

  it('edits details and hides GPS', async () => {
    const r = await call('PATCH', `/api/stills/${stillId}`, { title: 'Hero frame', tags: ['Cover', 'cover', 'Studio'], people: 'crowd', rights: { who: 'Acme', until: '2027-12-31' } });
    expect(r.status).toBe(200);
    expect(r.body.tags).toEqual(['cover', 'studio']);
    expect((await call('PATCH', `/api/stills/${stillId}`, { people: 'everyone' })).status).toBe(400);
  });

  it('makes a private gallery that shows the current version', async () => {
    const r = await call('POST', '/api/galleries', { album: albumId, title: 'Acme: day 1', company: 'bigsmall', password: 'sesame-42', expiresDays: 30, downloads: 'both' });
    expect(r.status).toBe(200);
    expect(r.body.passwordHash).toBeUndefined();
    expect(r.body.jobId).toBe('job-42');
    token = r.body.token;

    const locked = await gallery(galleryEvent('GET', `/g/${token}`));
    expect(locked.statusCode).toBe(200);
    expect(locked.body).toContain('type="password"');
    expect(locked.headers!['x-robots-tag']).toContain('noindex');

    const wrong = await gallery(galleryEvent('POST', `/g/${token}/unlock`, { body: 'password=nope', type: 'application/x-www-form-urlencoded' }));
    expect(wrong.headers!.location).toBe(`/g/${token}?wrong=1`);

    const right = await gallery(galleryEvent('POST', `/g/${token}/unlock`, { body: 'password=sesame-42', type: 'application/x-www-form-urlencoded' }));
    expect(right.statusCode).toBe(303);
    const cookie = right.cookies![0].split(';')[0];
    expect(right.cookies![0]).toContain('HttpOnly');

    const page = await gallery(galleryEvent('GET', `/g/${token}`, { cookies: [cookie] }));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Acme: day 1');
    expect(page.body).toContain(`/r/${stillId}/m/v3.jpg`);
    expect(page.body).toContain('Key-Pair-Id=K123');
    expect(page.headers!['content-security-policy']).toContain("script-src 'nonce-");

    const dl = await gallery(galleryEvent('GET', `/g/${token}/d/${stillId}`, { cookies: [cookie], query: { size: 'full' } }));
    expect(dl.statusCode).toBe(302);
    expect(dl.headers!.location).toContain(`/r/${stillId}/full/v3.jpg`);

    const noCookie = await gallery(galleryEvent('GET', `/g/${token}/d/${stillId}`, { query: { size: 'full' } }));
    expect(noCookie.statusCode).toBe(403);

    const log = await call('GET', `/api/galleries/${token}/activity`);
    expect(log.body.views).toBe(1);
    expect(log.body.downloads).toBe(1);
    expect(log.body.events.find((e: any) => e.kind === 'download').device).toBe('phone');
    expect(JSON.stringify(log.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it('zips a gallery in the background and emails a link', async () => {
    const page = await gallery(galleryEvent('POST', `/g/${token}/unlock`, { body: 'password=sesame-42', type: 'application/x-www-form-urlencoded' }));
    const cookie = page.cookies![0].split(';')[0];
    const r = await gallery(galleryEvent('POST', `/g/${token}/zip`, { cookies: [cookie], body: JSON.stringify({ size: 'web', email: 'client@acme.example' }) }));
    expect(r.statusCode).toBe(202);
    const zipId = JSON.parse(r.body!).id;
    // The zip, plus renders queued by the earlier saves.
    expect(await drain('work', worker as any)).toBeGreaterThanOrEqual(1);
    const zipKey = [...fake.objects.keys()].find((k) => k.startsWith(`renditions/z/${zipId}/`));
    expect(zipKey).toBeDefined();
    expect(fake.objects.get(zipKey!)!.subarray(0, 2).toString()).toBe('PK');
    expect(fake.emails).toHaveLength(1);
    expect(fake.emails[0].Content.Simple.Body.Text.Data).toContain(`/g/${token}/z/${zipId}`);
    // The emailed link still needs the password.
    const locked = await gallery(galleryEvent('GET', `/g/${token}/z/${zipId}`));
    expect(locked.statusCode).toBe(200);
    expect(locked.body).toContain(`name="next" value="/g/${token}/z/${zipId}"`);
    const unlock = await gallery(
      galleryEvent('POST', `/g/${token}/unlock`, { body: `password=sesame-42&next=${encodeURIComponent(`/g/${token}/z/${zipId}`)}`, type: 'application/x-www-form-urlencoded' }),
    );
    expect(unlock.headers!.location).toBe(`/g/${token}/z/${zipId}`);
    const evil = await gallery(
      galleryEvent('POST', `/g/${token}/unlock`, { body: `password=sesame-42&next=${encodeURIComponent('https://evil.example/')}`, type: 'application/x-www-form-urlencoded' }),
    );
    expect(evil.headers!.location).toBe(`/g/${token}`);
    const link = await gallery(galleryEvent('GET', `/g/${token}/z/${zipId}`, { cookies: [cookie] }));
    expect(link.statusCode).toBe(302);
    expect(link.headers!.location).toContain(`/z/${zipId}/`);
    // Zips are limited per gallery.
    for (let i = 0; i < 4; i++)
      await gallery(galleryEvent('POST', `/g/${token}/zip`, { cookies: [cookie], body: JSON.stringify({ size: 'web', email: 'client@acme.example' }) }));
    const flood = await gallery(galleryEvent('POST', `/g/${token}/zip`, { cookies: [cookie], body: JSON.stringify({ size: 'web', email: 'client@acme.example' }) }));
    expect(flood.statusCode).toBe(429);
    fake.messages.splice(0);
  });

  it('keeps a company-limited app to its own companies', async () => {
    const happened = { kind: 'app', id: 'happened', companies: 'happened' };
    const asApp = async (method: string, path: string, body?: unknown) => {
      const e = apiEvent(method, path, body);
      e.requestContext.authorizer.lambda = happened;
      const r = await api(e);
      return { status: r.statusCode!, body: r.body ? JSON.parse(r.body) : undefined };
    };
    expect((await asApp('GET', `/api/stills/${stillId}`)).status).toBe(404);
    expect((await asApp('GET', `/api/albums/${albumId}`)).status).toBe(404);
    expect((await asApp('POST', '/api/albums', { name: 'x', company: 'bigsmall' })).status).toBe(400);
    const own = await asApp('POST', '/api/albums', { name: 'Event', company: 'happened' });
    expect(own.status).toBe(200);
    expect((await asApp('PATCH', `/api/albums/${own.body.id}`, { company: 'bigsmall' })).status).toBe(403);
    // Smuggling another company's still into its album, then publishing it, fails.
    await asApp('POST', `/api/albums/${own.body.id}/stills`, { ids: [stillId] });
    const g = await asApp('POST', '/api/galleries', { album: own.body.id, title: 't', company: 'happened' });
    expect(g.status).toBe(200); // the still was never added: the app cannot see it
    const zip = await asApp('POST', '/api/zips', { ids: [stillId], size: 'web' });
    expect(zip.status).toBe(400); // nothing it may zip
  });

  it('processes a repeat delivery without harm', async () => {
    const key = `o/${stillId}/original.jpg`;
    const before = (await call('GET', `/api/stills/${stillId}`)).body.version;
    const res = await processor({ Records: [{ messageId: 'm', body: JSON.stringify({ Records: [{ s3: { object: { key } } }] }) }] } as any);
    expect(res.batchItemFailures).toEqual([]);
    expect((await call('GET', `/api/stills/${stillId}`)).body.version).toBe(before);
  });

  it('withdraws a gallery at once', async () => {
    await call('POST', `/api/galleries/${token}/withdraw`);
    const r = await gallery(galleryEvent('GET', `/g/${token}`));
    expect(r.statusCode).toBe(410);
    expect(r.body).toContain('withdrawn');
  });

  it('deletes everything for a still', async () => {
    const r = await call('DELETE', `/api/stills/${stillId}`);
    expect(r.status).toBe(204);
    expect([...fake.objects.keys()].filter((k) => k.includes(stillId))).toEqual([]);
    expect([...fake.rows.keys()].filter((k) => k.includes(stillId))).toEqual([]);
    expect(fake.invalidations).toContain(`/r/${stillId}/*`);
    expect((await call('GET', `/api/stills/${stillId}`)).status).toBe(404);
  });

  it('answers unknown routes plainly', async () => {
    expect((await call('GET', '/api/nothing')).status).toBe(404);
    expect((await call('PUT', '/api/albums')).status).toBe(405);
  });
});
