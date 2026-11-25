import { createHash, randomUUID } from 'node:crypto';
import type { AuditEvent, AuditEventInput, AuditSink } from './types.js';

export const DEFAULT_AUDIT_RETENTION_YEARS = 6;

export function auditRetentionYears(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env['AUDIT_RETENTION_YEARS']);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_AUDIT_RETENTION_YEARS;
}

export class AuditWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AuditWriteError';
  }
}

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** SHA-256 of canonical (key-sorted) JSON, hex. */
export function hashInputs(inputs: unknown): string {
  return createHash('sha256').update(canonical(inputs)).digest('hex');
}

export function buildAuditEvent(
  input: AuditEventInput,
  now: () => Date = () => new Date(),
): AuditEvent {
  const { inputs, ...rest } = input;
  return Object.freeze({
    ...rest,
    actor: Object.freeze({ ...input.actor }),
    target: Object.freeze({ ...input.target }),
    id: randomUUID(),
    inputsHash: hashInputs(inputs),
    occurredAt: now().toISOString(),
  });
}

/** Writes one event. Throws AuditWriteError if the sink fails. */
export async function recordAudit(
  sink: AuditSink,
  input: AuditEventInput,
  now?: () => Date,
): Promise<AuditEvent> {
  const event = buildAuditEvent(input, now);
  try {
    await sink.append(event);
  } catch (cause) {
    throw new AuditWriteError('audit write failed', { cause });
  }
  return event;
}

export type AuditBase = Omit<AuditEventInput, 'result' | 'externalTransactionId'> & {
  readonly externalTransactionId?: string | null;
};

/**
 * Runs an action and writes its audit event before returning. If the audit
 * write fails the call rejects with AuditWriteError and the action's result is
 * not returned. If the action throws, a `failure` event is written and the
 * original error is rethrown (an audit failure takes precedence).
 */
export async function withAudit<T>(
  sink: AuditSink,
  base: AuditBase,
  action: () => Promise<{ value: T; externalTransactionId?: string | null }>,
  now?: () => Date,
): Promise<T> {
  let outcome: { value: T; externalTransactionId?: string | null };
  try {
    outcome = await action();
  } catch (error) {
    await recordAudit(
      sink,
      { ...base, result: 'failure', externalTransactionId: base.externalTransactionId ?? null },
      now,
    );
    throw error;
  }
  await recordAudit(
    sink,
    {
      ...base,
      result: 'success',
      externalTransactionId: outcome.externalTransactionId ?? base.externalTransactionId ?? null,
    },
    now,
  );
  return outcome.value;
}
