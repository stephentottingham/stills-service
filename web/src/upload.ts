import { api } from './api';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

/** The file's type, from the browser or (HEIC often has none) its extension. */
export function typeOf(f: File): string | undefined {
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  const t = f.type && Object.values(TYPES).includes(f.type) ? f.type : TYPES[ext];
  return t;
}

/** Files from a drop, walking into folders. */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files).filter(typeOf);
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      if (typeOf(f) && !f.name.startsWith('.')) out.push(f);
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
 * Asks the API for upload links in batches, then sends each file straight to
 * S3, four at a time. The service processes each one as it arrives.
 */
export async function uploadFiles(albumId: string, files: File[], progress: (done: number, total: number, failed: number) => void) {
  let done = 0;
  let failed = 0;
  progress(0, files.length, 0);
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50);
    const { uploads } = await api('POST', `/albums/${albumId}/uploads`, {
      files: batch.map((f) => ({ name: f.name, type: typeOf(f), size: f.size })),
    });
    let next = 0;
    const workers = Array.from({ length: 4 }, async () => {
      while (next < batch.length) {
        const k = next++;
        const u = uploads[k];
        try {
          const r = await fetch(u.url, { method: 'PUT', headers: u.headers, body: batch[k] });
          if (!r.ok) throw new Error(String(r.status));
        } catch {
          failed++;
        }
        done++;
        progress(done, files.length, failed);
      }
    });
    await Promise.all(workers);
  }
}
