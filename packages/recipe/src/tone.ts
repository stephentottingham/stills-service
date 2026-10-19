import { Recipe } from './types';
import { blur, clahe } from './filters';

/**
 * Tone and colour. Works on display-referred sRGB floats (0..1) from geometry,
 * in place where it can. The formulas are our own, written to behave like
 * Lightroom's sliders; they are documented in docs/RECIPES.md.
 */

// Luminance weights (Rec. 709).
const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;

/** Constants shared with auto.ts, which inverts some of these mappings. */
export const WB_ALPHA = 0.4; // temperature: log-ratio per unit
export const WB_GAMMA = 0.3; // tint: log-ratio per unit
export const BLACKS_RANGE = 0.08;
export const WHITES_RANGE = 0.2;

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** White-balance multipliers for temperature and tint (-1..1), normalised to keep brightness. */
export function wbMultipliers(temperature: number, tint: number): [number, number, number] {
  let r = Math.exp(WB_ALPHA * temperature + (WB_GAMMA * tint) / 2);
  let g = Math.exp(-WB_GAMMA * tint);
  let b = Math.exp(-WB_ALPHA * temperature + (WB_GAMMA * tint) / 2);
  const y = KR * r + KG * g + KB * b;
  return [r / y, g / y, b / y];
}

/** The luminance tone curve: highlights, shadows, whites, blacks, contrast. Input may exceed 1. */
export function toneCurve(y: number, r: Recipe): number {
  const h = (r.highlights ?? 0) / 100;
  const s = (r.shadows ?? 0) / 100;
  const wh = (r.whites ?? 0) / 100;
  const bl = (r.blacks ?? 0) / 100;
  const c = (r.contrast ?? 0) / 100;

  // Shadows: lift or deepen the lower half, peaking at a quarter.
  if (s !== 0 && y < 0.5) y = y + s * 2 * y * (0.5 - y);

  // Highlights: positive brightens the upper half; negative compresses it,
  // which also pulls back values pushed past white by exposure.
  if (h > 0 && y > 0.5 && y < 1) y = y + h * 2 * (y - 0.5) * (1 - y);
  else if (h < 0 && y > 0.5) y = 0.5 + (y - 0.5) / (1 + -h * 1.2 * (y - 0.5));

  // Whites and blacks move the end points.
  const bp = -BLACKS_RANGE * bl;
  const wp = 1 - WHITES_RANGE * wh;
  y = (y - bp) / (wp - bp);

  // Contrast: a symmetric S-curve around middle grey.
  if (c !== 0) {
    const p = Math.pow(2, c * 0.9);
    const t = y < 0 ? 0 : y > 1 ? 1 : y;
    y = t < 0.5 ? 0.5 * Math.pow(2 * t, p) : 1 - 0.5 * Math.pow(2 * (1 - t), p);
  }
  return y;
}

const LUT_SIZE = 4096;
const LUT_MAX = 4; // inputs above white (from exposure) up to 4x

/** Tone curve as a lookup table over 0..LUT_MAX. Fast, and identical wherever it runs. */
function toneLut(r: Recipe): Float32Array {
  const lut = new Float32Array(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) lut[i] = toneCurve((i / LUT_SIZE) * LUT_MAX, r);
  return lut;
}

function lookup(lut: Float32Array, y: number): number {
  const f = (y / LUT_MAX) * LUT_SIZE;
  if (f <= 0) return lut[0];
  if (f >= LUT_SIZE) return lut[LUT_SIZE];
  const i = f | 0;
  const t = f - i;
  return lut[i] * (1 - t) + lut[i + 1] * t;
}

/** Runs the tone and colour stages on RGB floats, in place. */
export function applyTone(rgb: Float32Array, w: number, h: number, r: Recipe): void {
  const n = w * h;
  const ev = r.exposure ?? 0;
  const temp = (r.temperature ?? 0) / 100;
  const tint = (r.tint ?? 0) / 100;

  // 1. White balance and exposure, in linear light.
  if (ev !== 0 || temp !== 0 || tint !== 0) {
    // Each channel's mapping is a fixed 1D function, so it becomes a lookup table.
    const gain = Math.pow(2, ev);
    const [mr, mg, mb] = wbMultipliers(temp, tint);
    const size = 4096;
    const lr = new Float32Array(size + 1);
    const lg = new Float32Array(size + 1);
    const lb = new Float32Array(size + 1);
    for (let i = 0; i <= size; i++) {
      const lin = srgbToLinear(i / size) * gain;
      lr[i] = linearToSrgb(lin * mr);
      lg[i] = linearToSrgb(lin * mg);
      lb[i] = linearToSrgb(lin * mb);
    }
    for (let i = 0; i < n * 3; i += 3) {
      rgb[i] = unitLookup(lr, rgb[i]);
      rgb[i + 1] = unitLookup(lg, rgb[i + 1]);
      rgb[i + 2] = unitLookup(lb, rgb[i + 2]);
    }
  }

  // 2. Tone curve on luminance; colour follows by ratio so hues hold.
  const toneActive = ['highlights', 'shadows', 'whites', 'blacks', 'contrast'].some((k) => (r as any)[k]);
  if (toneActive) {
    const lut = toneLut(r);
    for (let i = 0; i < n * 3; i += 3) {
      const y = KR * rgb[i] + KG * rgb[i + 1] + KB * rgb[i + 2];
      if (y <= 1e-6) {
        const y2 = Math.max(0, lookup(lut, 0));
        rgb[i] = rgb[i + 1] = rgb[i + 2] = y2;
        continue;
      }
      const k = Math.max(0, lookup(lut, y)) / y;
      rgb[i] *= k;
      rgb[i + 1] *= k;
      rgb[i + 2] *= k;
    }
  }

  // 3. Clarity and adaptive local contrast: both work on luminance.
  const clarity = (r.clarity ?? 0) / 100;
  const local = (r.localContrast ?? 0) / 100;
  if (clarity !== 0 || local !== 0) {
    const lum = luminance(rgb, n, true);
    const target = lum.slice();
    if (local !== 0) {
      const eq = clahe(lum, w, h);
      for (let i = 0; i < n; i++) target[i] = target[i] + (eq[i] - target[i]) * local * 0.6;
    }
    if (clarity !== 0) {
      // Radius scales with the image, so previews match full size.
      const radius = Math.max(w, h) * 0.015;
      const base = blur(target, w, h, radius);
      for (let i = 0; i < n; i++) {
        const y = target[i];
        const mid = 4 * y * (1 - y);
        target[i] = y + clarity * 0.8 * (y - base[i]) * mid;
      }
    }
    applyLuminance(rgb, lum, target, n);
  }

  // 4. Colour: vibrance, saturation, warmth.
  const vib = (r.vibrance ?? 0) / 100;
  const sat = (r.saturation ?? 0) / 100;
  const warmth = (r.warmth ?? 0) / 100;
  if (vib !== 0 || sat !== 0 || warmth !== 0) {
    const wr = 1 + 0.08 * warmth;
    const wb = 1 - 0.08 * warmth;
    for (let i = 0; i < n * 3; i += 3) {
      let R = rgb[i];
      let G = rgb[i + 1];
      let B = rgb[i + 2];
      if (warmth !== 0) {
        const y0 = KR * R + KG * G + KB * B;
        R *= wr;
        B *= wb;
        const y1 = KR * R + KG * G + KB * B;
        const k = y1 > 1e-6 ? y0 / y1 : 1;
        R *= k;
        G *= k;
        B *= k;
      }
      const y = KR * R + KG * G + KB * B;
      let f = 1 + sat;
      if (vib !== 0) {
        const mx = Math.max(R, G, B);
        const mn = Math.min(R, G, B);
        const cur = mx > 1e-6 ? (mx - mn) / mx : 0;
        // Vibrance favours muted colours and leaves strong ones alone.
        f *= 1 + vib * (1 - cur) * (vib > 0 ? 1 : 1.2);
      }
      if (f < 0) f = 0;
      rgb[i] = y + (R - y) * f;
      rgb[i + 1] = y + (G - y) * f;
      rgb[i + 2] = y + (B - y) * f;
    }
  }

  // 5. Black and white.
  if (r.bw) {
    for (let i = 0; i < n * 3; i += 3) {
      const y = KR * rgb[i] + KG * rgb[i + 1] + KB * rgb[i + 2];
      rgb[i] = rgb[i + 1] = rgb[i + 2] = y;
    }
  }

  // 6. Vignette, relative to the output frame.
  const vig = (r.vignette ?? 0) / 100;
  if (vig !== 0) {
    const cx = w / 2;
    const cy = h / 2;
    for (let y = 0; y < h; y++) {
      const dy = (y + 0.5 - cy) / cy;
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5 - cx) / cx;
        const d = Math.sqrt((dx * dx + dy * dy) / 2);
        const m = smoothstep(0.35, 1.0, d);
        const k = vig < 0 ? 1 + vig * 0.75 * m : 1 + vig * 0.6 * m;
        const i = (y * w + x) * 3;
        if (vig < 0) {
          rgb[i] *= k;
          rgb[i + 1] *= k;
          rgb[i + 2] *= k;
        } else {
          // Lighten towards white rather than multiplying, so edges do not blow out.
          const a = k - 1;
          rgb[i] += (1 - rgb[i]) * a;
          rgb[i + 1] += (1 - rgb[i + 1]) * a;
          rgb[i + 2] += (1 - rgb[i + 2]) * a;
        }
      }
    }
  }

  // 7. Sharpen at the output size (fixed pixel radius, like export sharpening).
  const sharpen = (r.sharpen ?? 0) / 100;
  if (sharpen > 0) {
    const lum = luminance(rgb, n, true);
    const base = blur(lum, w, h, 1.0);
    const target = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const detail = lum[i] - base[i];
      // A small threshold keeps flat areas and noise calm.
      const d = Math.abs(detail) < 0.004 ? 0 : detail;
      target[i] = lum[i] + d * sharpen * 1.5;
    }
    applyLuminance(rgb, lum, target, n);
  }
}

/** Interpolated lookup over inputs 0..1. */
function unitLookup(lut: Float32Array, c: number): number {
  const last = lut.length - 1;
  const f = c * last;
  if (f <= 0) return lut[0];
  if (f >= last) return lut[last];
  const i = f | 0;
  const t = f - i;
  return lut[i] * (1 - t) + lut[i + 1] * t;
}

export function luminance(rgb: Float32Array, n: number, clip: boolean): Float32Array {
  const lum = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const y = KR * rgb[j] + KG * rgb[j + 1] + KB * rgb[j + 2];
    lum[i] = clip ? (y < 0 ? 0 : y > 1 ? 1 : y) : y;
  }
  return lum;
}

/** Moves each pixel from luminance `from` to `to`, keeping its colour. */
function applyLuminance(rgb: Float32Array, from: Float32Array, to: Float32Array, n: number) {
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const delta = to[i] - from[i];
    // Additive for dark pixels (avoids noise blowing up), multiplicative otherwise.
    if (from[i] < 0.05) {
      rgb[j] += delta;
      rgb[j + 1] += delta;
      rgb[j + 2] += delta;
    } else {
      const k = Math.max(0, to[i]) / from[i];
      rgb[j] *= k;
      rgb[j + 1] *= k;
      rgb[j + 2] *= k;
    }
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
