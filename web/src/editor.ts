import { SLIDERS, SliderKey, Recipe, ASPECTS, AspectPreset, normalise, pasteSettings, outputSize } from '@stills/recipe';
import { api, ApiError } from './api';
import { $, $$, esc, toast, main, dateTime, COMPANIES } from './ui';

/**
 * The editor. The preview is drawn by the shared recipe code in a worker,
 * from a 2560 px copy of the original, so what you see is what the server makes.
 */
export async function openEditor(id: string) {
  const still = await api('GET', `/stills/${id}`);
  let saved: Recipe = still.recipe;
  let recipe: Recipe = { ...saved };
  let version: number = still.version;
  let cropping = false;
  let showBefore = false;

  const m = main(`
    <p><a href="javascript:history.back()">← Back</a></p>
    <div class="editor">
      <div>
        <div class="stage" id="stage"><canvas id="canvas"></canvas><span class="busy" id="busy">Rendering…</span></div>
        <div class="toolbar">
          <button id="auto">Auto</button>
          <button id="before" title="Hold to see the original">Before</button>
          <button id="copy">Copy settings</button>
          <button id="paste">Paste settings</button>
          <button id="reset">Reset</button>
          <span style="flex:1"></span>
          <span class="muted" id="state"></span>
          <button id="save" class="primary">Save</button>
        </div>
        <p class="muted">${esc(still.filename)} · ${still.w}×${still.h}${still.exif?.camera ? ' · ' + esc(still.exif.camera) : ''}${still.exif?.takenAt ? ' · ' + dateTime(still.exif.takenAt) : ''}
          ${still.ai ? '<span class="chip ai">AI-made</span>' : ''}
          · <a id="dlm" download>Web size</a> · <a id="dlfull" download>Full size</a></p>
      </div>
      <div class="panel card" id="panel"></div>
    </div>`);

  const canvas = $<HTMLCanvasElement>('#canvas', m);
  const ctx = canvas.getContext('2d')!;
  const stage = $('#stage', m);

  // ---------- Worker ----------
  const worker = new Worker('/render-worker.js', { type: 'module' });
  let reqId = 0;
  let inFlight = false;
  let dirty = false;
  worker.onmessage = (e) => {
    const r = e.data;
    if (r.kind !== 'rendered') return;
    canvas.width = r.width;
    canvas.height = r.height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(r.data), r.width, r.height), 0, 0);
    inFlight = false;
    $('#busy', m).style.display = 'none';
    if (cropping) drawCropBox();
    if (dirty) {
      dirty = false;
      draw();
    }
  };

  const previewEdge = () => Math.min(1600, Math.round(Math.max(stage.clientWidth, 400) * devicePixelRatio));

  /** What the stage shows: the recipe, without its crop while cropping, or nothing at all for "before". */
  const shown = (): Recipe => {
    if (showBefore) return { v: 1 };
    if (cropping) {
      const { crop, ...rest } = recipe;
      return rest as Recipe;
    }
    return recipe;
  };

  function draw() {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    $('#busy', m).style.display = 'block';
    worker.postMessage({ kind: 'render', id: ++reqId, recipe: shown(), maxEdge: previewEdge() });
    updateState();
  }

  // The unedited base (version 0) at 2560 px, loaded once.
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = still.base;
  await img.decode().catch(() => {
    throw new Error('Could not load the picture');
  });
  const off = document.createElement('canvas');
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const octx = off.getContext('2d', { willReadFrequently: true })!;
  octx.drawImage(img, 0, 0);
  const base = octx.getImageData(0, 0, off.width, off.height);
  worker.postMessage({ kind: 'base', data: base.data, width: base.width, height: base.height, srcW: still.w, srcH: still.h }, [base.data.buffer]);

  // ---------- Controls ----------
  const groups: Record<string, SliderKey[]> = {};
  for (const k of Object.keys(SLIDERS) as SliderKey[]) (groups[SLIDERS[k].group] ??= []).push(k);

  const panel = $('#panel', m);
  panel.innerHTML = `
    <details open><summary>Crop and angle</summary>
      <div class="toolbar">
        <button id="cropbtn">Crop</button>
        ${(['free', 'original', '16:9', '4:5', '1:1', '3:2'] as AspectPreset[]).map((a) => `<button data-aspect="${a}">${a === 'free' ? 'Free' : a === 'original' ? 'Original' : a}</button>`).join('')}
      </div>
      <div class="toolbar">
        <button id="rotl" title="Turn left">⟲ Turn</button><button id="rotr" title="Turn right">⟳ Turn</button>
        <button id="fliph">Flip ↔</button><button id="flipv">Flip ↕</button>
      </div>
      ${slider('straighten')}
    </details>
    ${['Light', 'Colour', 'Detail', 'Effects']
      .map((g) => `<details open><summary>${g}</summary>${groups[g].map(slider).join('')}${g === 'Detail' ? '<label class="slider"><span>Black and white</span><input type="checkbox" id="bw"></label>' : ''}</details>`)
      .join('')}
    <details><summary>History</summary><div class="history" id="history"><p class="muted">Loading…</p></div></details>
    <details><summary>Details</summary><form id="details"></form></details>`;

  function slider(k: SliderKey) {
    const s = SLIDERS[k];
    return `<label class="slider"><span>${s.label}</span><input type="range" data-k="${k}" min="${s.min}" max="${s.max}" step="${s.step}" value="0"><output data-o="${k}"></output></label>`;
  }

  function syncControls() {
    for (const input of $$<HTMLInputElement>('input[type=range]', panel)) {
      const k = input.dataset.k as SliderKey;
      const v = (recipe[k] as number | undefined) ?? 0;
      input.value = String(v);
      $(`output[data-o="${k}"]`, panel).textContent = k === 'exposure' ? v.toFixed(2) : String(v);
    }
    $<HTMLInputElement>('#bw', panel).checked = !!recipe.bw;
    $$<HTMLButtonElement>('[data-aspect]', panel).forEach((b) => (b.style.fontWeight = (recipe.crop?.aspect ?? 'free') === b.dataset.aspect ? '700' : ''));
  }

  function set(next: Recipe | Record<string, unknown>) {
    recipe = normalise(next);
    syncControls();
    draw();
  }

  panel.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.k) set({ ...recipe, [t.dataset.k]: Number(t.value) });
    else if (t.id === 'bw') set({ ...recipe, bw: t.checked });
  });
  // Double-click a slider to reset it.
  panel.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.k) set({ ...recipe, [t.dataset.k]: 0 });
  });

  const q = (n: number) => ((((recipe.rotate ?? 0) + n) % 360) + 360) % 360;
  $('#rotl', panel).onclick = () => set({ ...recipe, rotate: q(-90), crop: undefined });
  $('#rotr', panel).onclick = () => set({ ...recipe, rotate: q(90), crop: undefined });
  $('#fliph', panel).onclick = () => set({ ...recipe, flipH: !recipe.flipH });
  $('#flipv', panel).onclick = () => set({ ...recipe, flipV: !recipe.flipV });

  // ---------- Crop ----------
  /** Pixel aspect of the straightened frame (what the crop rectangle sits in). */
  const frameAspect = () => {
    const [w, h] = outputSize({ v: 1, rotate: recipe.rotate, straighten: recipe.straighten }, still.w, still.h, 1000);
    return w / h;
  };

  /** Largest centred crop with the aspect, in normalised frame units. */
  function cropFor(aspect: AspectPreset) {
    if (aspect === 'free') return { ...(recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 }), aspect };
    const target = aspect === 'original' ? still.w / still.h : ASPECTS[aspect];
    const fa = frameAspect();
    let w = 1;
    let h = fa / target;
    if (h > 1) {
      w = target / fa;
      h = 1;
    }
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h, aspect };
  }

  $$<HTMLButtonElement>('[data-aspect]', panel).forEach(
    (b) =>
      (b.onclick = () => {
        const aspect = b.dataset.aspect as AspectPreset;
        set({ ...recipe, crop: aspect === 'free' && !recipe.crop ? undefined : cropFor(aspect) });
        if (!cropping) toggleCrop();
      }),
  );

  let box: HTMLDivElement | undefined;
  function toggleCrop() {
    cropping = !cropping;
    $('#cropbtn', panel).textContent = cropping ? 'Done' : 'Crop';
    if (!cropping) {
      box?.remove();
      box = undefined;
    }
    draw();
  }
  $('#cropbtn', panel).onclick = toggleCrop;

  function drawCropBox() {
    const c = recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const rect = canvas.getBoundingClientRect();
    const srect = stage.getBoundingClientRect();
    if (!box) {
      box = document.createElement('div');
      box.className = 'crop-box';
      box.innerHTML = '<span class="h nw" data-h="nw"></span><span class="h ne" data-h="ne"></span><span class="h sw" data-h="sw"></span><span class="h se" data-h="se"></span>';
      stage.appendChild(box);
      box.addEventListener('pointerdown', startDrag);
    }
    Object.assign(box.style, {
      left: `${rect.left - srect.left + c.x * rect.width}px`,
      top: `${rect.top - srect.top + c.y * rect.height}px`,
      width: `${c.w * rect.width}px`,
      height: `${c.h * rect.height}px`,
    });
  }

  function startDrag(e: PointerEvent) {
    e.preventDefault();
    const handle = (e.target as HTMLElement).dataset.h;
    const rect = canvas.getBoundingClientRect();
    const start = { ...(recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 }) };
    const aspect = start.aspect && start.aspect !== 'free' ? (start.aspect === 'original' ? still.w / still.h : ASPECTS[start.aspect as keyof typeof ASPECTS]) : undefined;
    const fa = frameAspect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / rect.width;
      const dy = (ev.clientY - y0) / rect.height;
      let { x, y, w, h } = start;
      if (!handle) {
        x = Math.min(1 - w, Math.max(0, x + dx));
        y = Math.min(1 - h, Math.max(0, y + dy));
      } else {
        const right = handle.includes('e');
        const bottom = handle.includes('s');
        w = Math.max(0.05, right ? w + dx : w - dx);
        h = Math.max(0.05, bottom ? h + dy : h - dy);
        if (aspect) h = (w * fa) / aspect; // keep the chosen shape
        if (!right) x = start.x + start.w - w;
        if (!bottom) y = start.y + start.h - h;
        // Keep inside the frame.
        if (x < 0) { w += x; x = 0; if (aspect) h = (w * fa) / aspect; }
        if (y < 0) { h += y; y = 0; if (aspect) w = (h * aspect) / fa; }
        if (x + w > 1) { w = 1 - x; if (aspect) h = (w * fa) / aspect; }
        if (y + h > 1) { h = 1 - y; if (aspect) w = (h * aspect) / fa; }
        if (!right) x = start.x + start.w - w;
        if (!bottom) y = start.y + start.h - h;
      }
      recipe = normalise({ ...recipe, crop: { x, y, w, h, aspect: start.aspect } });
      drawCropBox();
      updateState();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- Actions ----------
  const before = $('#before', m);
  const hold = (on: boolean) => () => {
    showBefore = on;
    draw();
  };
  before.addEventListener('pointerdown', hold(true));
  before.addEventListener('pointerup', hold(false));
  before.addEventListener('pointerleave', () => showBefore && hold(false)());

  $('#auto', m).onclick = async () => {
    const r = await api('POST', `/stills/${id}/auto`, { recipe }).catch((e) => toast(e.message));
    if (r) {
      set(r.recipe);
      toast('Auto settings applied. Adjust from here, then save.');
    }
  };
  $('#reset', m).onclick = () => set({ v: 1 });
  $('#copy', m).onclick = () => {
    try {
      localStorage.setItem('stills.clipboard', JSON.stringify(recipe));
    } catch {
      /* storage blocked */
    }
    toast('Settings copied (not the crop).');
  };
  $('#paste', m).onclick = () => {
    let copied: Recipe | undefined;
    try {
      copied = JSON.parse(localStorage.getItem('stills.clipboard') ?? 'null') ?? undefined;
    } catch {
      copied = undefined;
    }
    if (!copied) return toast('Nothing copied yet.');
    set(pasteSettings(recipe, copied));
  };

  const changed = () => JSON.stringify(normalise(recipe)) !== JSON.stringify(normalise(saved));
  function updateState() {
    $('#state', m).textContent = `Version ${version}${changed() ? ' · unsaved changes' : ''}`;
    $<HTMLButtonElement>('#save', m).disabled = !changed();
  }

  $('#save', m).onclick = async () => {
    try {
      const s = await api('PUT', `/stills/${id}/recipe`, { recipe, basedOnVersion: version });
      saved = s.recipe;
      recipe = { ...saved };
      version = s.version;
      setDownloads(s.renditions);
      updateState();
      loadHistory();
      toast(`Saved as version ${version}. Galleries and downloads now show it.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast(`${e.message}`);
      else toast((e as Error).message);
    }
  };

  window.addEventListener(
    'beforeunload',
    (e) => {
      if (changed()) e.preventDefault();
    },
    { once: true },
  );

  function setDownloads(r: any) {
    const name = still.filename.replace(/\.[^.]+$/, '');
    Object.assign($<HTMLAnchorElement>('#dlm', m), { href: r.m, download: `${name}.jpg` });
    Object.assign($<HTMLAnchorElement>('#dlfull', m), { href: r.full, download: `${name}-full.jpg` });
  }
  setDownloads(still.renditions);

  // ---------- History ----------
  async function loadHistory() {
    const h = await api('GET', `/stills/${id}/versions`);
    $('#history', panel).innerHTML = `<ul>${h.versions
      .map(
        (v: any) => `<li><img src="${esc(v.thumb)}" alt="" loading="lazy"><span style="flex:1">
          <strong>${v.version === 0 ? 'Original' : `Version ${v.version}`}</strong>${v.version === h.current ? ' (current)' : ''}<br>
          <span class="muted">${esc(v.note ?? '')}${v.at ? ' ' + dateTime(v.at) : ''}${v.by && v.by !== 'original' ? ' · ' + esc(String(v.by).replace(/^\w+:/, '')) : ''}</span></span>
          ${v.version !== h.current ? `<button data-v="${v.version}">Back to this</button>` : ''}</li>`,
      )
      .join('')}</ul>`;
  }
  $('#history', panel).onclick = async (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b) return;
    try {
      const s = await api('POST', `/stills/${id}/revert`, { version: Number(b.dataset.v), basedOnVersion: version });
      saved = s.recipe;
      recipe = { ...saved };
      version = s.version;
      syncControls();
      draw();
      setDownloads(s.renditions);
      loadHistory();
      toast(`Back to version ${b.dataset.v}, saved as version ${version}.`);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  // ---------- Details ----------
  const form = $<HTMLFormElement>('#details', panel);
  form.innerHTML = `
    <label>Title</label><input name="title" value="${esc(still.title)}">
    <label>Description</label><textarea name="description">${esc(still.description)}</textarea>
    <label>Tags (comma separated)</label><input name="tags" value="${esc((still.tags ?? []).join(', '))}">
    <label>Credit (photographer)</label><input name="credit" value="${esc(still.credit)}">
    <label>Client</label><input name="client" value="${esc(still.client)}">
    <label>Engine job id</label><input name="jobId" value="${esc(still.jobId)}">
    <label>Companies</label><select name="companies" multiple size="4">${COMPANIES.map(([c, n]) => `<option value="${c}"${still.companies.includes(c) ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <label>People</label><select name="people"><option value="">Not set</option>${['none', 'crowd', 'identifiable'].map((p) => `<option${still.people === p ? ' selected' : ''}>${p}</option>`).join('')}</select>
    <label><input type="checkbox" name="ai" style="width:auto"${still.ai ? ' checked' : ''}> AI-made (always labelled; never picked automatically)</label>
    <label>Usage: who can use it</label><input name="rwho" value="${esc(still.rights?.who)}">
    <label>Usage: where</label><input name="rwhere" value="${esc(still.rights?.where)}">
    <label>Usage: until</label><input name="runtil" type="date" value="${esc(still.rights?.until)}">
    <label>Release</label><select name="release">${['none', 'pending', 'signed', 'not-needed'].map((r) => `<option${still.release?.status === r ? ' selected' : ''}>${r}</option>`).join('')}</select>
    <label>Release form link</label><input name="releaseUrl" value="${esc(still.release?.url)}">
    <div class="toolbar"><button class="primary">Save details</button><button type="button" class="danger" id="delete">Delete still</button></div>`;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      await api('PATCH', `/stills/${id}`, {
        title: f.get('title') || null,
        description: f.get('description') || null,
        tags: String(f.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean),
        credit: f.get('credit') || null,
        client: f.get('client') || null,
        jobId: f.get('jobId') || null,
        companies: f.getAll('companies'),
        people: f.get('people') || null,
        ai: f.get('ai') === 'on',
        rights: { who: f.get('rwho') || null, where: f.get('rwhere') || null, until: f.get('runtil') || null },
        release: { status: f.get('release'), url: f.get('releaseUrl') || null },
      });
      toast('Details saved.');
    } catch (err) {
      toast((err as Error).message);
    }
  };
  $('#delete', form).onclick = async () => {
    if (!confirm('Delete this still for good? The original, every version and every copy go. This cannot be undone.')) return;
    await api('DELETE', `/stills/${id}`);
    toast('Deleted.');
    history.back();
  };

  syncControls();
  draw();
  loadHistory();
  new ResizeObserver(() => cropping && drawCropBox()).observe(stage);
}
