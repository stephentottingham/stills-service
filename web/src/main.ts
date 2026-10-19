import { api, loadConfig, completeSignIn, isSignedIn, signIn, signInReady, signOut, ApiError } from './api';
import { $, $$, esc, toast, main, companyOptions, companyName, formData, date, dateTime } from './ui';
import { uploadFiles, filesFromDrop } from './upload';
import { openEditor } from './editor';

let current = 0; // guards against a slow screen drawing over a newer one

async function route() {
  const token = ++current;
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/');
  try {
    if (view === 'album' && id) await albumScreen(id, token);
    else if (view === 'library') await libraryScreen(token);
    else if (view === 'still' && id) await openEditor(id);
    else await albumsScreen(token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    main(`<p class="muted">${esc((e as Error).message)}</p>`);
  }
}

// ---------- Albums ----------
async function albumsScreen(token: number) {
  const { albums } = await api('GET', '/albums');
  if (token !== current) return;
  const m = main(`
    <h1>Albums</h1>
    <details class="card"><summary>New album</summary>
      <form id="new" class="row">
        <div><label>Name</label><input name="name" required></div>
        <div><label>Company</label><select name="company">${companyOptions('bigsmall')}</select></div>
        <div><label>Client</label><input name="client"></div>
        <div><label>Engine job id</label><input name="jobId"></div>
        <div><label>Keep for (days, blank for always)</label><input name="retentionDays" type="number" min="1"></div>
        <button class="primary">Create</button>
      </form>
    </details>
    <div class="row" style="margin:12px 0"><input id="filter" placeholder="Filter by name, client or job"></div>
    <div class="list" id="albums"></div>`);
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    $('#albums', m).innerHTML =
      albums
        .filter((a: any) => !ql || `${a.name} ${a.client ?? ''} ${a.jobId ?? ''}`.toLowerCase().includes(ql))
        .map(
          (a: any) => `<a class="card" href="#/album/${esc(a.id)}"><strong>${esc(a.name)}</strong><br>
          <span class="muted">${esc(companyName(a.company))}${a.client ? ' · ' + esc(a.client) : ''}${a.jobId ? ' · job ' + esc(a.jobId) : ''}</span><br>
          <span class="muted">${date(a.createdAt)}${a.retentionDays ? ` · kept ${a.retentionDays} days` : ''}</span></a>`,
        )
        .join('') || '<p class="muted">No albums yet.</p>';
  };
  draw();
  $<HTMLInputElement>('#filter', m).oninput = (e) => draw((e.target as HTMLInputElement).value);
  $<HTMLFormElement>('#new', m).onsubmit = async (e) => {
    e.preventDefault();
    const f = formData(e.target as HTMLFormElement);
    const a = await api('POST', '/albums', {
      name: f.name,
      company: f.company,
      client: f.client || undefined,
      jobId: f.jobId || undefined,
      retentionDays: f.retentionDays ? Number(f.retentionDays) : undefined,
    }).catch((err) => toast(err.message));
    if (a) location.hash = `#/album/${a.id}`;
  };
}

// ---------- One album ----------
async function albumScreen(id: string, token: number) {
  const [album, { stills }, { galleries }] = await Promise.all([
    api('GET', `/albums/${id}`),
    api('GET', `/stills?album=${encodeURIComponent(id)}&status=any&limit=500`),
    api('GET', `/galleries?albumId=${encodeURIComponent(id)}`),
  ]);
  if (token !== current) return;
  const selected = new Set<string>();
  const m = main(`
    <p><a href="#/">← Albums</a></p>
    <h1>${esc(album.name)}</h1>
    <p class="muted">${esc(companyName(album.company))}${album.client ? ' · ' + esc(album.client) : ''}${album.jobId ? ' · job ' + esc(album.jobId) : ''} · ${album.count} stills${album.retentionDays ? ` · kept ${album.retentionDays} days` : ''}</p>
    <div class="drop" id="drop">Drop pictures or folders here, or <label style="display:inline;color:var(--accent);cursor:pointer">choose files<input type="file" id="pick" multiple accept="image/jpeg,image/png,image/heic,image/heif,image/tiff,.heic,.heif,.tif,.tiff" hidden></label>
      <div class="progress" hidden><div></div></div><div id="upmsg" class="muted"></div></div>
    <div class="toolbar">
      <button id="gallery" class="primary">Make a client gallery</button>
      <button id="selectAll">Select all</button>
      <button id="clear">Clear selection</button>
      <span class="muted" id="selcount"></span>
    </div>
    <div class="grid" id="grid"></div>
    <h2>Client galleries</h2>
    <div id="galleries"></div>
    <dialog id="gdialog"></dialog>`);

  const drawGrid = (list: any[]) => {
    $('#grid', m).innerHTML =
      list
        .map((s) => {
          const img = s.renditions ? `<img src="${esc(s.renditions.t)}" alt="${esc(s.title ?? s.filename)}" loading="lazy">` : '';
          const status = s.status !== 'ready' ? `<span class="status">${esc(s.status === 'duplicate' ? 'duplicate (kept the first copy)' : s.status)}</span>` : '';
          const flags = [s.ai ? 'AI' : '', s.version ? `v${s.version}` : ''].filter(Boolean).join(' · ');
          return `<div class="tile${selected.has(s.id) ? ' selected' : ''}" data-id="${esc(s.id)}">
            ${img}${status}${flags ? `<span class="flag">${esc(flags)}</span>` : ''}
            ${s.status === 'ready' ? `<input type="checkbox" aria-label="Select" ${selected.has(s.id) ? 'checked' : ''}>` : ''}</div>`;
        })
        .join('') || '<p class="muted">No stills yet. Drop some above.</p>';
    $('#selcount', m).textContent = selected.size ? `${selected.size} selected` : '';
  };
  let list = stills;
  drawGrid(list);

  $('#grid', m).onclick = (e) => {
    const tile = (e.target as HTMLElement).closest('.tile') as HTMLElement | null;
    if (!tile) return;
    const sid = tile.dataset.id!;
    if ((e.target as HTMLElement).matches('input[type=checkbox]')) {
      if (selected.has(sid)) selected.delete(sid);
      else selected.add(sid);
      drawGrid(list);
      return;
    }
    const s = list.find((x: any) => x.id === sid);
    if (s?.status === 'ready') location.hash = `#/still/${sid}`;
  };
  $('#selectAll', m).onclick = () => {
    list.filter((s: any) => s.status === 'ready').forEach((s: any) => selected.add(s.id));
    drawGrid(list);
  };
  $('#clear', m).onclick = () => {
    selected.clear();
    drawGrid(list);
  };

  // Refresh while pictures are still being processed.
  const refresh = async () => {
    if (token !== current) return;
    const r = await api('GET', `/stills?album=${encodeURIComponent(id)}&status=any&limit=500`);
    list = r.stills;
    drawGrid(list);
    if (list.some((s: any) => s.status === 'pending')) setTimeout(refresh, 3000);
  };
  if (list.some((s: any) => s.status === 'pending')) setTimeout(refresh, 3000);

  // Uploads
  const drop = $('#drop', m);
  const bar = $('.progress', m);
  const start = async (files: File[]) => {
    if (!files.length) return toast('No pictures found there (JPEG, PNG, HEIC or TIFF).');
    bar.hidden = false;
    await uploadFiles(id, files, (done, total, failed) => {
      ($('div', bar) as HTMLElement).style.width = `${(100 * done) / total}%`;
      $('#upmsg', m).textContent = `${done} of ${total} uploaded${failed ? `, ${failed} failed` : ''}`;
    });
    setTimeout(refresh, 1500);
  };
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('over');
  };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    start(await filesFromDrop(e.dataTransfer!));
  };
  $<HTMLInputElement>('#pick', m).onchange = (e) => start(Array.from((e.target as HTMLInputElement).files ?? []));

  // Galleries
  const drawGalleries = (gs: any[]) => {
    $('#galleries', m).innerHTML = gs.length
      ? `<table><tr><th>Title</th><th>Made</th><th>Until</th><th>Downloads</th><th></th></tr>${gs
          .map(
            (g) => `<tr><td><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.title)}</a>${g.hasPassword ? ' 🔒' : ''}</td>
            <td>${date(g.createdAt)}</td><td>${g.withdrawnAt ? 'Withdrawn' : date(g.expiresAt)}</td><td>${esc(g.downloads)}</td>
            <td><button data-act="log" data-t="${esc(g.token)}">Activity</button> <button data-act="copy" data-u="${esc(g.url)}">Copy link</button>
            ${g.withdrawnAt ? '' : `<button class="danger" data-act="withdraw" data-t="${esc(g.token)}">Withdraw</button>`}</td></tr>`,
          )
          .join('')}</table>`
      : '<p class="muted">None yet.</p>';
  };
  drawGalleries(galleries);
  $('#galleries', m).onclick = async (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    if (b.dataset.act === 'copy') {
      await navigator.clipboard.writeText(b.dataset.u!);
      toast('Link copied. Send the password separately.');
    } else if (b.dataset.act === 'withdraw') {
      if (!confirm('Withdraw this gallery? The link stops working straight away.')) return;
      await api('POST', `/galleries/${b.dataset.t}/withdraw`);
      drawGalleries((await api('GET', `/galleries?albumId=${encodeURIComponent(id)}`)).galleries);
    } else if (b.dataset.act === 'log') {
      const a = await api('GET', `/galleries/${b.dataset.t}/activity`);
      const d = $<HTMLDialogElement>('#gdialog', m);
      d.innerHTML = `<h2>Activity</h2><p>${a.views} views · ${a.downloads} downloads · ${a.zips} zips</p>
        <table>${a.events.slice(0, 200).map((ev: any) => `<tr><td>${dateTime(ev.at)}</td><td>${esc(ev.kind)}${ev.size ? ' (' + esc(ev.size) + ')' : ''}</td><td>${esc(ev.device)}</td></tr>`).join('')}</table>
        <p><button onclick="this.closest('dialog').close()">Close</button></p>`;
      d.showModal();
    }
  };

  $('#gallery', m).onclick = () => {
    const d = $<HTMLDialogElement>('#gdialog', m);
    const ids = [...selected];
    d.innerHTML = `<form id="gform">
      <h2>Client gallery</h2>
      <p class="muted">${ids.length ? `${ids.length} selected stills` : 'The whole album, including stills added later'}. Galleries always show the latest version of each still.</p>
      <label>Title</label><input name="title" required value="${esc(album.name)}">
      <label>Brand</label><select name="company">${companyOptions(album.company)}</select>
      <label>Password (optional; send it separately from the link)</label><input name="password" type="text" minlength="6" autocomplete="off">
      <label>Expires after</label><select name="expiresDays"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">365 days</option></select>
      <label>Downloads</label><select name="downloads"><option value="both">Web and full size</option><option value="web">Web size only</option><option value="full">Full size only</option><option value="none">No downloads</option></select>
      <div class="toolbar"><button class="primary">Make gallery</button><button type="button" onclick="this.closest('dialog').close()">Cancel</button></div>
    </form>`;
    d.showModal();
    $<HTMLFormElement>('#gform', d).onsubmit = async (e) => {
      e.preventDefault();
      const f = formData(e.target as HTMLFormElement);
      try {
        const g = await api('POST', '/galleries', {
          ...(ids.length ? { ids } : { album: id }),
          title: f.title,
          company: f.company,
          password: f.password || undefined,
          expiresDays: Number(f.expiresDays),
          downloads: f.downloads,
          jobId: album.jobId,
          client: album.client,
        });
        d.innerHTML = `<h2>Gallery ready</h2><p><input readonly value="${esc(g.url)}" onclick="this.select()"></p>
          <p class="muted">${f.password ? 'Send the password in a separate message from the link.' : 'Anyone with the link can open it until it expires.'}</p>
          <p><button onclick="this.closest('dialog').close()">Done</button></p>`;
        drawGalleries((await api('GET', `/galleries?albumId=${encodeURIComponent(id)}`)).galleries);
      } catch (err) {
        toast((err as Error).message);
      }
    };
  };
}

// ---------- Library search ----------
async function libraryScreen(token: number) {
  const { searches } = await api('GET', '/searches').catch(() => ({ searches: [] }));
  if (token !== current) return;
  const m = main(`
    <h1>Library</h1>
    <form id="search" class="card">
      <div class="row">
        <div style="flex:3 1 300px"><label>Words</label><input name="q" placeholder="title, description, tags, file name"></div>
        <div><label>Tags (comma separated)</label><input name="tags"></div>
        <div><label>Company</label><select name="company"><option value="">Any</option>${companyOptions('')}</select></div>
        <div><label>Client</label><input name="client"></div>
        <div><label>Engine job</label><input name="jobId"></div>
      </div>
      <div class="row">
        <div><label>People</label><select name="people"><option value="">Any</option><option value="none">None</option><option value="crowd">Crowd</option><option value="identifiable">Identifiable</option></select></div>
        <div><label>Orientation</label><select name="orientation"><option value="">Any</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option><option value="square">Square</option></select></div>
        <div><label>Colour</label><select name="colour"><option value="">Any</option>${['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'brown', 'black', 'grey', 'white'].map((c) => `<option>${c}</option>`).join('')}</select></div>
        <div><label>Camera or lens</label><input name="camera"></div>
        <div><label>From</label><input name="from" type="date"></div>
        <div><label>To</label><input name="to" type="date"></div>
        <div><label>AI-made</label><select name="ai"><option value="">Either</option><option value="false">Not AI</option><option value="true">AI only</option></select></div>
        <button class="primary">Search</button><button type="button" id="save">Save search</button>
      </div>
      <div id="saved" class="toolbar"></div>
    </form>
    <p class="muted" id="count"></p>
    <div class="grid" id="results"></div>`);
  const drawSaved = (list: any[]) => {
    $('#saved', m).innerHTML = list.map((s) => `<button type="button" data-q='${esc(JSON.stringify(s.query))}'>${esc(s.name)}</button>`).join('');
  };
  drawSaved(searches);
  const form = $<HTMLFormElement>('#search', m);
  const run = async () => {
    const f = formData(form);
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
    const r = await api('GET', `/stills?${q}&limit=300`);
    $('#count', m).textContent = `${r.total} stills${r.total > r.stills.length ? `, showing ${r.stills.length}` : ''}`;
    $('#results', m).innerHTML = r.stills
      .map(
        (s: any) => `<a class="tile" href="#/still/${esc(s.id)}" title="${esc(s.title ?? s.filename)}"><img src="${esc(s.renditions?.t)}" alt="${esc(s.title ?? s.filename)}" loading="lazy">${s.ai ? '<span class="flag">AI</span>' : ''}</a>`,
      )
      .join('');
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    run().catch((err) => toast(err.message));
  };
  $('#save', m).onclick = async () => {
    const name = prompt('Name this search');
    if (!name) return;
    await api('POST', '/searches', { name, query: Object.fromEntries(Object.entries(formData(form)).filter(([, v]) => v)) });
    drawSaved((await api('GET', '/searches')).searches);
  };
  $('#saved', m).onclick = (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    const q = JSON.parse(b.dataset.q!);
    $$<HTMLInputElement>('input, select', form).forEach((el) => (el.value = q[el.name] ?? ''));
    run().catch((err) => toast(err.message));
  };
  run().catch((err) => toast(err.message));
}

// ---------- Start ----------
async function start() {
  await loadConfig();
  await completeSignIn().catch((e) => toast(e.message));
  if (!(await isSignedIn())) {
    main(
      signInReady()
        ? '<div class="card"><h1>Stills</h1><p>Sign in with your work account.</p><button class="primary" id="signin">Sign in</button></div>'
        : '<div class="card"><h1>Stills</h1><p>Sign-in is not set up yet. See docs/SETUP.md (Cognito app client and hosted sign-in domain).</p></div>',
    );
    $('#signin')?.addEventListener('click', () => signIn());
    return;
  }
  const me = await api('GET', '/me').catch(() => undefined);
  $('#who').innerHTML = me ? `${esc(me.email ?? me.name ?? '')} · <a href="#" id="out">Sign out</a>` : '';
  $('#out')?.addEventListener('click', (e) => {
    e.preventDefault();
    signOut();
  });
  window.addEventListener('hashchange', route);
  route();
}

start();
