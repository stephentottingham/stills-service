import { parseRenditionPath } from '../lib/sizes';
import { getStill } from '../lib/stills';
import { makeRendition } from '../lib/renditions';

/**
 * Makes renditions on demand. CloudFront asks S3 first; when the file is not
 * there yet it falls over to this function (a function URL that only CloudFront
 * can call), which renders it, stores it in S3 for next time, and streams it back.
 */
declare const awslambda: {
  streamifyResponse(fn: (event: any, stream: NodeJS.WritableStream) => Promise<void>): unknown;
  HttpResponseStream: { from(stream: NodeJS.WritableStream, meta: { statusCode: number; headers: Record<string, string> }): NodeJS.WritableStream };
};

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const send = (statusCode: number, headers: Record<string, string>, body: Buffer | string) => {
    const s = awslambda.HttpResponseStream.from(responseStream, { statusCode, headers });
    s.write(body);
    s.end();
  };
  try {
    const parsed = parseRenditionPath(event.rawPath ?? '');
    if (!parsed || (event.requestContext?.http?.method ?? 'GET') !== 'GET') {
      return send(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, 'Not found');
    }
    const s = await getStill(parsed.stillId);
    if (!s || s.status !== 'ready' || parsed.version > s.version) {
      return send(404, { 'content-type': 'text/plain', 'cache-control': 'max-age=10' }, 'Not found');
    }
    const jpeg = await makeRendition(s, parsed.size, parsed.version);
    send(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' }, jpeg);
  } catch (e: any) {
    console.error('Render failed', event.rawPath, e);
    const status = e?.status === 404 ? 404 : 500;
    send(status, { 'content-type': 'text/plain', 'cache-control': 'no-store' }, status === 404 ? 'Not found' : 'Could not render');
  }
});
