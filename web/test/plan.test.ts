import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { kindOf, sortFiles, makePlan, duration, largestEmbeddedJpeg, uploadSeconds } from '../src/plan';

const f = (name: string, size = 1_000_000) => ({ name, size });

describe('sorting a card', () => {
  it('knows pictures from RAWs and ignores the rest', () => {
    expect(kindOf(f('IMG_0001.CR3'))).toBe('raw');
    expect(kindOf(f('DSC_0001.NEF'))).toBe('raw');
    expect(kindOf(f('IMG_0001.JPG'))).toBe('image');
    expect(kindOf(f('IMG_0001.heic'))).toBe('image');
    expect(kindOf(f('notes.txt'))).toBeUndefined();
    expect(kindOf(f('._IMG_0001.JPG'))).toBeUndefined();
  });

  it('pairs RAWs with JPEGs and skips what is already there', () => {
    const files = [f('A.CR3'), f('A.JPG', 500), f('B.CR3'), f('C.CR3'), f('D.JPG', 700), f('E.CR3')];
    const s = sortFiles(files, {
      stills: [{ filename: 'D.JPG', bytes: 700, status: 'ready' }, { filename: 'C.jpg', bytes: 1, status: 'ready' }],
      raws: [{ filename: 'E.CR3', status: 'arrived' }],
    });
    expect(s.images.map((x) => x.name)).toEqual(['A.JPG']);
    expect(s.raws.map((x) => x.name)).toEqual(['A.CR3', 'B.CR3', 'C.CR3']);
    // A has a JPEG in the drop; C has one already uploaded; B has none.
    expect(s.rawsWithoutJpeg.map((x) => x.name)).toEqual(['B.CR3']);
    expect(s.skipped).toBe(2);
  });
});

describe('planning', () => {
  const card = (raws: number, jpegs: number) =>
    sortFiles([...Array.from({ length: raws }, (_, i) => f(`R${i}.CR3`, 30e6)), ...Array.from({ length: jpegs }, (_, i) => f(`R${i}.JPG`, 8e6))], { stills: [], raws: [] });

  it('says go ahead when it is quick', () => {
    expect(makePlan(card(20, 20), 100, true).advice).toBe('go');
  });
  it('says get a coffee for up to 45 minutes', () => {
    const p = makePlan(card(200, 200), 100, true); // ~7.6 GB at 100 Mbit/s
    expect(p.advice).toBe('coffee');
    expect(p.message).toContain('coffee');
  });
  it('suggests JPEGs now and RAWs later on a slow connection', () => {
    const p = makePlan(card(400, 400), 20, true); // 15 GB at 20 Mbit/s
    expect(p.advice).toBe('split');
    expect(p.jpegSeconds).toBeLessThan(45 * 60);
    expect(p.allSeconds).toBeGreaterThan(90 * 60);
  });
  it('is honest when even the JPEGs are slow', () => {
    expect(makePlan(card(400, 400), 2, true).advice).toBe('slow');
  });
  it('counts RAW previews in the JPEG estimate', () => {
    const rawOnly = card(100, 0);
    expect(makePlan(rawOnly, 20, true).jpegSeconds).toBeGreaterThan(makePlan(rawOnly, 20, false).jpegSeconds);
  });
  it('writes times plainly', () => {
    expect(duration(30)).toBe('under a minute');
    expect(duration(60 * 7)).toBe('7 minutes');
    expect(duration(60 * 80)).toBe('1 hour 20 minutes');
    expect(uploadSeconds(0, 0, 10)).toBe(0);
  });
});

describe('RAW previews', () => {
  it('finds the large preview, not the thumbnail or the lossless RAW data', async () => {
    const preview = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#a33' } }).jpeg({ quality: 90 }).toBuffer();
    // A preview with its own small EXIF thumbnail inside, like many cameras.
    const thumb = await sharp({ create: { width: 160, height: 120, channels: 3, background: '#3a3' } }).jpeg().toBuffer();
    // Lossless JPEG (SOF3): how CR2 and many DNGs hold the sensor data.
    const lossless = Buffer.from([0xff, 0xd8, 0xff, 0xc3, 0x00, 0x05, 0, 0, 0, 0xff, 0xda, 0x00, 0x02, ...new Array(9_000_000).fill(0x11), 0xff, 0xd9]);
    const junk = Buffer.alloc(5000, 0x42);
    const raw = Buffer.concat([junk, thumb, junk, lossless, junk, preview, junk]);
    const found = largestEmbeddedJpeg(new Uint8Array(raw))!;
    expect(found.length).toBe(preview.length);
    const meta = await sharp(Buffer.from(found)).metadata();
    expect([meta.width, meta.height]).toEqual([2400, 1600]);
  });

  it('returns nothing when there is no JPEG', () => {
    expect(largestEmbeddedJpeg(new Uint8Array(10_000).fill(7))).toBeUndefined();
  });
});
