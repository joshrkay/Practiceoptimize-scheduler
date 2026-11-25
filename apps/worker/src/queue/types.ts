import type { PracticeId } from '../ports.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * - `queued`: waiting for `runAt`.
 * - `running`: claimed by a worker that holds `leaseToken` until `leaseExpiresAt`.
 * - `succeeded`: finished; `result` holds the output.
 * - `dead`: failed for good (dead-letter); a human task was requested.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';

export interface Job {
  readonly id: string;
  readonly practiceId: PracticeId;
  /** Handler name, e.g. `availity.prior_auth.submit`. Never contains PHI. */
  readonly type: string;
  /** Unique per practice; enqueueing the same key again returns the existing job. Never contains PHI. */
  readonly idempotencyKey: string;
  /** Handler input. Carry record IDs, not PHI; the handler loads what it needs. Never logged. */
  readonly payload: JsonValue;
  /** Handler progress saved between runs (e.g. a poll location). */
  readonly checkpoint: JsonValue | null;
  readonly status: JobStatus;
  /** Failed runs so far. Reschedules (polling, rate-limit deferrals) do not count. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: Date;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly result: JsonValue | null;
  /** PHI-free error code from the latest failure, e.g. `http_429`. */
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface NewJob {
  readonly practiceId: PracticeId;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly maxAttempts: number;
  readonly runAt: Date;
}

export interface ClaimOptions {
  readonly now: Date;
  /** Most jobs to claim in total. */
  readonly limit: number;
  /** A practice never has more than this many `running` jobs after the claim. */
  readonly maxRunningPerPractice: number;
  /** Practices to skip this round (e.g. out of rate-limit tokens). */
  readonly excludePracticeIds: readonly PracticeId[];
  readonly leaseMs: number;
}

export interface FailOptions {
  readonly now: Date;
  readonly error: string;
  /** When to retry; `null` moves the job to `dead`. */
  readonly retryAt: Date | null;
}

/**
 * Durable job storage. Implementations must:
 * - make `enqueue` idempotent on (practiceId, idempotencyKey);
 * - make `claim` fair: take the oldest ready job of every eligible practice before a second job of any practice;
 * - apply `complete`, `reschedule` and `fail` only while the caller still holds the lease (returns false otherwise).
 */
export interface QueueStore {
  enqueue(job: NewJob, now: Date): Promise<{ job: Job; created: boolean }>;
  claim(options: ClaimOptions): Promise<Job[]>;
  complete(jobId: string, leaseToken: string, result: JsonValue | null, now: Date): Promise<boolean>;
  /** Puts a running job back in the queue without counting a failure. `checkpoint` undefined keeps the old one. */
  reschedule(
    jobId: string,
    leaseToken: string,
    runAt: Date,
    checkpoint: JsonValue | null | undefined,
    now: Date,
  ): Promise<boolean>;
  /** Counts a failed run; requeues at `retryAt` or moves the job to `dead`. */
  fail(jobId: string, leaseToken: string, options: FailOptions): Promise<boolean>;
  /**
   * Returns jobs whose lease expired (worker crashed) to the queue, counting a failed run. Jobs that reach
   * `maxAttempts` this way move to `dead` and are returned so the caller can raise human tasks.
   */
  reclaimExpired(now: Date): Promise<{ requeued: number; dead: Job[] }>;
  get(practiceId: PracticeId, jobId: string): Promise<Job | null>;
  list(practiceId: PracticeId, status?: JobStatus): Promise<Job[]>;
}
