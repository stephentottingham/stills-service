/// <reference lib="webworker" />
import { render, Recipe } from '@stills/recipe';

/**
 * Runs the shared recipe maths off the main thread. It is the same code the
 * server runs, so the preview matches the result.
 */
let base: { data: Uint8ClampedArray; width: number; height: number } | undefined;
let srcW = 0;
let srcH = 0;

type Msg =
  | { kind: 'base'; data: Uint8ClampedArray; width: number; height: number; srcW: number; srcH: number }
  | { kind: 'render'; id: number; recipe: Recipe; maxEdge: number };

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.kind === 'base') {
    base = { data: m.data, width: m.width, height: m.height };
    srcW = m.srcW;
    srcH = m.srcH;
    return;
  }
  if (!base) return;
  if (m.kind === 'render') {
    const out = render(base, m.recipe, { srcW, srcH, maxEdge: m.maxEdge });
    (self as unknown as Worker).postMessage({ kind: 'rendered', id: m.id, data: out.data, width: out.width, height: out.height }, [
      out.data.buffer,
    ]);
  }
};
