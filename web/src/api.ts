/** Sign-in (Cognito hosted UI, code + PKCE) and API calls. */

interface Config {
  apiBase: string;
  cognitoDomain: string;
  clientId: string;
}

let config: Config;
const KEY = 'stills.auth';

export async function loadConfig(): Promise<Config> {
  config = await (await fetch('/config.json', { cache: 'no-store' })).json();
  return config;
}

interface Tokens {
  id: string;
  refresh?: string;
  exp: number;
}

function read(): Tokens | undefined {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function write(t: Tokens | undefined) {
  try {
    if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: sign-in lasts for this page only */
  }
  memory = t;
}

let memory: Tokens | undefined;

function expOf(jwt: string): number {
  try {
    return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000;
  } catch {
    return 0;
  }
}

const redirectUri = () => `${location.origin}/`;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signInReady(): boolean {
  return !!(config.cognitoDomain && config.clientId);
}

export async function signIn(): Promise<void> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem('stills.pkce', verifier);
  sessionStorage.setItem('stills.return', location.hash);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.href = `${config.cognitoDomain}/oauth2/authorize?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const r = await fetch(`${config.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, ...body }),
  });
  if (!r.ok) throw new Error('Sign-in failed');
  const j = await r.json();
  return { id: j.id_token, refresh: j.refresh_token ?? body.refresh_token, exp: expOf(j.id_token) };
}

/** Finishes a sign-in redirect if there is one. */
export async function completeSignIn(): Promise<void> {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return;
  const verifier = sessionStorage.getItem('stills.pkce') ?? '';
  write(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }));
  const back = sessionStorage.getItem('stills.return') ?? '';
  history.replaceState(null, '', `/${back}`);
}

async function token(): Promise<string | undefined> {
  let t = memory ?? read();
  if (t && t.exp - Date.now() < 60_000 && t.refresh) {
    try {
      t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
      write(t);
    } catch {
      write(undefined);
      t = undefined;
    }
  }
  return t && t.exp > Date.now() ? t.id : undefined;
}

export function signOut() {
  write(undefined);
  if (config.cognitoDomain) {
    location.href = `${config.cognitoDomain}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri() })}`;
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const t = await token();
  if (!t) {
    if (signInReady()) await signIn();
    throw new ApiError(401, 'Please sign in');
  }
  const r = await fetch(`${config.apiBase}${path}`, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j.error ?? `Request failed (${r.status})`);
  return j as T;
}

export async function isSignedIn(): Promise<boolean> {
  return !!(await token());
}
