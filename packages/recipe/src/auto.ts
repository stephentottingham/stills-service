import { Recipe, Pixels } from './types';
import { transform, outputSize } from './geometry';
import { applyTone, luminance, srgbToLinear, WB_ALPHA, WB_GAMMA, BLACKS_RANGE, WHITES_RANGE, toneCurve } from './tone';
import { blur } from './filters';
import { normalise } from './normalise';

/**
 * Auto: looks at a small copy of the picture and suggests slider values.
 * Nothing is saved; the editor shows the result and people adjust from there.
 *
 * - White balance: grey world in linear light, ignoring clipped and very dark pixels, softened.
 * - Tone: exposure from the median, then whites and blacks from the 0.5% and 99.5% points.
 * - Local contrast (CLAHE): set when the picture is flat.
 * - Straighten: from the dominant near-horizontal or near-vertical edges, when they are clear.
 *
 * `src` should be small (about 512 px on the long edge); results do not depend on its size.
 */
export function autoRecipe(src: Pixels, current: Recipe, srcW: number, srcH: number): Recipe {
  // Analyse the current framing, without any tone.
  const geometryOnly: Recipe = {
    v: 1,
    rotate: current.rotate,
    flipH: current.flipH,
    flipV: current.flipV,
    straighten: current.straighten,
    crop: current.crop,
  };
  const [w, h] = outputSize(geometryOnly, srcW, srcH, 512);
  const base = transform(src, geometryOnly, srcW, srcH, w, h);
  const n = w * h;

  // White balance.
  const [temperature, tint] = autoWhiteBalance(base, n);

  // Exposure from the median.
  const wbOnly = run(base, w, h, { v: 1, temperature, tint });
  const median = percentile(luminance(wbOnly, n, false), 0.5);
  const exposure = clamp(Math.log2(srgbToLinear(0.46) / Math.max(srgbToLinear(median), 1e-4)) * 0.85, -2.5, 2.5);

  // Highlights if exposure has pushed the top past white.
  const exposed = run(base, w, h, { v: 1, temperature, tint, exposure });
  const lumE = luminance(exposed, n, false);
  const hiRaw = percentile(lumE, 0.995);
  const highlights = hiRaw > 1 ? -clamp((hiRaw - 1) * 120, 0, 80) : 0;

  // Whites and blacks from the end points, after highlights.
  const afterH = lumE.map((y) => toneCurve(y, { v: 1, highlights }));
  const lo = percentile(afterH, 0.005);
  const hi = percentile(afterH, 0.995);
  const range = Math.max(0.2, (hi - lo) / 0.95);
  const bp = lo - 0.02 * range;
  const wp = bp + range;
  const whites = clamp(((1 - wp) / WHITES_RANGE) * 100, -60, 60);
  const blacks = clamp((-bp / BLACKS_RANGE) * 100, -60, 60);

  // Shadows and contrast from the shape of what is left.
  const shaped = afterH.map((y) => toneCurve(y, { v: 1, whites, blacks }));
  const q25 = percentile(shaped, 0.25);
  const shadows = clamp((0.22 - q25) * 150, 0, 40);
  const sd = stdDev(shaped);
  const contrast = clamp((0.21 - sd) * 200, -15, 25);

  // Local contrast when the picture is flat.
  const lum = Float32Array.from(shaped, (y) => clamp(y, 0, 1));
  const soft = blur(lum, w, h, Math.max(w, h) * 0.015);
  let detail = 0;
  for (let i = 0; i < n; i++) detail += Math.abs(lum[i] - soft[i]);
  detail /= n;
  const localContrast = clamp((0.06 - detail) * 600, 0, 30);

  const out: Record<string, unknown> = {
    ...current,
    temperature,
    tint,
    exposure,
    highlights,
    shadows,
    whites,
    blacks,
    contrast,
    localContrast,
  };

  // Straighten only when nothing is set yet.
  if (!current.straighten) {
    const straightenOnly: Recipe = { v: 1, rotate: current.rotate, flipH: current.flipH, flipV: current.flipV };
    const [sw, sh] = outputSize(straightenOnly, srcW, srcH, 512);
    const angle = estimateTilt(luminance(transform(src, straightenOnly, srcW, srcH, sw, sh), sw * sh, true), sw, sh);
    if (angle !== null && Math.abs(angle) >= 0.3) out.straighten = angle;
  }

  return normalise(out);
}

/** Grey world: returns [temperature, tint] in slider units. */
export function autoWhiteBalance(rgb: Float32Array, n: number): [number, number] {
  let R = 0;
  let G = 0;
  let B = 0;
  let count = 0;
  for (let i = 0; i < n * 3; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    if (r > 0.96 || g > 0.96 || b > 0.96) continue; // clipped
    if (r + g + b < 0.12) continue; // too dark to tell
    R += srgbToLinear(r);
    G += srgbToLinear(g);
    B += srgbToLinear(b);
    count++;
  }
  if (count < n * 0.05 || R <= 0 || G <= 0 || B <= 0) return [0, 0];
  // Invert wbMultipliers(): see tone.ts.
  const t = Math.log(B / R) / (2 * WB_ALPHA);
  const ti = -Math.log(Math.sqrt(R * B) / G) / (1.5 * WB_GAMMA);
  // Softened: grey world over-corrects scenes that really are one colour (sunsets, stage light).
  const soften = 0.7;
  return [clamp(t * 100 * soften, -60, 60), clamp(ti * 100 * soften, -60, 60)];
}

/**
 * Estimates how far the picture is tilted, in degrees, from near-horizontal and
 * near-vertical edges. Returns the straighten value that levels it, or null
 * when there is no clear answer.
 */
export function estimateTilt(lum: Float32Array, w: number, h: number): number | null {
  const range = 10; // degrees either way
  const binsPerDeg = 4;
  const bins = new Float64Array(range * 2 * binsPerDeg + 1);
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1] - (lum[i - w - 1] + 2 * lum[i - 1] + lum[i + w - 1]);
      const gy =
        lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1] - (lum[i - w - 1] + 2 * lum[i - w] + lum[i - w + 1]);
      const m = Math.hypot(gx, gy);
      if (m < 0.25) continue;
      // Gradient angle folded to -45..45: deviation from the nearest axis.
      let a = (Math.atan2(gy, gx) * 180) / Math.PI;
      a = ((((a + 45) % 90) + 90) % 90) - 45;
      total += m;
      if (Math.abs(a) > range) continue;
      bins[Math.round((a + range) * binsPerDeg)] += m;
    }
  }
  if (total === 0) return null;
  // Smooth, then find the peak.
  const smooth = new Float64Array(bins.length);
  for (let i = 0; i < bins.length; i++) {
    let s = 0;
    for (let j = -2; j <= 2; j++) s += bins[Math.min(bins.length - 1, Math.max(0, i + j))] * (3 - Math.abs(j));
    smooth[i] = s / 9;
  }
  let best = 0;
  for (let i = 1; i < smooth.length; i++) if (smooth[i] > smooth[best]) best = i;
  const mean = smooth.reduce((a, b) => a + b, 0) / smooth.length;
  // The peak must stand well clear, and hold a fair share of all edges.
  const inPeak = bins.slice(Math.max(0, best - 2), best + 3).reduce((a, b) => a + b, 0);
  if (smooth[best] < mean * 3 || inPeak < total * 0.08) return null;
  const tilt = best / binsPerDeg - range;
  return Math.round(-tilt * 10) / 10;
}

function run(base: Float32Array, w: number, h: number, recipe: Recipe): Float32Array {
  const copy = base.slice();
  applyTone(copy, w, h, recipe);
  return copy;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}

function stdDev(values: ArrayLike<number>): number {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.min(1, Math.max(0, values[i]));
    s += v;
    s2 += v * v;
  }
  const m = s / values.length;
  return Math.sqrt(Math.max(0, s2 / values.length - m * m));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
