import { Recipe, Pixels } from './types';
import { transform, outputSize } from './geometry';
import { applyTone } from './tone';

export interface RenderOptions {
  /** Oriented size of the original, in pixels. The buffer passed in may be smaller. */
  srcW: number;
  srcH: number;
  /** Long-edge limit of the output. Infinity for full size. */
  maxEdge: number;
}

/**
 * original pixels + recipe -> output pixels (RGBA).
 * The editor calls this on a canvas; the server calls it on sharp's raw output.
 */
export function render(src: Pixels, recipe: Recipe, opts: RenderOptions): Pixels {
  const [w, h] = outputSize(recipe, opts.srcW, opts.srcH, opts.maxEdge);
  const rgb = transform(src, recipe, opts.srcW, opts.srcH, w, h);
  applyTone(rgb, w, h, recipe);
  return { data: toRgba(rgb, w * h), width: w, height: h };
}

function toRgba(rgb: Float32Array, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 3, k += 4) {
    // Uint8ClampedArray clamps and rounds on assignment.
    out[k] = rgb[j] * 255;
    out[k + 1] = rgb[j + 1] * 255;
    out[k + 2] = rgb[j + 2] * 255;
    out[k + 3] = 255;
  }
  return out;
}
