import { describe, expect, it } from 'vitest';
import { FakeClock, sequenceRandom } from '../fakes.js';
import { backoffDelay } from './backoff.js';
import { classifyFailure, HttpStatusError, isRetryableStatus, parseRetryAfter, PermanentJobError } from './errors.js';
import { assertSafeIdempotencyKey, assertSafeJobType, UnsafeQueueMetadataError } from './guards.js';
import { JobQueue } from './job-queue.js';
import { InMemoryQueueStore } from './memory-store.js';
import { PRACTICE_A, PRACTICE_B } from './testing/store-contract.js';
import { PracticeRateLimiter, TokenBucket } from './token-bucket.js';

describe('backoffDelay', () => {
  const policy = { baseMs: 1_000, maxMs: 10_000 };
  it('grows exponentially with full jitter and a cap', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, () => 0.999, policy))).toEqual([999, 1998, 3996, 7992, 9990, 9990]);
    expect(backoffDelay(3, () => 0, policy)).toBe(0);
    expect(backoffDelay(0, () => 0.5, policy)).toBe(500);
    expect(backoffDelay(1_000, () => 0.5, policy)).toBe(5_000);
  });
  it('waits at least as long as Retry-After', () => {
    expect(backoffDelay(1, () => 0.5, policy, 45_000)).toBe(45_000);
    expect(backoffDelay(4, () => 0.5, policy, 100)).toBe(4_000);
  });
  it('uses the default policy', () => {
    expect(backoffDelay(1, () => 0.5)).toBe(500);
  });
});

describe('failure classification', () => {
  it('retries 429 and 5xx, not other 4xx', () => {
    expect([200, 400, 404, 429, 500, 503, 599, 600].map(isRetryableStatus)).toEqual([
      false, false, false, true, true, true, true, false,
    ]);
    expect(classifyFailure(new HttpStatusError(429, 5_000))).toEqual({ retryable: true, code: 'http_429', retryAfterMs: 5_000 });
    expect(classifyFailure(new HttpStatusError(409))).toEqual({ retryable: false, code: 'http_409', retryAfterMs: undefined });
  });
  it('fails permanent errors for good and retries unknown errors', () => {
    expect(classifyFailure(new PermanentJobError('no_coverage'))).toMatchObject({ retryable: false, code: 'no_coverage' });
    expect(classifyFailure(new PermanentJobError('Patient Jane'))).toMatchObject({ code: 'permanent' });
    expect(classifyFailure(new TypeError('boom'))).toEqual({ retryable: true, code: 'error', retryAfterMs: undefined });
    expect(classifyFailure('string thrown')).toMatchObject({ retryable: true });
  });
  it('parses Retry-After seconds and dates', () => {
    const now = new Date('2026-01-05T12:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Mon, 05 Jan 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Mon, 05 Jan 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(' ', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('queue metadata guards', () => {
  it('accepts machine identifiers', () => {
    expect(() => assertSafeJobType('availity.prior_auth.submit')).not.toThrow();
    expect(() => assertSafeIdempotencyKey('case:3f2b8c1e-0000-4000-8000-000000000001:submit')).not.toThrow();
    expect(() => assertSafeIdempotencyKey('schedule:nightly:2026-03-02T08:00:00.000Z')).not.toThrow();
  });
  it('rejects anything that could carry PHI', () => {
    for (const t of ['Prior auth Jane Doe', 'auth.JaneDoe', 'a'.repeat(101), '.x', 'x..y']) {
      expect(() => assertSafeJobType(t), t).toThrow(UnsafeQueueMetadataError);
    }
    for (const k of ['jane.doe@example.com', 'Jane Doe', 'member:123456789', 'ssn:123-45-6789', 'phone:555-010-1234', 'k'.repeat(201), '']) {
      expect(() => assertSafeIdempotencyKey(k), k).toThrow(UnsafeQueueMetadataError);
    }
  });
});

describe('token buckets', () => {
  it('allows a burst, then refills at the configured rate', () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2 }, clock);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    expect(bucket.msUntil()).toBe(500);
    clock.advance(499);
    expect(bucket.tryTake()).toBe(false);
    clock.advance(1);
    expect(bucket.tryTake()).toBe(true);
    clock.advance(60_000);
    expect(bucket.available()).toBe(3);
    expect(bucket.msUntil()).toBe(0);
    expect(bucket.tryTake(4)).toBe(false);
  });
  it('rejects nonsense configuration', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 }, new FakeClock())).toThrow();
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 }, new FakeClock())).toThrow();
  });
  it('keeps one bucket per practice, with overrides', () => {
    const clock = new FakeClock();
    const limiter = new PracticeRateLimiter({ capacity: 1, refillPerSecond: 1 }, clock, new Map([[PRACTICE_B, { capacity: 3, refillPerSecond: 1 }]]));
    expect(limiter.tryTake(PRACTICE_A)).toBe(true);
    expect(limiter.tryTake(PRACTICE_A)).toBe(false);
    expect(limiter.exhaustedPractices()).toEqual([PRACTICE_A]);
    expect([limiter.tryTake(PRACTICE_B), limiter.tryTake(PRACTICE_B), limiter.tryTake(PRACTICE_B)]).toEqual([true, true, true]);
    expect(limiter.msUntilAvailable(PRACTICE_A)).toBe(1_000);
  });
});

describe('JobQueue', () => {
  const store = new InMemoryQueueStore();
  const queue = new JobQueue(store, new FakeClock());
  it('requires practice context from a session or the system', async () => {
    const req = { type: 'test.work', idempotencyKey: 'q1' };
    await expect(queue.enqueue(undefined as never, req)).rejects.toThrow(/practice context/);
    await expect(queue.enqueue({ kind: 'system', source: 'x' } as never, req)).rejects.toThrow(/practice context/);
    await expect(queue.enqueue({ kind: 'session', practiceId: PRACTICE_A, userId: '' }, req)).rejects.toThrow(/user ID/);
    await expect(queue.enqueue({ kind: 'system', practiceId: PRACTICE_A, source: '' }, req)).rejects.toThrow(/source/);
    await expect(queue.enqueue({ kind: 'robot', practiceId: PRACTICE_A } as never, req)).rejects.toThrow(/kind/);
    const { job } = await queue.enqueue({ kind: 'session', practiceId: PRACTICE_A, userId: 'user-syn-1' }, req);
    expect(job).toMatchObject({ practiceId: PRACTICE_A, payload: null, maxAttempts: 5 });
  });
  it('validates metadata and attempts', async () => {
    const ctx = { kind: 'system', practiceId: PRACTICE_A, source: 'test' } as const;
    await expect(queue.enqueue(ctx, { type: 'Bad Type', idempotencyKey: 'q2' })).rejects.toThrow(UnsafeQueueMetadataError);
    await expect(queue.enqueue(ctx, { type: 'test.work', idempotencyKey: 'q2', maxAttempts: 0 })).rejects.toThrow(/maxAttempts/);
  });
});

describe('sequenceRandom', () => {
  it('cycles and refuses an empty sequence', () => {
    const r = sequenceRandom([0.1, 0.2]);
    expect([r(), r(), r()]).toEqual([0.1, 0.2, 0.1]);
    expect(() => sequenceRandom([])).toThrow();
  });
});
