import { describe, it, expect } from 'vitest';
import { normalise, render, autoRecipe, outputSize, RecipeError, Recipe, Pixels, estimateTilt, isIdentity } from '../src';

/** A test picture: colour gradients, soft shapes and some detail. */
function testImage(w: number, h: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const i = (y * w + x) * 4;
      const blob = Math.exp(-((u - 0.6) ** 2 + (v - 0.4) ** 2) * 12);
      data[i] = 255 * (0.15 + 0.6 * u * (1 - v) + 0.25 * blob);
      data[i + 1] = 255 * (0.2 + 0.5 * v + 0.2 * Math.sin(u * 9) ** 2);
      data[i + 2] = 255 * (0.3 + 0.4 * (1 - u) * v + 0.3 * blob);
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Box downscale by an integer factor (stands in for sharp's resize). */
function downscale(p: Pixels, f: number): Pixels {
  const w = Math.floor(p.width / f);
  const h = Math.floor(p.height / f);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += p.data[((y * f + dy) * p.width + x * f + dx) * 4 + c];
        out[(y * w + x) * 4 + c] = s / (f * f);
      }
  return { data: out, width: w, height: h };
}

function meanAbsDiff(a: Pixels, b: Pixels): number {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      s += Math.abs(a.data[i + c] - b.data[i + c]);
      n++;
    }
  return s / n;
}

function meanLum(p: Pixels): number {
  let s = 0;
  for (let i = 0; i < p.data.length; i += 4) s += 0.2126 * p.data[i] + 0.7152 * p.data[i + 1] + 0.0722 * p.data[i + 2];
  return s / (p.data.length / 4);
}

describe('normalise', () => {
  it('clamps, rounds and drops no-change values', () => {
    expect(normalise({ v: 1, exposure: 9, contrast: 0, shadows: 12.4, bw: false })).toEqual({ v: 1, exposure: 5, shadows: 12 });
  });
  it('rejects unknown fields and bad values', () => {
    expect(() => normalise({ v: 1, glow: 3 })).toThrow(RecipeError);
    expect(() => normalise({ v: 1, exposure: 'lots' })).toThrow(RecipeError);
    expect(() => normalise({ v: 1, rotate: 45 })).toThrow(RecipeError);
  });
  it('drops a full-frame crop and keeps a real one', () => {
    expect(normalise({ v: 1, crop: { x: 0, y: 0, w: 1, h: 1 } })).toEqual({ v: 1 });
    expect(normalise({ v: 1, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5, aspect: '1:1' } }).crop).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5, aspect: '1:1' });
  });
  it('knows an empty recipe', () => {
    expect(isIdentity({ v: 1, exposure: 0 })).toBe(true);
    expect(isIdentity({ v: 1, exposure: 0.5 })).toBe(false);
  });
});

describe('render', () => {
  const src = testImage(480, 320);

  it('leaves the picture alone with an empty recipe', () => {
    const out = render(src, { v: 1 }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    expect(meanAbsDiff(out, src)).toBeLessThan(0.6);
  });

  it('turns and flips', () => {
    expect(outputSize({ v: 1, rotate: 90 }, 480, 320, Infinity)).toEqual([320, 480]);
    const flipped = render(src, { v: 1, flipH: true }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    // Top-left of the flipped picture is the top-right of the original.
    const i = 0;
    const j = (479) * 4;
    expect(Math.abs(flipped.data[i] - src.data[j])).toBeLessThan(3);
    const turned = render(src, { v: 1, rotate: 90 }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    // After a clockwise turn, the top-left comes from the original's bottom-left.
    const k = (319 * 480) * 4;
    expect(Math.abs(turned.data[0] - src.data[k])).toBeLessThan(3);
  });

  it('crops to the chosen rectangle', () => {
    const out = render(src, { v: 1, crop: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    expect([out.width, out.height]).toEqual([240, 160]);
    expect(Math.abs(out.data[0] - src.data[(160 * 480 + 240) * 4])).toBeLessThan(3);
  });

  it('makes exposure brighter and darker', () => {
    const up = render(src, { v: 1, exposure: 1 }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    const down = render(src, { v: 1, exposure: -1 }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    expect(meanLum(up)).toBeGreaterThan(meanLum(src) + 20);
    expect(meanLum(down)).toBeLessThan(meanLum(src) - 20);
  });

  it('makes black and white neutral', () => {
    const out = render(src, { v: 1, bw: true }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    for (let i = 0; i < out.data.length; i += 4 * 97) {
      expect(Math.abs(out.data[i] - out.data[i + 1])).toBeLessThanOrEqual(1);
      expect(Math.abs(out.data[i + 1] - out.data[i + 2])).toBeLessThanOrEqual(1);
    }
  });

  it('moves white balance the right way', () => {
    const warm = render(src, { v: 1, temperature: 50 }, { srcW: 480, srcH: 320, maxEdge: Infinity });
    let dr = 0;
    let db = 0;
    for (let i = 0; i < src.data.length; i += 4) {
      dr += warm.data[i] - src.data[i];
      db += warm.data[i + 2] - src.data[i + 2];
    }
    expect(dr).toBeGreaterThan(0);
    expect(db).toBeLessThan(0);
  });
});

describe('the preview matches the result', () => {
  // Everything except sharpen, which is applied at each output size by design.
  const recipe: Recipe = normalise({
    v: 1,
    exposure: 0.4,
    contrast: 25,
    highlights: -40,
    shadows: 30,
    whites: 10,
    blacks: -15,
    temperature: 12,
    tint: -6,
    vibrance: 30,
    saturation: -10,
    warmth: 15,
    clarity: 40,
    localContrast: 35,
    vignette: -30,
    straighten: 3.5,
    crop: { x: 0.08, y: 0.1, w: 0.8, h: 0.75 },
  });

  it('gives the same picture at preview size and full size', () => {
    const full = testImage(1600, 1200);
    const big = render(full, recipe, { srcW: 1600, srcH: 1200, maxEdge: Infinity });
    // The editor renders a small copy of the original.
    const preview = render(downscale(full, 4), recipe, { srcW: 1600, srcH: 1200, maxEdge: Math.round(Math.max(big.width, big.height) / 4) });
    // Compare with the full-size result scaled down to preview size.
    const f = big.width / preview.width;
    expect(f).toBeCloseTo(4, 1);
    const shrunk = downscale(big, 4);
    const cropTo: Pixels = {
      width: Math.min(shrunk.width, preview.width),
      height: Math.min(shrunk.height, preview.height),
      data: new Uint8ClampedArray(0),
    };
    const crop = (p: Pixels) => {
      const d = new Uint8ClampedArray(cropTo.width * cropTo.height * 4);
      for (let y = 0; y < cropTo.height; y++) d.set(p.data.subarray(y * p.width * 4, (y * p.width + cropTo.width) * 4), y * cropTo.width * 4);
      return { ...cropTo, data: d };
    };
    expect(meanAbsDiff(crop(preview), crop(shrunk))).toBeLessThan(2.5);
  });
});

describe('auto', () => {
  it('brightens a dark picture and warms a blue one', () => {
    const src = testImage(400, 300);
    for (let i = 0; i < src.data.length; i += 4) {
      src.data[i] *= 0.35;
      src.data[i + 1] *= 0.4;
      src.data[i + 2] = Math.min(255, src.data[i + 2] * 0.7);
    }
    const r = autoRecipe(src, { v: 1 }, 400, 300);
    expect(r.exposure).toBeGreaterThan(0.5);
    expect(r.temperature).toBeGreaterThan(5);
    const out = render(src, r, { srcW: 400, srcH: 300, maxEdge: Infinity });
    expect(meanLum(out)).toBeGreaterThan(meanLum(src) + 30);
  });

  it('keeps the crop and other settings', () => {
    const src = testImage(400, 300);
    const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const r = autoRecipe(src, { v: 1, crop, bw: true, vignette: -20 }, 400, 300);
    expect(r.crop).toEqual(crop);
    expect(r.bw).toBe(true);
    expect(r.vignette).toBe(-20);
  });

  it('levels a tilted horizon', () => {
    // Horizontal bands, then tilted by straightening the "wrong" way.
    const w = 600;
    const h = 400;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = Math.floor(y / 40) % 2 ? 200 : 60;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    const tilted = render({ data, width: w, height: h }, { v: 1, straighten: 4 }, { srcW: w, srcH: h, maxEdge: Infinity });
    const lum = new Float32Array(tilted.width * tilted.height);
    for (let i = 0; i < lum.length; i++) lum[i] = tilted.data[i * 4] / 255;
    const fix = estimateTilt(lum, tilted.width, tilted.height);
    expect(fix).not.toBeNull();
    expect(fix!).toBeCloseTo(-4, 0);
  });

  it('does not invent a tilt in a picture without lines', () => {
    const src = testImage(400, 300);
    const r = autoRecipe(src, { v: 1 }, 400, 300);
    expect(r.straighten ?? 0).toBe(0);
  });
});
