import { assertPracticeContext, systemClock, type Clock, type PracticeContext } from '../ports.js';
import { assertSafeIdempotencyKey, assertSafeJobType } from './guards.js';
import type { Job, JsonValue, QueueStore } from './types.js';

export interface EnqueueRequest {
  readonly type: string;
  /** Same key, same practice: the existing job is returned and nothing new runs. */
  readonly idempotencyKey: string;
  readonly payload?: JsonValue;
  /** Failed runs allowed before the job moves to dead-letter. Default 5. */
  readonly maxAttempts?: number;
  /** Default now. */
  readonly runAt?: Date;
}

export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Enqueues jobs for a practice. The practice comes only from the caller's session or system context, never from
 * the request body, so a job cannot be created without practice context.
 */
export class JobQueue {
  constructor(
    private readonly store: QueueStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async enqueue(ctx: PracticeContext, request: EnqueueRequest): Promise<{ job: Job; created: boolean }> {
    assertPracticeContext(ctx);
    assertSafeJobType(request.type);
    assertSafeIdempotencyKey(request.idempotencyKey);
    const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
    const now = this.clock.now();
    return this.store.enqueue(
      {
        practiceId: ctx.practiceId,
        type: request.type,
        idempotencyKey: request.idempotencyKey,
        payload: request.payload ?? null,
        maxAttempts,
        runAt: request.runAt ?? now,
      },
      now,
    );
  }
}
