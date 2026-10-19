import { randomBytes } from 'node:crypto';

const B32 = '0123456789abcdefghjkmnpqrstvwxyz';

/** Time-ordered id, e.g. st_01k2...: sorts by creation, which keeps albums in upload order. */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(8);
  let r = '';
  for (const b of rand) r += B32[b % 32];
  return `${prefix}_${time}${r}`;
}

/** Unguessable token for gallery links. 144 bits. */
export function newToken(): string {
  return randomBytes(18).toString('base64url');
}

export const ID_PATTERN = /^[a-z]{1,8}_[0-9a-z_-]{6,64}$/;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
