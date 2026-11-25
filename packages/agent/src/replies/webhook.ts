import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock, InboundMessage, PracticeDirectory, WebhookSecrets } from './ports.js';

export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** HMAC-SHA256 (hex) over `${timestamp}.${rawBody}`. */
export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export interface VerifyInput {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  now: Date;
  toleranceSeconds?: number;
}

/** Constant-time compare of the signature; also rejects stale or malformed timestamps (replay). */
export function verifySignature(input: VerifyInput): boolean {
  const { secret, timestamp, signature, rawBody, now } = input;
  if (!secret || !timestamp || !signature) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > tolerance) return false;
  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), 'hex');
  const given = Buffer.from(signature, 'hex');
  // Buffer.from(hex) drops malformed tails, so also require the canonical length.
  if (given.length !== expected.length || signature.length !== expected.length * 2) return false;
  return timingSafeEqual(expected, given);
}

export type ReceiveFailure = 'bad_payload' | 'unknown_number' | 'bad_signature';

export type ReceiveResult = { ok: true; message: InboundMessage } | { ok: false; reason: ReceiveFailure };

export interface ReceiveDeps {
  practices: PracticeDirectory;
  secrets: WebhookSecrets;
  clock: Clock;
}

interface Payload {
  from: string;
  to: string;
  body: string;
  digits?: string | undefined;
  channel: 'sms' | 'voice';
  providerMessageId: string;
}

function parsePayload(rawBody: string): Payload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const o = json as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const from = str(o.from);
  const to = str(o.to);
  const providerMessageId = str(o.messageId);
  if (!from || !to || !providerMessageId) return null;
  const channel = o.channel === 'voice' ? 'voice' : 'sms';
  const digits = typeof o.digits === 'string' ? o.digits : undefined;
  const body = typeof o.body === 'string' ? o.body : '';
  if (channel === 'voice' && digits === undefined) return null;
  return { from, to, body, digits, channel, providerMessageId };
}

/**
 * Verifies and routes a signed inbound webhook. The practice comes only from the receiving number; any
 * practice identifier in the payload is ignored. The secret comes from that practice's vault path.
 */
export async function receiveInbound(
  deps: ReceiveDeps,
  req: { rawBody: string; headers: Record<string, string | undefined> },
): Promise<ReceiveResult> {
  const payload = parsePayload(req.rawBody);
  if (!payload) return { ok: false, reason: 'bad_payload' };
  const practiceId = await deps.practices.practiceIdForNumber(payload.to);
  if (!practiceId) return { ok: false, reason: 'unknown_number' };
  const secret = await deps.secrets.inboundSecret(practiceId);
  const valid =
    secret !== null &&
    verifySignature({
      secret,
      timestamp: req.headers[TIMESTAMP_HEADER],
      signature: req.headers[SIGNATURE_HEADER],
      rawBody: req.rawBody,
      now: deps.clock.now(),
    });
  if (!valid) return { ok: false, reason: 'bad_signature' };
  return {
    ok: true,
    message: {
      practiceId,
      channel: payload.channel,
      from: payload.from,
      to: payload.to,
      body: payload.body,
      digits: payload.digits,
      providerMessageId: payload.providerMessageId,
      receivedAt: deps.clock.now(),
    },
  };
}
