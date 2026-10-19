/**
 * Upload planning: sort the files, estimate the time on this connection, and
 * suggest what to send now. Pure functions, so they are tested on their own.
 */

export const RAW_EXTENSIONS = [
  'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'dng',
  'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'mos', 'mef', 'erf', 'kdc', 'dcr',
];

const IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

export const extOf = (name: string) => (name.split('.').pop() ?? '').toLowerCase();
export const baseOf = (name: string) => name.replace(/\.[^.]+$/, '').toLowerCase();

export type Kind = 'image' | 'raw';

export interface FileLike {
  name: string;
  size: number;
  type?: string;
}

export function kindOf(f: FileLike): Kind | undefined {
  if (f.name.startsWith('.')) return undefined;
  const ext = extOf(f.name);
  if (RAW_EXTENSIONS.includes(ext)) return 'raw';
  if (IMAGE_TYPES[ext] || (f.type && Object.values(IMAGE_TYPES).includes(f.type))) return 'image';
  return undefined;
}

/** The type the API expects for a picture (browsers often leave HEIC blank). */
export function imageType(f: FileLike): string | undefined {
  return f.type && Object.values(IMAGE_TYPES).includes(f.type) ? f.type : IMAGE_TYPES[extOf(f.name)];
}

export interface AlreadyThere {
  stills: { filename: string; bytes?: number; status: string }[];
  raws: { filename: string; status: string }[];
}

export interface Sorted<F extends FileLike> {
  images: F[];
  raws: F[];
  /** RAWs with no JPEG beside them, here or already uploaded. */
  rawsWithoutJpeg: F[];
  skipped: number;
}

/** Splits a drop into pictures and RAWs, leaving out anything already uploaded. */
export function sortFiles<F extends FileLike>(files: F[], there: AlreadyThere): Sorted<F> {
  const haveStill = new Set(there.stills.map((s) => `${s.filename.toLowerCase()}|${s.bytes ?? ''}`));
  const haveStillBase = new Set(there.stills.map((s) => baseOf(s.filename)));
  const haveRaw = new Set(there.raws.filter((r) => r.status === 'arrived').map((r) => r.filename.toLowerCase()));
  let skipped = 0;
  const images: F[] = [];
  const raws: F[] = [];
  for (const f of files) {
    const kind = kindOf(f);
    if (!kind) continue;
    if (kind === 'image' && haveStill.has(`${f.name.toLowerCase()}|${f.size}`)) {
      skipped++;
      continue;
    }
    if (kind === 'raw' && haveRaw.has(f.name.toLowerCase())) {
      skipped++;
      continue;
    }
    (kind === 'raw' ? raws : images).push(f);
  }
  const imageBases = new Set([...images.map((f) => baseOf(f.name)), ...haveStillBase]);
  const rawsWithoutJpeg = raws.filter((r) => !imageBases.has(baseOf(r.name)));
  return { images, raws, rawsWithoutJpeg, skipped };
}

export const total = (files: FileLike[]) => files.reduce((n, f) => n + f.size, 0);

/**
 * Seconds to upload, on a measured speed (megabits per second). Allows for
 * protocol overhead and a little time per file; uploads run four at a time.
 */
export function uploadSeconds(bytes: number, files: number, mbps: number): number {
  if (!files) return 0;
  const transfer = ((bytes * 8) / (Math.max(mbps, 0.05) * 1e6)) * 1.15;
  const perFile = (files * 0.3) / 4 + Math.ceil(files / 50) * 0.5;
  return transfer + perFile;
}

/** A RAW preview JPEG is roughly this share of the RAW's size. */
export const PREVIEW_SHARE = 0.12;

export type Advice = 'go' | 'coffee' | 'split' | 'slow';

export interface Plan {
  mbps?: number;
  allSeconds: number;
  jpegSeconds: number;
  advice: Advice;
  message: string;
}

/**
 * What to tell the photographer.
 *  - quick: go ahead;
 *  - up to 45 minutes: go ahead, get a coffee;
 *  - longer, but the JPEGs alone are quick enough: JPEGs now, RAWs from a better connection;
 *  - even the JPEGs are slow: say so.
 */
export function makePlan(sorted: Sorted<FileLike>, mbps: number | undefined, makePreviews: boolean): Plan {
  const previews = makePreviews ? sorted.rawsWithoutJpeg.length : 0;
  const jpegBytes = total(sorted.images) + total(sorted.rawsWithoutJpeg) * PREVIEW_SHARE * (makePreviews ? 1 : 0);
  const speed = mbps ?? 5; // a cautious guess when the test fails
  const allSeconds = uploadSeconds(total(sorted.images) + total(sorted.raws) + (jpegBytes - total(sorted.images)), sorted.images.length + sorted.raws.length + previews, speed);
  const jpegSeconds = uploadSeconds(jpegBytes, sorted.images.length + previews, speed);
  const hasRaws = sorted.raws.length > 0;
  let advice: Advice;
  let message: string;
  if (allSeconds <= 10 * 60) {
    advice = 'go';
    message = `About ${duration(allSeconds)}. Go ahead.`;
  } else if (allSeconds <= 45 * 60) {
    advice = 'coffee';
    message = `About ${duration(allSeconds)}. Go ahead: time for a coffee.`;
  } else if (hasRaws && jpegSeconds <= 45 * 60) {
    advice = 'split';
    message = `Everything would take about ${duration(allSeconds)}. We suggest the JPEGs now (about ${duration(jpegSeconds)}) and the RAWs later from a faster connection, at home or in the office.`;
  } else {
    advice = 'slow';
    message = `This would take about ${duration(hasRaws ? jpegSeconds : allSeconds)}${hasRaws ? ' even for the JPEGs alone' : ''}. Try a faster connection, or choose fewer pictures. You can stop and carry on later: anything already sent is skipped.`;
  }
  if (mbps === undefined) message = `We could not test the connection, so this is a guess. ${message}`;
  return { mbps, allSeconds, jpegSeconds, advice, message };
}

export function duration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}

export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * Finds the largest complete JPEG inside a RAW file. Nearly every camera
 * embeds a full-size or large preview. It walks real JPEG structure (segment
 * lengths, then entropy-coded data to the end marker), so the small thumbnail
 * tucked inside the preview's own EXIF is not mistaken for the preview.
 */
export function largestEmbeddedJpeg(bytes: Uint8Array): Uint8Array | undefined {
  let best: [number, number] | undefined;
  for (let i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue;
    const found = jpegEnd(bytes, i);
    if (!found) continue;
    // Lossless JPEG is how some cameras (Canon CR2, many DNGs) store the RAW data itself: not a picture we can use.
    if (!LOSSLESS.has(found.sof) && (!best || found.end - i > best[1] - best[0])) best = [i, found.end];
    i = found.end - 1; // carry on after this one
  }
  return best ? bytes.subarray(best[0], best[1]) : undefined;
}

const LOSSLESS = new Set([0xc3, 0xc7, 0xcb, 0xcf]);

function jpegEnd(b: Uint8Array, start: number): { end: number; sof: number } | undefined {
  let p = start + 2;
  let sof = 0;
  // Marker segments up to Start of Scan.
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return undefined;
    const marker = b[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd9) return { end: p + 2, sof };
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sof = marker;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return undefined;
    p += 2 + len;
    if (marker === 0xda) break;
  }
  if (!sof) return undefined;
  // Entropy-coded data (and any further scans) to End of Image.
  while (p + 1 < b.length) {
    if (b[p] === 0xff) {
      const n = b[p + 1];
      if (n === 0xd9) return { end: p + 2, sof };
      if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
        p += n === 0xff ? 1 : 2;
        continue;
      }
      // Another marker (e.g. a further scan in a progressive JPEG): skip its segment.
      if (p + 4 > b.length) return undefined;
      const len = (b[p + 2] << 8) | b[p + 3];
      p += 2 + len;
      continue;
    }
    p++;
  }
  return undefined;
}
