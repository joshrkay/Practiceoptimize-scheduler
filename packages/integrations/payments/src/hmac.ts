import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmacSha256Hex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Constant-time comparison of a hex HMAC-SHA256 signature. Malformed or wrong-length input is false. */
export function verifyHmacSha256(secret: string, body: string, signatureHex: string | undefined): boolean {
  if (!signatureHex || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const expected = Buffer.from(hmacSha256Hex(secret, body), 'hex');
  const given = Buffer.from(signatureHex, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
