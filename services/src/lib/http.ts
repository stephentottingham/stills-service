import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { HttpError } from './errors';

export type Event = APIGatewayProxyEventV2 & { requestContext: { authorizer?: { lambda?: Record<string, any> } } };
export type Result = APIGatewayProxyStructuredResultV2;

export interface Ctx {
  event: Event;
  params: Record<string, string>;
  query: Record<string, string>;
  body: any;
}

type Handler = (ctx: Ctx) => Promise<Result | unknown>;

/** A small router: method + path pattern with {params}. */
export class Router {
  private routes: { method: string; re: RegExp; keys: string[]; handler: Handler }[] = [];

  on(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\{(\w+)\}/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  async handle(event: Event): Promise<Result> {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    try {
      let pathMatched = false;
      for (const r of this.routes) {
        const m = r.re.exec(path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const out = await r.handler({ event, params, query: (event.queryStringParameters ?? {}) as Record<string, string>, body: parseBody(event) });
        return isResult(out) ? out : json(200, out);
      }
      return pathMatched ? json(405, { error: 'Method not allowed' }) : json(404, { error: 'Not found' });
    } catch (e: any) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code });
      if (e?.name === 'RecipeError') return json(400, { error: e.message, code: 'bad_recipe' });
      console.error(e);
      return json(500, { error: 'Something went wrong' });
    }
  }
}

function parseBody(event: Event): any {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const type = event.headers?.['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

const RESULT = Symbol('result');

function isResult(x: unknown): x is Result {
  return typeof x === 'object' && x !== null && (x as any)[RESULT] === true;
}

function mark(r: Result): Result {
  Object.defineProperty(r, RESULT, { value: true, enumerable: false });
  return r;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Result {
  return mark({
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(body),
  });
}

export function html(status: number, body: string, headers: Record<string, string> = {}, cookies?: string[]): Result {
  return mark({
    statusCode: status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      ...headers,
    },
    body,
    cookies,
  });
}

export function redirect(location: string, status = 302, cookies?: string[]): Result {
  return mark({
    statusCode: status,
    headers: { location, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
    cookies,
  });
}

export function noContent(): Result {
  return mark({ statusCode: 204, headers: { 'cache-control': 'no-store' } });
}

export function readCookie(event: Event, name: string): string | undefined {
  for (const c of event.cookies ?? []) {
    const i = c.indexOf('=');
    if (i > 0 && c.slice(0, i).trim() === name) return decodeURIComponent(c.slice(i + 1));
  }
  return undefined;
}
