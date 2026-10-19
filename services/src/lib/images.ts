import sharp, { type Sharp } from 'sharp';
import { render, decodeLongEdge, isIdentity, Recipe } from '@stills/recipe';
import { SIZES, QUALITY, Size } from './sizes';

sharp.cache(false);

export const ACCEPTED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tif',
};

export function isHeic(contentType: string, filename = ''): boolean {
  return /hei[cf]/i.test(contentType) || /\.hei[cf]$/i.test(filename);
}

/**
 * Turns a HEIC file into a full-size JPEG master. The sharp build on Lambda
 * cannot read HEIC (HEVC licensing), so we decode with libheif (WebAssembly).
 */
export async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const { decode } = await import('./heic');
  const { width, height, data } = await decode({ buffer: buf as unknown as ArrayBuffer });
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width, height, channels: 4 } })
    .removeAlpha()
    .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/** Oriented pixel size (EXIF orientation applied). */
export async function orientedSize(buf: Buffer): Promise<{ w: number; h: number }> {
  const m = await sharp(buf, { failOn: 'none' }).metadata();
  const swap = (m.orientation ?? 1) >= 5;
  const w = m.width ?? 0;
  const h = m.height ?? 0;
  return swap ? { w: h, h: w } : { w, h };
}

export interface RenderMeta {
  credit?: string;
  copyright?: string;
  title?: string;
}

/**
 * Renders one rendition: original + recipe at a size, as JPEG.
 * Identity recipes skip the pixel pipeline and let libvips resize directly.
 */
export async function renderJpeg(
  source: Buffer,
  recipe: Recipe,
  size: Size,
  srcW: number,
  srcH: number,
  meta: RenderMeta = {},
): Promise<Buffer> {
  const maxEdge = SIZES[size];
  const quality = QUALITY[size];
  let out: Sharp;

  if (isIdentity(recipe)) {
    out = sharp(source, { failOn: 'none' }).rotate();
    if (Number.isFinite(maxEdge)) out = out.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true });
  } else {
    const long = decodeLongEdge(recipe, srcW, srcH, maxEdge);
    let decoded = sharp(source, { failOn: 'none' }).rotate();
    if (long < Math.max(srcW, srcH)) decoded = decoded.resize(long, long, { fit: 'inside' });
    const { data, info } = await decoded.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = render({ data, width: info.width, height: info.height }, recipe, { srcW, srcH, maxEdge });
    out = sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength), {
      raw: { width: px.width, height: px.height, channels: 4 },
    }).removeAlpha();
  }

  // Our own small EXIF block: credit and copyright travel with downloads; GPS and camera serials do not.
  const ifd0: Record<string, string> = {};
  if (meta.credit) ifd0.Artist = ascii(meta.credit);
  if (meta.copyright) ifd0.Copyright = ascii(meta.copyright);
  if (meta.title) ifd0.ImageDescription = ascii(meta.title);
  if (Object.keys(ifd0).length && size !== 't') out = out.withExif({ IFD0: ifd0 });

  return out
    .toColourspace('srgb')
    .jpeg({ quality, mozjpeg: size !== 'full', chromaSubsampling: size === 'full' ? '4:4:4' : '4:2:0' })
    .toBuffer();
}

/** A small copy (about 512 px) as RGBA, for Auto and analysis. */
export async function smallPixels(source: Buffer, edge = 512) {
  const { data, info } = await sharp(source, { failOn: 'none' })
    .rotate()
    .resize(edge, edge, { fit: 'inside' })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** 64-bit difference hash: robust to resizing and small edits; near-duplicates differ by a few bits. */
export async function dHash(source: Buffer): Promise<string> {
  const px = await sharp(source, { failOn: 'none' }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

const NAMED: [string, number, number, number][] = [
  ['red', 200, 40, 40],
  ['orange', 230, 130, 40],
  ['yellow', 230, 210, 60],
  ['green', 60, 160, 70],
  ['teal', 40, 150, 150],
  ['blue', 50, 90, 200],
  ['purple', 130, 60, 170],
  ['pink', 230, 120, 170],
  ['brown', 120, 80, 50],
  ['black', 20, 20, 20],
  ['grey', 128, 128, 128],
  ['white', 235, 235, 235],
];

/** Mean colour and a plain name for colour search. */
export async function colourOf(source: Buffer): Promise<{ colour: string; colourName: string }> {
  const s = await sharp(source, { failOn: 'none' }).rotate().resize(64, 64, { fit: 'inside' }).toColourspace('srgb').stats();
  const [r, g, b] = s.channels.slice(0, 3).map((c) => Math.round(c.mean));
  // The dominant colour is a better guide than the mean when it is strong.
  const d = s.dominant;
  const sat = (Math.max(d.r, d.g, d.b) - Math.min(d.r, d.g, d.b)) / Math.max(1, Math.max(d.r, d.g, d.b));
  const [cr, cg, cb] = sat > 0.25 ? [d.r, d.g, d.b] : [r, g, b];
  let best = NAMED[0][0];
  let bestD = Infinity;
  for (const [name, nr, ng, nb] of NAMED) {
    const dist = (cr - nr) ** 2 * 0.3 + (cg - ng) ** 2 * 0.59 + (cb - nb) ** 2 * 0.11;
    if (dist < bestD) {
      bestD = dist;
      best = name;
    }
  }
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { colour: hex, colourName: best };
}

function ascii(s: string): string {
  return s.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
}
