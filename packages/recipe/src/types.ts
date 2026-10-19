/**
 * A recipe is the full set of adjustments for one version of a still.
 * Originals never change: a rendition is always original + recipe.
 *
 * Slider values use Lightroom-like ranges: -100..100 unless noted.
 * Missing fields mean "no change". Recipes are stored normalised (see normalise()).
 */
export interface Recipe {
  /** Schema version of the recipe format itself (not the still's version). */
  v: 1;

  // Geometry
  /** Quarter turns, clockwise. */
  rotate?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
  /** Degrees, -45..45. Positive turns the picture clockwise. The frame is cropped to stay inside the picture. */
  straighten?: number;
  /** Normalised 0..1 rectangle in the rotated and straightened frame. */
  crop?: Crop;

  // Light
  /** Exposure in stops (EV), -5..5. */
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;

  // Colour
  /** White balance, relative. Positive is warmer (more yellow). */
  temperature?: number;
  /** White balance, relative. Positive is more magenta. */
  tint?: number;
  vibrance?: number;
  saturation?: number;
  /** A gentle warm or cool grade applied after tone, distinct from white balance. */
  warmth?: number;

  // Detail
  /** Local contrast (midtones), -100..100. */
  clarity?: number;
  /** Adaptive local contrast (CLAHE), 0..100. Set by Auto; adjustable. */
  localContrast?: number;
  /** Output sharpening, 0..100. Applied at the output size, like export sharpening. */
  sharpen?: number;
  bw?: boolean;

  // Effects
  /** Negative darkens the edges, positive lightens them. */
  vignette?: number;
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The aspect preset chosen in the editor. Informational; x/y/w/h are the truth. */
  aspect?: AspectPreset;
}

export type AspectPreset = 'free' | 'original' | '16:9' | '4:5' | '1:1' | '3:2';

export const ASPECTS: Record<Exclude<AspectPreset, 'free' | 'original'>, number> = {
  '16:9': 16 / 9,
  '4:5': 4 / 5,
  '1:1': 1,
  '3:2': 3 / 2,
};

/** The numeric sliders, their ranges and defaults. The editor builds its controls from this. */
export const SLIDERS = {
  exposure: { min: -5, max: 5, step: 0.05, group: 'Light', label: 'Exposure' },
  contrast: { min: -100, max: 100, step: 1, group: 'Light', label: 'Contrast' },
  highlights: { min: -100, max: 100, step: 1, group: 'Light', label: 'Highlights' },
  shadows: { min: -100, max: 100, step: 1, group: 'Light', label: 'Shadows' },
  whites: { min: -100, max: 100, step: 1, group: 'Light', label: 'Whites' },
  blacks: { min: -100, max: 100, step: 1, group: 'Light', label: 'Blacks' },
  temperature: { min: -100, max: 100, step: 1, group: 'Colour', label: 'Temperature' },
  tint: { min: -100, max: 100, step: 1, group: 'Colour', label: 'Tint' },
  vibrance: { min: -100, max: 100, step: 1, group: 'Colour', label: 'Vibrance' },
  saturation: { min: -100, max: 100, step: 1, group: 'Colour', label: 'Saturation' },
  warmth: { min: -100, max: 100, step: 1, group: 'Colour', label: 'Warmth' },
  clarity: { min: -100, max: 100, step: 1, group: 'Detail', label: 'Clarity' },
  localContrast: { min: 0, max: 100, step: 1, group: 'Detail', label: 'Local contrast' },
  sharpen: { min: 0, max: 100, step: 1, group: 'Detail', label: 'Sharpen' },
  vignette: { min: -100, max: 100, step: 1, group: 'Effects', label: 'Vignette' },
  straighten: { min: -45, max: 45, step: 0.1, group: 'Crop', label: 'Straighten' },
} as const;

export type SliderKey = keyof typeof SLIDERS;

/** RGBA, 8 bits per channel, row-major. The same shape as browser ImageData and sharp's raw output. */
export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}
