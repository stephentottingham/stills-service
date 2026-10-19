import { api } from './api';
import { $, toast } from './ui';
import { sortFiles, makePlan, duration, size, total, Sorted, PREVIEW_SHARE } from './plan';
import { speedTest, previewFromRaw, uploadFiles, Item } from './upload';

/**
 * Before a big upload: test the connection, estimate the time, and suggest
 * what to send now. JPEGs always go first, so the library fills quickly.
 */
export async function planAndUpload(albumId: string, files: File[], root: HTMLElement, onProgressDone: () => void) {
  const there = await api('GET', `/albums/${albumId}/files`);
  const sorted = sortFiles(files, there);
  if (!sorted.images.length && !sorted.raws.length) {
    return toast(sorted.skipped ? `All ${sorted.skipped} files are already uploaded.` : 'No pictures or RAWs found there.');
  }

  // Small jobs on a fair connection need no questions.
  if (!sorted.raws.length && makePlan(sorted, 20, true).allSeconds <= 120) return run(albumId, sorted, true, true, root, onProgressDone);

  const dialog = $<HTMLDialogElement>('#updialog', root);
  const count = sorted.images.length + sorted.raws.length;
  dialog.innerHTML = `<h2>Upload ${count} files (${size(total([...sorted.images, ...sorted.raws]))})</h2>
    <p class="muted">${[
      sorted.images.length ? `${sorted.images.length} picture${sorted.images.length === 1 ? '' : 's'} (${size(total(sorted.images))})` : '',
      sorted.raws.length ? `${sorted.raws.length} RAW${sorted.raws.length === 1 ? '' : 's'} (${size(total(sorted.raws))}), kept on the office server` : '',
      sorted.skipped ? `${sorted.skipped} already uploaded, skipped` : '',
    ].filter(Boolean).join(' · ')}</p>
    <p id="speed">Checking your connection…</p>
    ${sorted.rawsWithoutJpeg.length ? `<label style="color:var(--text)"><input type="checkbox" id="previews" checked style="width:auto"> Make JPEGs from the ${sorted.rawsWithoutJpeg.length === 1 ? 'RAW that has' : `${sorted.rawsWithoutJpeg.length} RAWs that have`} none (the camera's built-in preview)</label>` : ''}
    <p id="advice"></p>
    <div class="toolbar" id="choices"></div>`;
  dialog.showModal();

  const mbps = await speedTest();

  const draw = () => {
    const previews = !!$<HTMLInputElement>('#previews', dialog)?.checked;
    const plan = makePlan(sorted, mbps, previews);
    $('#speed', dialog).textContent = mbps === undefined ? 'Could not test the connection.' : `Your connection: about ${mbps < 10 ? mbps.toFixed(1) : Math.round(mbps)} Mbit/s up.`;
    $('#advice', dialog).textContent = plan.message;
    const raws = sorted.raws.length > 0;
    const allFirst = plan.advice === 'go' || plan.advice === 'coffee' || !raws;
    $('#choices', dialog).innerHTML = [
      `<button data-go="all" class="${allFirst ? 'primary' : ''}">${raws ? 'Upload everything' : 'Upload'} · about ${duration(plan.allSeconds)}</button>`,
      raws ? `<button data-go="jpeg" class="${allFirst ? '' : 'primary'}">JPEGs now, RAWs later · about ${duration(plan.jpegSeconds)}</button>` : '',
      `<button data-go="cancel">Cancel</button>`,
    ].join('');
  };
  draw();
  $<HTMLInputElement>('#previews', dialog)?.addEventListener('change', draw);
  const choice = await new Promise<string>((resolve) => {
    $('#choices', dialog).onclick = (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (b) resolve(b.dataset.go!);
    };
    dialog.addEventListener('cancel', () => resolve('cancel'), { once: true });
  });
  const previews = !!$<HTMLInputElement>('#previews', dialog)?.checked;
  dialog.close();
  if (choice === 'cancel') return;
  await run(albumId, sorted, choice === 'all', previews, root, onProgressDone);
  if (choice === 'jpeg') {
    toast('JPEGs sent. For the RAWs, drop the same folder here again from a faster connection: anything already sent is skipped.');
  }
}

async function run(albumId: string, sorted: Sorted<File>, withRaws: boolean, previews: boolean, root: HTMLElement, done: () => void) {
  const bar = $('.progress', root);
  const msg = $('#upmsg', root);
  bar.hidden = false;
  const fill = $('div', bar) as HTMLElement;

  const previewCount = previews ? sorted.rawsWithoutJpeg.length : 0;
  const totalFiles = sorted.images.length + previewCount + (withRaws ? sorted.raws.length : 0);
  let filesDone = 0;
  let failed = 0;
  let bytesDone = 0;
  const estBytes = total(sorted.images) + total(sorted.rawsWithoutJpeg) * (previews ? PREVIEW_SHARE : 0) + (withRaws ? total(sorted.raws) : 0);
  const started = performance.now();
  const show = (extra = '') => {
    const secs = (performance.now() - started) / 1000;
    const rate = bytesDone / Math.max(secs, 1);
    const left = rate > 0 ? Math.max(0, estBytes - bytesDone) / rate : undefined;
    fill.style.width = `${(100 * filesDone) / Math.max(totalFiles, 1)}%`;
    msg.textContent = `${filesDone} of ${totalFiles} sent${failed ? `, ${failed} failed` : ''} · ${size(bytesDone)} of about ${size(estBytes)}${left !== undefined && filesDone && filesDone < totalFiles ? ` · about ${duration(left)} left` : ''}${extra}`;
  };

  const send = async (items: Item[]) => {
    let lastDone = 0;
    let lastBytes = 0;
    let lastFailed = 0;
    await uploadFiles(albumId, items, (p) => {
      filesDone += p.done - lastDone;
      bytesDone += p.bytesDone - lastBytes;
      failed += p.failed - lastFailed;
      lastFailed = p.failed;
      lastDone = p.done;
      lastBytes = p.bytesDone;
      show();
    });
  };

  try {
    // 1. Pictures.
    if (sorted.images.length) await send(sorted.images.map((file) => ({ file })));
    // 2. JPEGs from RAW previews, ten at a time to keep memory down.
    for (let i = 0; i < previewCount; i += 10) {
      show(' · making JPEGs from RAW previews');
      const made: Item[] = [];
      for (const raw of sorted.rawsWithoutJpeg.slice(i, i + 10)) {
        const jpeg = await previewFromRaw(raw).catch(() => undefined);
        if (jpeg) made.push({ file: jpeg, fromRaw: true });
        else filesDone++; // nothing usable inside this RAW
      }
      if (made.length) await send(made);
    }
    // 3. RAWs, last.
    if (withRaws && sorted.raws.length) await send(sorted.raws.map((file) => ({ file })));
    show(' · done');
  } catch (e) {
    toast(`Upload stopped: ${(e as Error).message}. Drop the folder again to carry on; anything already sent is skipped.`);
  }
  done();
}
