import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** HMAC-SHA256 check with a constant-time compare. Length mismatch is rejected without comparing. */
export function verifySignature(secret: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, rawBody), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
