declare module 'heic-decode' {
  export default function decode(opts: { buffer: ArrayBuffer | Uint8Array }): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
