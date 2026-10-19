import { Recipe, Pixels } from './types';

/**
 * Geometry runs as one inverse mapping: for each output pixel we find the
 * matching point in the source and sample it. Everything is in normalised
 * coordinates, so the same recipe gives the same framing at any size.
 *
 * Order (as seen in the editor): quarter-turn, flip, straighten, crop.
 */

export interface Frame {
  /** Oriented source size in original pixels. */
  srcW: number;
  srcH: number;
  /** Size of the crop, in original pixels. */
  cropW: number;
  cropH: number;
}

/** Scale that keeps a straightened frame inside the picture (Lightroom's "constrain to image"). */
export function straightenScale(w: number, h: number, degrees: number): number {
  const t = Math.abs((degrees * Math.PI) / 180);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return Math.min(w / (w * c + h * s), h / (w * s + h * c));
}

/** Size of the rotated frame (after quarter turns). */
export function rotatedSize(srcW: number, srcH: number, recipe: Recipe): [number, number] {
  const q = recipe.rotate ?? 0;
  return q === 90 || q === 270 ? [srcH, srcW] : [srcW, srcH];
}

export function frameFor(recipe: Recipe, srcW: number, srcH: number): Frame {
  const [w1, h1] = rotatedSize(srcW, srcH, recipe);
  const k = straightenScale(w1, h1, recipe.straighten ?? 0);
  const crop = recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  return { srcW, srcH, cropW: crop.w * w1 * k, cropH: crop.h * h1 * k };
}

/** Output size for a long-edge limit. Never upscales. maxEdge = Infinity gives full size. */
export function outputSize(recipe: Recipe, srcW: number, srcH: number, maxEdge: number): [number, number] {
  const f = frameFor(recipe, srcW, srcH);
  const scale = Math.min(1, maxEdge / Math.max(f.cropW, f.cropH));
  return [Math.max(1, Math.round(f.cropW * scale)), Math.max(1, Math.round(f.cropH * scale))];
}

/**
 * How big the decoded source should be (long edge) so that geometry has enough
 * pixels without wasting work. The server resizes the original to this before
 * calling render().
 */
export function decodeLongEdge(recipe: Recipe, srcW: number, srcH: number, maxEdge: number): number {
  const [outW] = outputSize(recipe, srcW, srcH, maxEdge);
  const f = frameFor(recipe, srcW, srcH);
  const outScale = outW / f.cropW; // output pixels per original pixel
  // Up to 2 source pixels per output pixel: supersampling handles the rest cleanly.
  return Math.round(Math.max(srcW, srcH) * Math.min(1, outScale * 2));
}

/**
 * Applies geometry. Returns RGB floats (0..1, display-referred sRGB) for the
 * tone stage, which works in floats from here on.
 */
export function transform(
  src: Pixels,
  recipe: Recipe,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): Float32Array {
  const out = new Float32Array(outW * outH * 3);
  const [w1, h1] = rotatedSize(srcW, srcH, recipe);
  const theta = ((recipe.straighten ?? 0) * Math.PI) / 180;
  const k = straightenScale(w1, h1, recipe.straighten ?? 0);
  const crop = recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const q = recipe.rotate ?? 0;
  const fx = recipe.flipH ? -1 : 1;
  const fy = recipe.flipV ? -1 : 1;

  const bw = src.width;
  const bh = src.height;
  const d = src.data;
  // Buffer pixels per original pixel (the source may already be downscaled).
  const sb = bw / srcW;

  // Supersample when one output pixel covers several source pixels.
  const ratio = ((crop.w * w1 * k) / outW) * sb;
  const ss = Math.min(4, Math.max(1, Math.ceil(ratio - 0.15)));
  const inv = 1 / (ss * ss);

  // Precompute per-axis affine terms: output pixel -> rotated-frame point (centre-relative, original pixels).
  const ax = (crop.w * w1 * k) / outW;
  const ay = (crop.h * h1 * k) / outH;
  const bx = (crop.x - 0.5) * w1 * k;
  const by = (crop.y - 0.5) * h1 * k;

  let o = 0;
  for (let oy = 0; oy < outH; oy++) {
    for (let ox = 0; ox < outW; ox++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        const py = by + (oy + (sy + 0.5) / ss) * ay;
        for (let sx = 0; sx < ss; sx++) {
          const px = bx + (ox + (sx + 0.5) / ss) * ax;
          // Undo straighten (content was turned clockwise by theta).
          let x = px * cos + py * sin;
          let y = -px * sin + py * cos;
          // Undo flip.
          x *= fx;
          y *= fy;
          // Undo quarter turn: back to source, centre-relative.
          let u: number;
          let v: number;
          if (q === 90) {
            u = y;
            v = -x;
          } else if (q === 180) {
            u = -x;
            v = -y;
          } else if (q === 270) {
            u = -y;
            v = x;
          } else {
            u = x;
            v = y;
          }
          // To buffer pixel coordinates.
          const bxp = (u + srcW / 2) * sb - 0.5;
          const byp = (v + srcH / 2) * sb - 0.5;
          // Bilinear sample with edge clamp.
          const cx = bxp < 0 ? 0 : bxp > bw - 1 ? bw - 1 : bxp;
          const cy = byp < 0 ? 0 : byp > bh - 1 ? bh - 1 : byp;
          const x0 = cx | 0;
          const y0 = cy | 0;
          const x1 = x0 + 1 < bw ? x0 + 1 : x0;
          const y1 = y0 + 1 < bh ? y0 + 1 : y0;
          const tx = cx - x0;
          const ty = cy - y0;
          const i00 = (y0 * bw + x0) * 4;
          const i10 = (y0 * bw + x1) * 4;
          const i01 = (y1 * bw + x0) * 4;
          const i11 = (y1 * bw + x1) * 4;
          const w00 = (1 - tx) * (1 - ty);
          const w10 = tx * (1 - ty);
          const w01 = (1 - tx) * ty;
          const w11 = tx * ty;
          r += d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
          g += d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
          b += d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
        }
      }
      out[o++] = (r * inv) / 255;
      out[o++] = (g * inv) / 255;
      out[o++] = (b * inv) / 255;
    }
  }
  return out;
}
