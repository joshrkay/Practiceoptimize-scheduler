import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface GeneratedToken {
  id: string;
  /** `<id>.<secret>`. Shown once to the caller; only `secretHash` is stored. */
  token: string;
  secretHash: string;
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** 256 bits from the OS CSPRNG. */
export function generateToken(): GeneratedToken {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  return { id, token: `${id}.${secret}`, secretHash: hashSecret(secret) };
}

export function parseToken(token: string): { id: string; secret: string } | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.length > 200) return null;
  return { id: token.slice(0, dot), secret: token.slice(dot + 1) };
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Spend comparable time, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function secretMatches(secret: string, storedHash: string): boolean {
  return safeEqual(hashSecret(secret), storedHash);
}
