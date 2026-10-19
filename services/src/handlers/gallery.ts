import { randomBytes } from 'node:crypto';
import { Router, Event, Ctx, html, redirect, json, readCookie } from '../lib/http';
import { HttpError, notFound, badRequest, forbidden } from '../lib/errors';
import { TOKEN_PATTERN, ID_PATTERN } from '../lib/ids';
import { Gallery } from '../lib/model';
import {
  getGallery,
  assertOpen,
  galleryStills,
  logEvent,
  activity,
  checkPassword,
  unlockCookieValue,
  checkUnlockCookie,
  cookieName,
} from '../lib/galleries';
import { deviceOf } from '../lib/device';
import { config } from '../lib/config';
import { renditionUrl, signPath } from '../lib/signing';
import { downloadSize } from '../lib/sizes';
import { requestZip, getZip } from '../lib/zips';
import { emit } from '../lib/events';
import { brandFor, galleryPage, passwordPage, noticePage } from '../gallery/page';

/**
 * Client galleries: the public pages at /g/<token>. No sign-in; the token is
 * the key, with an optional password. Unlisted and noindex throughout.
 */

const csp = (nonce: string) =>
  [
    "default-src 'none'",
    // Renditions are signed for the main address; a gallery may be opened on another of our domains.
    `img-src 'self' data: ${config.publicBase}`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

function page(status: number, body: string, nonce: string, cookies?: string[]) {
  return html(status, body, { 'content-security-policy': csp(nonce) }, cookies);
}

async function load(c: Ctx): Promise<Gallery> {
  const token = c.params.token;
  if (!TOKEN_PATTERN.test(token)) throw notFound('This gallery does not exist');
  return getGallery(token);
}

async function unlocked(c: Ctx, g: Gallery): Promise<boolean> {
  return !g.passwordHash || (await checkUnlockCookie(g.token, readCookie(c.event, cookieName(g.token))));
}

/** Gallery pages answer in HTML even for errors. */
async function guard(c: Ctx, fn: (nonce: string) => Promise<ReturnType<typeof html>>) {
  const nonce = randomBytes(16).toString('base64');
  try {
    return await fn(nonce);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    const g = await getGallery(c.params.token).catch(() => undefined);
    const brand = brandFor(g?.company ?? 'bigsmall');
    const title = e.status === 410 ? 'This gallery is closed' : 'Gallery not found';
    const msg = e.status === 410 ? `${e.message}. Please ask the person who sent it for a new link.` : 'Please check the link you were sent.';
    return page(e.status === 410 ? 410 : 404, noticePage(brand, title, msg, nonce), nonce);
  }
}

const router = new Router()
  .on('GET', '/g/{token}', (c) =>
    guard(c, async (nonce) => {
      const g = await load(c);
      assertOpen(g);
      const brand = brandFor(g.company);
      if (!(await unlocked(c, g))) return page(200, passwordPage(brand, g.title, g.token, c.query.wrong === '1', nonce), nonce);
      const stills = await galleryStills(g);
      const items = await Promise.all(
        stills.map(async (s) => ({
          id: s.id,
          title: s.title,
          w: s.w!,
          h: s.h!,
          ai: s.ai,
          // Always the current version: change a recipe and this page shows it.
          t: await renditionUrl(s.id, 't', s.version),
          m: await renditionUrl(s.id, 'm', s.version),
          // The large size only where full-size downloads are allowed anyway.
          l: g.downloads === 'full' || g.downloads === 'both' ? await renditionUrl(s.id, 'l', s.version) : await renditionUrl(s.id, 'm', s.version),
        })),
      );
      await logEvent(g.token, { kind: 'view', device: deviceOf(c.event.headers['user-agent']) });
      await emit('gallery.viewed', { token: g.token, jobId: g.jobId, albumId: g.albumId }, [g.company]).catch((e) =>
        console.error('webhook enqueue failed', e),
      );
      return page(200, galleryPage(brand, g, items, nonce), nonce);
    }),
  )
  .on('POST', '/g/{token}/unlock', async (c) => {
    const g = await load(c);
    assertOpen(g);
    if (!g.passwordHash) return redirect(`/g/${g.token}`, 303);
    const ok = typeof c.body.password === 'string' && (await checkPassword(c.body.password, g.passwordHash));
    // Back to where they were going (only within this gallery).
    const next = typeof c.body.next === 'string' && c.body.next.startsWith(`/g/${g.token}/z/`) && /^[\w/-]+$/.test(c.body.next) ? c.body.next : `/g/${g.token}`;
    if (!ok) return redirect(`/g/${g.token}?wrong=1`, 303);
    const cookie = `${cookieName(g.token)}=${await unlockCookieValue(g.token)}; Path=/g/${g.token}; Max-Age=43200; Secure; HttpOnly; SameSite=Lax`;
    return redirect(next, 303, [cookie]);
  })
  .on('GET', '/g/{token}/d/{stillId}', async (c) => {
    const g = await load(c);
    assertOpen(g);
    if (!(await unlocked(c, g))) throw forbidden('Locked');
    const stillId = c.params.stillId;
    if (!ID_PATTERN.test(stillId)) throw notFound();
    const wanted = c.query.size === 'full' ? 'full' : 'web';
    if (g.downloads === 'none' || (g.downloads !== 'both' && g.downloads !== wanted)) throw forbidden('That size is not available');
    const stills = await galleryStills(g);
    const s = stills.find((x) => x.id === stillId);
    if (!s) throw notFound();
    await logEvent(g.token, { kind: 'download', device: deviceOf(c.event.headers['user-agent']), stillId, size: wanted });
    // Always the current version.
    return redirect(await renditionUrl(s.id, downloadSize(wanted), s.version));
  })
  .on('POST', '/g/{token}/zip', async (c) => {
    const g = await load(c);
    assertOpen(g);
    if (!(await unlocked(c, g))) throw forbidden('Locked');
    const size = c.body.size === 'full' ? 'full' : 'web';
    if (g.downloads === 'none' || (g.downloads !== 'both' && g.downloads !== size)) throw badRequest('That size is not available');
    // A gallery can ask for a few zips an hour, no more.
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const recent = (await activity(g.token)).filter((e) => e.kind === 'zip' && e.at > hourAgo).length;
    if (recent >= 5) throw new HttpError(429, 'Too many zips asked for. Please try again in an hour.');
    const ids = (await galleryStills(g)).map((s) => s.id);
    const z = await requestZip({ stillIds: ids, size, email: String(c.body.email ?? ''), galleryToken: g.token }, { id: `gallery:${g.token}` });
    await logEvent(g.token, { kind: 'zip', device: deviceOf(c.event.headers['user-agent']), size });
    return json(202, { ok: true, id: z.id });
  })
  .on('GET', '/g/{token}/z/{zipId}', (c) =>
    guard(c, async (nonce) => {
      const g = await load(c);
      assertOpen(g);
      if (!(await unlocked(c, g))) {
        return page(200, passwordPage(brandFor(g.company), g.title, g.token, false, nonce, `/g/${g.token}/z/${c.params.zipId}`), nonce);
      }
      const z = await getZip(c.params.zipId);
      if (z.galleryToken !== g.token) throw notFound();
      if (z.status === 'ready' && z.key) return redirect(await signPath(z.key, { days: 1 }));
      const brand = brandFor(g.company);
      const msg = z.status === 'failed' ? 'Sorry, the zip could not be made. Please try again from the gallery.' : 'It is still being made. Please try again in a few minutes.';
      return page(200, noticePage(brand, 'Your zip', msg, nonce), nonce);
    }),
  );

export async function handler(event: Event) {
  return router.handle(event);
}
