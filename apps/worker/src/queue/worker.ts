import {
  parsePracticeId,
  realSleep,
  systemClock,
  systemRandom,
  type Clock,
  type HumanTaskSink,
  type PracticeId,
  type Random,
  type Sleep,
} from '../ports.js';
import { DEFAULT_WORKER_CONFIG } from '../config.js';
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.js';
import { classifyFailure } from './errors.js';
import type { PracticeRateLimiter } from './token-bucket.js';
import type { Job, JsonValue, QueueStore } from './types.js';

export interface JobRunContext {
  /** The practice the job belongs to. Handlers must scope every read and write to it. */
  readonly practiceId: PracticeId;
  readonly job: Job;
  /** Progress saved by an earlier run of this job, or null on the first run. */
  readonly checkpoint: JsonValue | null;
  readonly now: Date;
}

export type JobOutcome =
  | { readonly kind: 'complete'; readonly result?: JsonValue }
  /** Run again after `delayMs` without counting a failure (e.g. the next poll). */
  | { readonly kind: 'reschedule'; readonly delayMs: number; readonly checkpoint?: JsonValue | null };

/** Returning nothing completes the job with a null result. Throwing counts a failed run (see errors.ts). */
export type JobHandler = (ctx: JobRunContext) => Promise<JobOutcome | void>;

export interface WorkerOptions {
  readonly store: QueueStore;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly humanTasks: HumanTaskSink;
  readonly clock?: Clock;
  readonly random?: Random;
  /** Most jobs this worker runs per tick. Default 8. */
  readonly capacity?: number;
  readonly maxConcurrencyPerPractice?: number;
  /** How long a claim is held before another worker may take the job back. Default 5 minutes. */
  readonly leaseMs?: number;
  readonly backoff?: BackoffPolicy;
  /** Per-practice token buckets; a practice with no tokens is skipped and its claimed jobs deferred. */
  readonly rateLimiter?: PracticeRateLimiter;
}

export interface TickReport {
  claimed: number;
  succeeded: number;
  rescheduled: number;
  retried: number;
  dead: number;
  /** Claimed but put back because the practice was out of rate-limit tokens. */
  deferred: number;
  /** The lease expired before the outcome was saved; another worker owns the job now. */
  lostLease: number;
}

type RunResult = keyof TickReport;

/**
 * Claims jobs fairly across practices and runs them. A job whose practice ID is missing or malformed never
 * reaches its handler.
 */
export class Worker {
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly capacity: number;
  private readonly maxConcurrencyPerPractice: number;
  private readonly leaseMs: number;
  private readonly backoff: BackoffPolicy;

  constructor(private readonly options: WorkerOptions) {
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
    this.capacity = options.capacity ?? 8;
    this.maxConcurrencyPerPractice = options.maxConcurrencyPerPractice ?? DEFAULT_WORKER_CONFIG.maxConcurrencyPerPractice;
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
  }

  /** One round: return expired leases to the queue, claim up to `capacity` jobs, run them all. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { claimed: 0, succeeded: 0, rescheduled: 0, retried: 0, dead: 0, deferred: 0, lostLease: 0 };
    const { dead } = await this.options.store.reclaimExpired(this.clock.now());
    for (const job of dead) {
      report.dead += 1;
      await this.raiseHumanTask(job, 'lease_expired');
    }
    const claimed = await this.options.store.claim({
      now: this.clock.now(),
      limit: this.capacity,
      maxRunningPerPractice: this.maxConcurrencyPerPractice,
      excludePracticeIds: this.options.rateLimiter?.exhaustedPractices() ?? [],
      leaseMs: this.leaseMs,
    });
    report.claimed = claimed.length;
    const results = await Promise.all(claimed.map((job) => this.runOne(job)));
    for (const r of results) report[r] += 1;
    return report;
  }

  /** Ticks until `signal` aborts, sleeping `idleMs` whenever a tick finds no work. */
  async run(signal: AbortSignal, idleMs = 1_000, sleep: Sleep = realSleep): Promise<void> {
    while (!signal.aborted) {
      const report = await this.tick();
      if (report.claimed > 0) continue;
      try {
        await sleep(idleMs, signal);
      } catch {
        return;
      }
    }
  }

  private async runOne(job: Job): Promise<RunResult> {
    const { store, rateLimiter } = this.options;
    const lease = job.leaseToken as string;
    let practiceId: PracticeId;
    try {
      practiceId = parsePracticeId(job.practiceId);
    } catch {
      return this.failed(job, lease, 'missing_practice_context', false, undefined);
    }
    if (rateLimiter && !rateLimiter.tryTake(practiceId)) {
      const runAt = new Date(this.clock.now().getTime() + Math.max(1, rateLimiter.msUntilAvailable(practiceId)));
      const ok = await store.reschedule(job.id, lease, runAt, undefined, this.clock.now());
      return ok ? 'deferred' : 'lostLease';
    }
    const handler = this.options.handlers[job.type];
    if (!handler) return this.failed(job, lease, 'unknown_job_type', false, undefined);

    let outcome: JobOutcome | void;
    try {
      outcome = await handler({ practiceId, job, checkpoint: job.checkpoint, now: this.clock.now() });
    } catch (error) {
      const failure = classifyFailure(error);
      return this.failed(job, lease, failure.code, failure.retryable, failure.retryAfterMs);
    }
    const now = this.clock.now();
    if (outcome && outcome.kind === 'reschedule') {
      const runAt = new Date(now.getTime() + Math.max(0, outcome.delayMs));
      const ok = await store.reschedule(job.id, lease, runAt, outcome.checkpoint, now);
      return ok ? 'rescheduled' : 'lostLease';
    }
    const ok = await store.complete(job.id, lease, outcome?.result ?? null, now);
    return ok ? 'succeeded' : 'lostLease';
  }

  private async failed(
    job: Job,
    lease: string,
    code: string,
    retryable: boolean,
    retryAfterMs: number | undefined,
  ): Promise<RunResult> {
    const now = this.clock.now();
    const attempts = job.attempts + 1;
    const dead = !retryable || attempts >= job.maxAttempts;
    const retryAt = dead
      ? null
      : new Date(now.getTime() + backoffDelay(attempts, this.random, this.backoff, retryAfterMs));
    const ok = await this.options.store.fail(job.id, lease, { now, error: code, retryAt });
    if (!ok) return 'lostLease';
    if (!dead) return 'retried';
    await this.raiseHumanTask({ ...job, attempts }, code);
    return 'dead';
  }

  private async raiseHumanTask(job: Job, reason: string): Promise<void> {
    try {
      await this.options.humanTasks.createTask({
        practiceId: job.practiceId,
        jobId: job.id,
        jobType: job.type,
        attempts: job.attempts,
        reason,
      });
    } catch {
      // The job stays in dead-letter, so it can be found and raised again; log IDs only, never payloads.
      console.error(`worker: could not create human task for dead job ${job.id} (${job.type})`);
    }
  }
}
