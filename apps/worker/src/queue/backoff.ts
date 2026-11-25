import type { Random } from '../ports.js';

export interface BackoffPolicy {
  /** Ceiling of the first retry's delay. */
  readonly baseMs: number;
  /** No retry waits longer than this, except when the server asks for longer with `Retry-After`. */
  readonly maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 5 * 60_000 };

/**
 * Exponential backoff with full jitter: a uniform delay in [0, min(maxMs, baseMs * 2^(attempt-1))].
 * `attempt` is the number of failed runs so far (1 for the first retry). A server's `Retry-After` is a floor.
 */
export function backoffDelay(
  attempt: number,
  random: Random,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  retryAfterMs?: number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(exponent, 30));
  const jittered = Math.floor(random() * ceiling);
  return Math.max(jittered, retryAfterMs ?? 0);
}
