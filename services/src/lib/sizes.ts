/**
 * Rendition sizes (long edge). "web" downloads are the m size.
 * A rendition's address includes the recipe version, so a new version is a new
 * address and caches never need clearing: /r/<still>/<size>/v<version>.jpg
 */
export const SIZES = { t: 480, m: 1920, l: 2560, full: Infinity } as const;
export type Size = keyof typeof SIZES;

export const QUALITY: Record<Size, number> = { t: 80, m: 85, l: 86, full: 92 };

export function isSize(s: string): s is Size {
  return s in SIZES;
}

export function renditionKey(stillId: string, size: Size, version: number): string {
  return `r/${stillId}/${size}/v${version}.jpg`;
}

export function parseRenditionPath(path: string): { stillId: string; size: Size; version: number } | null {
  const m = /^\/?r\/([a-z]{1,8}_[0-9a-z_-]{6,64})\/(t|m|l|full)\/v(\d{1,7})\.jpg$/.exec(path);
  if (!m) return null;
  return { stillId: m[1], size: m[2] as Size, version: Number(m[3]) };
}

/** Download size names used by galleries and the API. */
export function downloadSize(s: string | undefined): Size {
  if (s === 'full') return 'full';
  if (s === 'web' || s === undefined || s === 'm') return 'm';
  if (isSize(s)) return s;
  return 'm';
}
