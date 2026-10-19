import { Recipe, SLIDERS, SliderKey, Crop, AspectPreset } from './types';

const ASPECT_VALUES: AspectPreset[] = ['free', 'original', '16:9', '4:5', '1:1', '3:2'];

export class RecipeError extends Error {
  name = 'RecipeError';
}

/**
 * Validates and tidies a recipe: clamps sliders to range, drops values that
 * mean "no change", and rounds to the slider step. Two recipes that render the
 * same normalise to the same JSON.
 */
export function normalise(input: unknown): Recipe {
  if (input === null || typeof input !== 'object') throw new RecipeError('Recipe must be an object');
  const r = input as Record<string, unknown>;
  const out: Recipe = { v: 1 };

  for (const key of Object.keys(SLIDERS) as SliderKey[]) {
    const raw = r[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new RecipeError(`${key} must be a number`);
    const { min, max, step } = SLIDERS[key];
    const value = roundTo(Math.min(max, Math.max(min, raw)), step);
    if (value !== 0) out[key] = value;
  }

  if (r.rotate !== undefined && r.rotate !== null) {
    const rot = Number(r.rotate);
    const q = ((Math.round(rot / 90) % 4) + 4) % 4;
    if (rot % 90 !== 0) throw new RecipeError('rotate must be a multiple of 90');
    if (q) out.rotate = (q * 90) as Recipe['rotate'];
  }
  if (r.flipH === true) out.flipH = true;
  if (r.flipV === true) out.flipV = true;
  if (r.bw === true) out.bw = true;

  if (r.crop !== undefined && r.crop !== null) {
    const crop = normaliseCrop(r.crop);
    if (crop) out.crop = crop;
  }

  for (const key of Object.keys(r)) {
    if (!KNOWN.has(key)) throw new RecipeError(`Unknown recipe field: ${key}`);
  }
  return out;
}

const KNOWN = new Set<string>(['v', 'rotate', 'flipH', 'flipV', 'bw', 'crop', ...Object.keys(SLIDERS)]);

function normaliseCrop(input: unknown): Crop | undefined {
  if (typeof input !== 'object' || input === null) throw new RecipeError('crop must be an object');
  const c = input as Record<string, unknown>;
  const nums = ['x', 'y', 'w', 'h'].map((k) => {
    const n = c[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new RecipeError(`crop.${k} must be a number`);
    return n;
  });
  let [x, y, w, h] = nums;
  x = clamp01(x);
  y = clamp01(y);
  w = Math.min(1 - x, Math.max(0.01, w));
  h = Math.min(1 - y, Math.max(0.01, h));
  const crop: Crop = { x: roundTo(x, 1e-5), y: roundTo(y, 1e-5), w: roundTo(w, 1e-5), h: roundTo(h, 1e-5) };
  if (c.aspect !== undefined) {
    if (!ASPECT_VALUES.includes(c.aspect as AspectPreset)) throw new RecipeError('crop.aspect is not a known preset');
    if (c.aspect !== 'free') crop.aspect = c.aspect as AspectPreset;
  }
  if (crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1) return undefined;
  return crop;
}

/** True if the recipe changes nothing. */
export function isIdentity(recipe: Recipe): boolean {
  return Object.keys(normalise(recipe)).length === 1;
}

/** Copy settings from one recipe onto another (the editor's "paste"). Geometry is optional because crops rarely transfer. */
export function pasteSettings(target: Recipe, source: Recipe, opts: { geometry?: boolean } = {}): Recipe {
  const geometryKeys = ['rotate', 'flipH', 'flipV', 'straighten', 'crop'];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(target)) if (geometryKeys.includes(k)) out[k] = v;
  for (const [k, v] of Object.entries(source)) {
    if (geometryKeys.includes(k) && !opts.geometry) continue;
    out[k] = v;
  }
  return normalise(out);
}

function roundTo(n: number, step: number): number {
  const r = Math.round(n / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(r.toFixed(decimals));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
