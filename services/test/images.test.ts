import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { renderJpeg, orientedSize, dHash, hammingDistance, colourOf, smallPixels } from '../src/lib/images';
import { readMetadata } from '../src/lib/ingest';
import { parseRenditionPath, renditionKey } from '../src/lib/sizes';
import { deviceOf } from '../src/lib/device';
import { autoRecipe } from '@stills/recipe';

async function photo(w = 1200, h = 800, opts: { orientation?: number; exif?: Record<string, any> } = {}) {
  // A simple scene: sky gradient over darker ground, with a red block.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fb2e8"/><stop offset="1" stop-color="#dfe9f2"/></linearGradient></defs>
    <rect width="${w}" height="${h * 0.6}" fill="url(#s)"/>
    <rect y="${h * 0.6}" width="${w}" height="${h * 0.4}" fill="#4a5a30"/>
    <rect x="${w * 0.1}" y="${h * 0.1}" width="${w * 0.2}" height="${h * 0.2}" fill="#c0302a"/>
  </svg>`;
  let img = sharp(Buffer.from(svg)).jpeg({ quality: 90 });
  if (opts.exif) img = img.withExif(opts.exif);
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  return img.toBuffer();
}

describe('images', () => {
  it('reads the oriented size', async () => {
    expect(await orientedSize(await photo(1200, 800))).toEqual({ w: 1200, h: 800 });
    expect(await orientedSize(await photo(1200, 800, { orientation: 6 }))).toEqual({ w: 800, h: 1200 });
  });

  it('renders sizes without upscaling, and applies a recipe', async () => {
    const src = await photo(1200, 800);
    const t = await sharp(await renderJpeg(src, { v: 1 }, 't', 1200, 800)).metadata();
    expect([t.width, t.height]).toEqual([480, 320]);
    const m = await sharp(await renderJpeg(src, { v: 1 }, 'm', 1200, 800)).metadata();
    expect([m.width, m.height]).toEqual([1200, 800]);
    const cropped = await renderJpeg(src, { v: 1, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, exposure: 1 }, 'full', 1200, 800);
    const cm = await sharp(cropped).metadata();
    expect([cm.width, cm.height]).toEqual([600, 400]);
    const before = await sharp(await renderJpeg(src, { v: 1, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } }, 'full', 1200, 800)).stats();
    const after = await sharp(cropped).stats();
    expect(after.channels[1].mean).toBeGreaterThan(before.channels[1].mean + 15);
  });

  it('renders turned pictures the right way up', async () => {
    const src = await photo(1200, 800, { orientation: 6 });
    const out = await sharp(await renderJpeg(src, { v: 1, exposure: 0.2 }, 'full', 800, 1200)).metadata();
    expect([out.width, out.height]).toEqual([800, 1200]);
  });

  it('keeps credit and copyright in downloads but no GPS', async () => {
    const src = await photo(600, 400, { exif: { IFD0: { Make: 'Sony', Model: 'ILCE-7M4' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } } });
    const out = await renderJpeg(src, { v: 1, contrast: 10 }, 'full', 600, 400, { credit: 'Jo Bloggs', copyright: 'Big Small TV' });
    const meta = await readMetadata(out);
    expect(meta.credit).toBe('Jo Bloggs');
    expect(meta.copyright).toBe('Big Small TV');
    expect(meta.exif?.gps).toBeUndefined();
  });

  it('reads camera details from EXIF', async () => {
    const src = await photo(600, 400, {
      exif: { IFD0: { Make: 'Canon', Model: 'Canon EOS R5', Artist: 'A Photographer', Copyright: '© Serpentine' }, IFD2: { ISO: '400', FNumber: '28/10' } },
    });
    const meta = await readMetadata(src);
    expect(meta.exif?.camera).toBe('Canon EOS R5');
    expect(meta.credit).toBe('A Photographer');
    // EXIF text is ASCII, so © arrives as (C).
    expect(meta.copyright).toBe('(C) Serpentine');
  });

  it('gives near-duplicates close perceptual hashes', async () => {
    const a = await photo(1200, 800);
    const b = await sharp(a).resize(600).jpeg({ quality: 60 }).toBuffer();
    const c = await sharp(a).negate().jpeg().toBuffer();
    expect(hammingDistance(await dHash(a), await dHash(b))).toBeLessThanOrEqual(4);
    expect(hammingDistance(await dHash(a), await dHash(c))).toBeGreaterThan(12);
  });

  it('names a colour', async () => {
    const red = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#c62a24' } }).jpeg().toBuffer();
    expect((await colourOf(red)).colourName).toBe('red');
  });

  it('suggests a recipe from a real decode', async () => {
    const src = await photo(1200, 800);
    const dark = await sharp(src).linear(0.4, 0).jpeg().toBuffer();
    const r = autoRecipe(await smallPixels(dark), { v: 1 }, 1200, 800);
    expect(r.exposure).toBeGreaterThan(0.5);
  });
});

describe('rendition addresses', () => {
  it('round-trips', () => {
    const key = renditionKey('st_0123456789abcdef', 'm', 12);
    expect(key).toBe('r/st_0123456789abcdef/m/v12.jpg');
    expect(parseRenditionPath('/' + key)).toEqual({ stillId: 'st_0123456789abcdef', size: 'm', version: 12 });
    expect(parseRenditionPath('/r/../etc/m/v1.jpg')).toBeNull();
    expect(parseRenditionPath('/r/st_0123456789abcdef/xl/v1.jpg')).toBeNull();
  });
});

describe('device', () => {
  it('tells phones, tablets and computers apart', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('phone');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 Safari/537.36')).toBe('tablet');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('computer');
  });
});
