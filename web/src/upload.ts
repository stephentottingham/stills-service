import exifr from 'exifr';
import { api } from './api';
import { kindOf, imageType, largestEmbeddedJpeg } from './plan';

/** Files from a drop, walking into folders. Pictures and RAWs only. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files).filter((f) => kindOf(f));
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      if (kindOf(f)) out.push(f);
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches; keep reading until empty.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/**
 * Measures upload speed to the same S3 region the pictures go to: two uploads
 * at once (as the real upload does), bigger if the first round is quick.
 * Returns megabits per second, or undefined if it fails.
 */
export async function speedTest(): Promise<number | undefined> {
  try {
    let result: number | undefined;
    for (const bytes of [2_000_000, 8_000_000]) {
      const t = await api('POST', '/speedtest', { bytes });
      const body = new Uint8Array(t.bytes);
      crypto.getRandomValues(body.subarray(0, 65536)); // not all zeros, in case anything compresses
      const started = performance.now();
      await Promise.all(t.urls.map((url: string) => fetch(url, { method: 'PUT', headers: t.headers, body }).then((r) => { if (!r.ok) throw new Error(String(r.status)); })));
      const seconds = (performance.now() - started) / 1000;
      result = (t.bytes * t.urls.length * 8) / seconds / 1e6;
      if (seconds > 2.5) break; // long enough to trust
    }
    return result;
  } catch {
    return undefined;
  }
}

/**
 * A JPEG from a RAW's built-in preview (the camera's own processing), turned
 * the right way up. Undefined if there is no usable preview.
 */
export async function previewFromRaw(raw: File): Promise<File | undefined> {
  const jpeg = largestEmbeddedJpeg(new Uint8Array(await raw.arrayBuffer()));
  if (!jpeg) return undefined;
  const blob = new Blob([jpeg as BlobPart], { type: 'image/jpeg' });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'none' });
  } catch {
    return undefined;
  }
  // Too small to be useful (a thumbnail, not a preview).
  if (Math.max(bitmap.width, bitmap.height) < 1200) return undefined;
  const name = `${raw.name.replace(/\.[^.]+$/, '')}.jpg`;
  const orientation = await exifr.orientation(raw).catch(() => 1);
  if (![3, 6, 8].includes(orientation ?? 1)) return new File([blob], name, { type: 'image/jpeg' });
  // Turn it: the preview usually has no orientation of its own, the RAW does.
  const turn = orientation === 6 || orientation === 8;
  const canvas = new OffscreenCanvas(turn ? bitmap.height : bitmap.width, turn ? bitmap.width : bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(orientation === 6 ? Math.PI / 2 : orientation === 8 ? -Math.PI / 2 : Math.PI);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  const turned = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.93 });
  return new File([turned], name, { type: 'image/jpeg' });
}

export interface Item {
  file: File;
  fromRaw?: boolean;
}

/**
 * Asks the API for upload links in batches, then sends each file straight to
 * S3, four at a time. Pictures go to the library; RAWs to the inbox for the Synology.
 */
export async function uploadFiles(
  albumId: string,
  items: Item[],
  progress: (p: { done: number; total: number; failed: number; bytesDone: number; bytesTotal: number }) => void,
) {
  let done = 0;
  let failed = 0;
  let bytesDone = 0;
  const bytesTotal = items.reduce((n, i) => n + i.file.size, 0);
  const tell = () => progress({ done, total: items.length, failed, bytesDone, bytesTotal });
  tell();
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const { uploads } = await api('POST', `/albums/${albumId}/uploads`, {
      files: batch.map(({ file, fromRaw }) => ({
        name: file.name,
        type: kindOf(file) === 'raw' ? 'application/octet-stream' : imageType(file),
        size: file.size,
        fromRaw: fromRaw || undefined,
      })),
    });
    let next = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (next < batch.length) {
        const k = next++;
        const u = uploads[k];
        try {
          const r = await fetch(u.url, { method: 'PUT', headers: u.headers, body: batch[k].file });
          if (!r.ok) throw new Error(String(r.status));
        } catch {
          failed++;
        }
        done++;
        bytesDone += batch[k].file.size;
        tell();
      }
    });
    await Promise.all(workers);
  }
}

