import bigsmall from '../../../brands/bigsmall.json';
import atspeed from '../../../brands/atspeed.json';
import serpentine from '../../../brands/serpentine.json';
import happened from '../../../brands/happened.json';
import type { Company, DownloadSizes } from '../lib/model';

export interface Brand {
  id: string;
  name: string;
  logo: string;
  colours: { background: string; surface: string; text: string; muted: string; accent: string };
  fonts: { heading: string; body: string };
  fontsCss: string;
  domain: string;
  website: string;
}

const BRANDS: Record<Company, Brand> = { bigsmall, atspeed, serpentine, happened };

export function brandFor(company: Company): Brand {
  return BRANDS[company] ?? bigsmall;
}

export interface PageStill {
  id: string;
  title?: string;
  w: number;
  h: number;
  ai?: boolean;
  t: string;
  m: string;
  l: string;
}

export function esc(s: string | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shell(brand: Brand, title: string, body: string, nonce: string): string {
  const c = brand.colours;
  const fontLink = brand.fontsCss ? `<link rel="stylesheet" href="${esc(brand.fontsCss)}">` : '';
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · ${esc(brand.name)}</title>
${fontLink}
<style nonce="${nonce}">
:root{--bg:${c.background};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--heading:${brand.fonts.heading};--body:${brand.fonts.body}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 var(--body)}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 16px;max-width:1600px;margin:0 auto;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px;color:var(--text);text-decoration:none;font:600 15px var(--heading)}
.brand img{height:28px;width:auto}
h1{font:600 clamp(22px,4vw,34px)/1.2 var(--heading);margin:8px 16px 4px;max-width:1600px}
.wrap{max-width:1600px;margin:0 auto;padding:0 16px 48px}
.meta{color:var(--muted);font-size:14px;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px}
@media (max-width:520px){.grid{grid-template-columns:repeat(2,1fr);gap:4px}}
.tile{position:relative;aspect-ratio:3/2;background:var(--surface);border:0;padding:0;cursor:zoom-in;overflow:hidden;border-radius:4px}
.tile img{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.7);color:#fff;font-size:11px;padding:2px 6px;border-radius:3px}
.btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:var(--bg);border:0;border-radius:999px;padding:9px 16px;font:600 14px var(--body);cursor:pointer;text-decoration:none}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--muted)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
dialog{border:0;border-radius:8px;background:var(--surface);color:var(--text);max-width:420px;width:calc(100% - 32px)}
dialog::backdrop{background:rgba(0,0,0,.6)}
label{display:block;font-size:14px;margin:12px 0 4px}
input,select{width:100%;padding:10px;border-radius:6px;border:1px solid var(--muted);background:var(--bg);color:var(--text);font:inherit}
.viewer{position:fixed;inset:0;background:#000;display:none;z-index:10;touch-action:pan-y}
.viewer.open{display:block}
.viewer img{position:absolute;inset:0;margin:auto;max-width:100%;max-height:100%;object-fit:contain;transition:transform .2s}
.viewer .top{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:center;padding:12px 16px;gap:8px;background:linear-gradient(rgba(0,0,0,.6),transparent);color:#fff;z-index:2}
.viewer .nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.4);color:#fff;border:0;width:48px;height:64px;font-size:28px;cursor:pointer;z-index:2}
.viewer .prev{left:0}.viewer .next{right:0}
@media (hover:none){.viewer .nav{display:none}}
.viewer .count{font-size:14px;opacity:.85}
.viewer .x{background:none;border:0;color:#fff;font-size:28px;cursor:pointer;line-height:1}
.notice{max-width:560px;margin:15vh auto;padding:0 16px;text-align:center}
footer{color:var(--muted);font-size:13px;text-align:center;padding:24px 16px}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function header(brand: Brand): string {
  const mark = brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}">` : esc(brand.name);
  return `<header><span class="brand">${mark}</span></header>`;
}

export function noticePage(brand: Brand, title: string, message: string, nonce: string): string {
  return shell(brand, title, `${header(brand)}<div class="notice"><h1>${esc(title)}</h1><p class="meta">${esc(message)}</p></div>`, nonce);
}

export function passwordPage(brand: Brand, title: string, token: string, wrong: boolean, nonce: string, next?: string): string {
  return shell(
    brand,
    title,
    `${header(brand)}<div class="notice">
<h1>${esc(title)}</h1>
<p class="meta">This gallery is private. Enter the password you were sent.</p>
<form method="post" action="/g/${esc(token)}/unlock" class="bar" style="justify-content:center">
${next ? `<input type="hidden" name="next" value="${esc(next)}">` : ''}
<label for="pw" style="position:absolute;left:-9999px">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required autofocus style="max-width:260px">
<button class="btn" type="submit">Open</button>
</form>
${wrong ? '<p class="meta" role="alert">That password did not work. Please try again.</p>' : ''}
</div>`,
    nonce,
  );
}

export function galleryPage(
  brand: Brand,
  g: { token: string; title: string; downloads: DownloadSizes; expiresAt: string },
  stills: PageStill[],
  nonce: string,
): string {
  const canWeb = g.downloads === 'web' || g.downloads === 'both';
  const canFull = g.downloads === 'full' || g.downloads === 'both';
  const expires = new Date(g.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const tiles = stills
    .map(
      (s, i) => `<button class="tile" data-i="${i}" aria-label="Open ${esc(s.title || `picture ${i + 1}`)}">
<img src="${esc(s.t)}" srcset="${esc(s.t)} 480w, ${esc(s.m)} 1920w" sizes="(max-width:520px) 50vw, 240px" alt="${esc(s.title)}" loading="lazy" width="${s.w}" height="${s.h}">
${s.ai ? '<span class="badge">AI-made</span>' : ''}</button>`,
    )
    .join('\n');

  const downloadAll =
    g.downloads === 'none' || !stills.length
      ? ''
      : `<button class="btn" id="all" type="button">Download all</button>
<dialog id="zip"><form method="dialog" id="zipform">
<h2 style="margin-top:0;font:600 20px var(--heading)">Download all</h2>
<p class="meta">We will put the ${stills.length} pictures in a zip and email you a link when it is ready.</p>
${canWeb && canFull ? `<label for="zsize">Size</label><select id="zsize" name="size"><option value="web">Web size</option><option value="full">Full size</option></select>` : `<input type="hidden" name="size" value="${canFull ? 'full' : 'web'}">`}
<label for="zemail">Email</label><input id="zemail" name="email" type="email" required autocomplete="email">
<p class="bar" style="margin-top:16px"><button class="btn" type="submit">Send me the link</button><button class="btn ghost" value="cancel" formnovalidate>Cancel</button></p>
<p class="meta" id="zipmsg" role="status"></p>
</form></dialog>`;

  const data = JSON.stringify(stills.map((s) => ({ id: s.id, title: s.title ?? '', l: s.l, m: s.m, ai: !!s.ai }))).replace(/</g, '\\u003c');

  return shell(
    brand,
    g.title,
    `${header(brand)}
<h1>${esc(g.title)}</h1>
<div class="wrap">
<p class="meta">${stills.length} pictures · available until ${esc(expires)}</p>
<div class="bar" style="margin-bottom:16px">${downloadAll}</div>
<div class="grid">${tiles}</div>
</div>
<div class="viewer" id="viewer" role="dialog" aria-modal="true" aria-label="Picture viewer">
<div class="top"><span class="count" id="count"></span><span class="bar">
${canWeb ? '<a class="btn" id="dlweb" download>Web size</a>' : ''}
${canFull ? '<a class="btn" id="dlfull" download>Full size</a>' : ''}
<button class="x" id="close" aria-label="Close">×</button></span></div>
<button class="nav prev" id="prev" aria-label="Previous">‹</button>
<img id="big" alt="">
<button class="nav next" id="next" aria-label="Next">›</button>
</div>
<footer>${esc(brand.name)}</footer>
<script nonce="${nonce}">
(() => {
  const stills = ${data};
  const token = ${JSON.stringify(g.token)};
  const viewer = document.getElementById('viewer');
  const big = document.getElementById('big');
  const count = document.getElementById('count');
  const dlweb = document.getElementById('dlweb');
  const dlfull = document.getElementById('dlfull');
  let i = 0;
  let lastFocus = null;
  const name = (s) => (s.title || s.id).replace(/[^\\w.\\- ]+/g, '_') + '.jpg';
  function show(n) {
    i = (n + stills.length) % stills.length;
    const s = stills[i];
    big.src = window.innerWidth * devicePixelRatio > 1920 ? s.l : s.m;
    big.alt = s.title || '';
    count.textContent = (i + 1) + ' of ' + stills.length + (s.ai ? ' · AI-made' : '');
    if (dlweb) { dlweb.href = '/g/' + token + '/d/' + s.id + '?size=web'; dlweb.download = name(s); }
    if (dlfull) { dlfull.href = '/g/' + token + '/d/' + s.id + '?size=full'; dlfull.download = name(s); }
    // Load the neighbours so stepping through is instant.
    [i + 1, i - 1].forEach((k) => { const n = stills[(k + stills.length) % stills.length]; if (n) new Image().src = n.m; });
  }
  function open(n) { lastFocus = document.activeElement; viewer.classList.add('open'); document.body.style.overflow = 'hidden'; show(n); document.getElementById('close').focus(); }
  function close() { viewer.classList.remove('open'); document.body.style.overflow = ''; if (lastFocus) lastFocus.focus(); }
  document.querySelectorAll('.tile').forEach((t) => t.addEventListener('click', () => open(Number(t.dataset.i))));
  document.getElementById('close').addEventListener('click', close);
  document.getElementById('prev').addEventListener('click', () => show(i - 1));
  document.getElementById('next').addEventListener('click', () => show(i + 1));
  document.addEventListener('keydown', (e) => {
    if (!viewer.classList.contains('open')) return;
    if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'Escape') close();
  });
  let x0 = null, y0 = null;
  viewer.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  viewer.addEventListener('touchmove', (e) => { if (x0 !== null) big.style.transform = 'translateX(' + (e.touches[0].clientX - x0) + 'px)'; }, { passive: true });
  viewer.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    big.style.transform = '';
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(dx < 0 ? i + 1 : i - 1);
    else if (dy > 120) close();
    x0 = null;
  });
  const all = document.getElementById('all');
  const zip = document.getElementById('zip');
  if (all && zip) {
    all.addEventListener('click', () => zip.showModal());
    document.getElementById('zipform').addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      const f = new FormData(e.target);
      const msg = document.getElementById('zipmsg');
      msg.textContent = 'Sending…';
      const r = await fetch('/g/' + token + '/zip', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: f.get('size'), email: f.get('email') }) });
      const j = await r.json().catch(() => ({}));
      msg.textContent = r.ok ? 'Thank you. We will email you a link when the zip is ready, usually within a few minutes.' : (j.error || 'Sorry, that did not work. Please try again.');
    });
  }
})();
</script>`,
    nonce,
  );
}
