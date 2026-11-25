/**
 * Minimal interfaces the worker needs from packages that are not built yet (tenancy, agent review queue)
 * and from the runtime (clock, randomness, sleeping). Wire the real implementations at integration.
 */

/** A practice's ID. The practice is the isolation boundary; every job belongs to exactly one practice. */
export type PracticeId = string & { readonly __brand: 'PracticeId' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates and brands a practice ID. Practice IDs are UUIDs (until @scheduler/tenancy exports its own type). */
export function parsePracticeId(value: unknown): PracticeId {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new MissingPracticeContextError('practice ID must be a UUID');
  }
  return value.toLowerCase() as PracticeId;
}

/**
 * Who is enqueueing work, and for which practice. Comes from the authenticated session (a scheduler acting in
 * the app) or from system context (a schedule, a webhook already resolved to a practice).
 */
export type PracticeContext =
  | { readonly kind: 'session'; readonly practiceId: PracticeId; readonly userId: string }
  | { readonly kind: 'system'; readonly practiceId: PracticeId; readonly source: string };

export class MissingPracticeContextError extends Error {
  constructor(detail: string) {
    super(`practice context required: ${detail}`);
    this.name = 'MissingPracticeContextError';
  }
}

/** Throws unless `ctx` is a well-formed practice context. Guards every enqueue and every job run. */
export function assertPracticeContext(ctx: unknown): asserts ctx is PracticeContext {
  if (typeof ctx !== 'object' || ctx === null) throw new MissingPracticeContextError('no context');
  const c = ctx as Record<string, unknown>;
  parsePracticeId(c['practiceId']);
  if (c['kind'] === 'session') {
    if (typeof c['userId'] !== 'string' || c['userId'] === '') {
      throw new MissingPracticeContextError('session context needs a user ID');
    }
    return;
  }
  if (c['kind'] === 'system') {
    if (typeof c['source'] !== 'string' || c['source'] === '') {
      throw new MissingPracticeContextError('system context needs a source');
    }
    return;
  }
  throw new MissingPracticeContextError('context kind must be session or system');
}

/** Wall clock. Injected so backoff, token buckets, leases and schedules are tested without real time. */
export interface Clock {
  now(): Date;
}

/** Uniform random number in [0, 1). Injected so jitter is deterministic in tests. */
export type Random = () => number;

/** Waits `ms` milliseconds, or rejects early when the signal aborts. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** A task for a person, created when a job fails for good. Owned by the review queue (@scheduler/agent). */
export interface HumanTaskRequest {
  readonly practiceId: PracticeId;
  readonly jobId: string;
  readonly jobType: string;
  readonly attempts: number;
  /** A PHI-free error code, e.g. `http_503` or `poll_exhausted`. */
  readonly reason: string;
}

export interface HumanTaskSink {
  createTask(request: HumanTaskRequest): Promise<void>;
}

export const systemClock: Clock = { now: () => new Date() };

export const systemRandom: Random = Math.random;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
