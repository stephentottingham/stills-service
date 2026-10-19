/** Single-channel helpers used by clarity, sharpen and CLAHE. */

/** Approximate Gaussian blur: three box blurs, separable. radius in pixels (may be fractional). */
export function blur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 0.5) return src.slice();
  // Box sizes for 3 passes approximating a Gaussian with sigma = radius.
  const sigma = radius;
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  const sizes = [0, 1, 2].map((i) => (i < m ? wl : wu));

  let a = src.slice();
  let b = new Float32Array(src.length);
  for (const size of sizes) {
    const r = (size - 1) >> 1;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const scale = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + clampI(i, w)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * scale;
      acc += src[row + clampI(x + r + 1, w)] - src[row + clampI(x - r, w)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const scale = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[clampI(i, h) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc * scale;
      acc += src[clampI(y + r + 1, h) * w + x] - src[clampI(y - r, h) * w + x];
    }
  }
}

function clampI(i: number, n: number): number {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/**
 * Contrast-limited adaptive histogram equalisation on a 0..1 channel.
 * The tile grid is a fixed 8x8 whatever the image size, so a small preview
 * and a full-size render get the same result.
 */
export function clahe(lum: Float32Array, w: number, h: number, clipLimit = 2.5, grid = 8): Float32Array {
  const bins = 256;
  const tilesX = Math.min(grid, w);
  const tilesY = Math.min(grid, h);
  const maps: Float32Array[] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.floor((tx * w) / tilesX);
      const x1 = Math.floor(((tx + 1) * w) / tilesX);
      const y0 = Math.floor((ty * h) / tilesY);
      const y1 = Math.floor(((ty + 1) * h) / tilesY);
      const hist = new Float32Array(bins);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[binOf(lum[y * w + x])]++;
          n++;
        }
      }
      // Clip and redistribute.
      const limit = Math.max(1, (clipLimit * n) / bins);
      let excess = 0;
      for (let i = 0; i < bins; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const add = excess / bins;
      const map = new Float32Array(bins);
      let cum = 0;
      for (let i = 0; i < bins; i++) {
        cum += hist[i] + add;
        map[i] = n > 0 ? cum / n : i / (bins - 1);
      }
      maps.push(map);
    }
  }

  const out = new Float32Array(lum.length);
  for (let y = 0; y < h; y++) {
    // Tile-centre interpolation coordinates.
    const gy = ((y + 0.5) * tilesY) / h - 0.5;
    const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(gy)));
    const ty1 = Math.min(tilesY - 1, ty0 + 1);
    const fy = Math.max(0, Math.min(1, gy - ty0));
    for (let x = 0; x < w; x++) {
      const gx = ((x + 0.5) * tilesX) / w - 0.5;
      const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(gx)));
      const tx1 = Math.min(tilesX - 1, tx0 + 1);
      const fx = Math.max(0, Math.min(1, gx - tx0));
      const bin = binOf(lum[y * w + x]);
      const a = maps[ty0 * tilesX + tx0][bin];
      const b = maps[ty0 * tilesX + tx1][bin];
      const c = maps[ty1 * tilesX + tx0][bin];
      const d = maps[ty1 * tilesX + tx1][bin];
      out[y * w + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

function binOf(v: number): number {
  const b = Math.round(v * 255);
  return b < 0 ? 0 : b > 255 ? 255 : b;
}
