import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeClock, InMemoryHumanTaskSink, sequenceRandom } from '../fakes.js';
import type { HumanTaskSink } from '../ports.js';
import { HttpStatusError, PermanentJobError } from './errors.js';
import { JobQueue } from './job-queue.js';
import { InMemoryQueueStore } from './memory-store.js';
import { PRACTICE_A, PRACTICE_B, systemCtx } from './testing/store-contract.js';
import { PracticeRateLimiter } from './token-bucket.js';
import type { QueueStore } from './types.js';
import { Worker, type JobHandler, type WorkerOptions } from './worker.js';

function setup(handlers: Record<string, JobHandler>, overrides: Partial<WorkerOptions> = {}) {
  const clock = new FakeClock('2026-01-05T12:00:00.000Z');
  const store = new InMemoryQueueStore();
  const humanTasks = new InMemoryHumanTaskSink();
  const queue = new JobQueue(store, clock);
  const worker = new Worker({
    store,
    clock,
    humanTasks,
    handlers,
    random: sequenceRandom([0.5]),
    backoff: { baseMs: 1_000, maxMs: 60_000 },
    ...overrides,
  });
  return { clock, store, humanTasks, queue, worker };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Worker', () => {
  it('runs a job and stores its result', async () => {
    const { worker, queue, store } = setup({ 'test.echo': async ({ job }) => ({ kind: 'complete', result: job.payload }) });
    const { job } = await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.echo', idempotencyKey: 'e1', payload: { caseId: 'c-1' } });
    expect(await worker.tick()).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await store.get(PRACTICE_A, job.id)).toMatchObject({ status: 'succeeded', result: { caseId: 'c-1' } });
  });

  it('passes the practice to the handler and runs a duplicate enqueue only once', async () => {
    const seen: string[] = [];
    const { worker, queue } = setup({ 'test.work': async ({ practiceId }) => void seen.push(practiceId) });
    await queue.enqueue(systemCtx(PRACTICE_B), { type: 'test.work', idempotencyKey: 'same' });
    await queue.enqueue(systemCtx(PRACTICE_B), { type: 'test.work', idempotencyKey: 'same' });
    await worker.tick();
    await worker.tick();
    expect(seen).toEqual([PRACTICE_B]);
  });

  it('retries 429 and 5xx with exponential backoff and jitter, honouring Retry-After', async () => {
    const errors = [new HttpStatusError(503), new HttpStatusError(502), new HttpStatusError(429, 30_000)];
    const { worker, queue, store, clock } = setup(
      {
        'test.flaky': async () => {
          const e = errors.shift();
          if (e) throw e;
          return { kind: 'complete', result: 'ok' };
        },
      },
      { random: sequenceRandom([0.5, 0.25, 0.1]) },
    );
    const { job } = await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.flaky', idempotencyKey: 'f1', maxAttempts: 5 });
    const start = clock.now().getTime();
    const runAts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      expect(await worker.tick()).toMatchObject({ retried: 1 });
      const j = await store.get(PRACTICE_A, job.id);
      runAts.push(j!.runAt.getTime() - clock.now().getTime());
      expect(await worker.tick()).toMatchObject({ claimed: 0 });
      clock.set(j!.runAt);
    }
    // attempt 1: 0.5 * 1000; attempt 2: 0.25 * 2000; attempt 3: max(0.1 * 4000, Retry-After 30s)
    expect(runAts).toEqual([500, 500, 30_000]);
    expect(await worker.tick()).toMatchObject({ succeeded: 1 });
    expect(await store.get(PRACTICE_A, job.id)).toMatchObject({ status: 'succeeded', attempts: 3, lastError: 'http_429' });
    expect(clock.now().getTime() - start).toBe(31_000);
  });

  it('dead-letters after max attempts and creates one human task', async () => {
    const { worker, queue, store, humanTasks, clock } = setup({
      'test.down': async () => {
        throw new Error('socket hang up for synthetic patient');
      },
    });
    const { job } = await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.down', idempotencyKey: 'd1', maxAttempts: 2 });
    expect(await worker.tick()).toMatchObject({ retried: 1 });
    clock.advance(60_000);
    expect(await worker.tick()).toMatchObject({ dead: 1 });
    expect(await store.get(PRACTICE_A, job.id)).toMatchObject({ status: 'dead', attempts: 2, lastError: 'error' });
    expect(humanTasks.tasks).toEqual([
      { practiceId: PRACTICE_A, jobId: job.id, jobType: 'test.down', attempts: 2, reason: 'error' },
    ]);
    // No error message (which could hold PHI) reaches the job or the task.
    expect(JSON.stringify([await store.get(PRACTICE_A, job.id), humanTasks.tasks])).not.toContain('patient');
  });

  it('dead-letters permanent failures (4xx, PermanentJobError, unknown type) without retrying', async () => {
    const { worker, queue, humanTasks } = setup({
      'test.bad_request': async () => {
        throw new HttpStatusError(422);
      },
      'test.permanent': async () => {
        throw new PermanentJobError('not_eligible');
      },
      'test.weird_code': async () => {
        throw new PermanentJobError('Bad Code With Spaces');
      },
    });
    for (const type of ['test.bad_request', 'test.permanent', 'test.weird_code', 'test.unregistered']) {
      await queue.enqueue(systemCtx(PRACTICE_A), { type, idempotencyKey: type, maxAttempts: 5 });
    }
    expect(await worker.tick()).toMatchObject({ claimed: 2, dead: 2 });
    expect(await worker.tick()).toMatchObject({ claimed: 2, dead: 2 });
    const tasks = humanTasks.tasks.map((t) => [t.jobType, t.reason, t.attempts]);
    expect(tasks.sort()).toEqual([
      ['test.bad_request', 'http_422', 1],
      ['test.permanent', 'not_eligible', 1],
      ['test.unregistered', 'unknown_job_type', 1],
      ['test.weird_code', 'permanent', 1],
    ]);
  });

  it('never runs a job that lacks practice context', async () => {
    const handler = vi.fn(async () => undefined);
    const store = new InMemoryQueueStore();
    const clock = new FakeClock();
    const humanTasks = new InMemoryHumanTaskSink();
    // Simulate a corrupted row: the store hands back a job with no practice ID.
    await store.enqueue(
      { practiceId: '' as never, type: 'test.work', idempotencyKey: 'x', payload: null, maxAttempts: 3, runAt: clock.now() },
      clock.now(),
    );
    const worker = new Worker({ store, clock, humanTasks, handlers: { 'test.work': handler } });
    expect(await worker.tick()).toMatchObject({ claimed: 1, dead: 1 });
    expect(handler).not.toHaveBeenCalled();
    expect(humanTasks.tasks[0]?.reason).toBe('missing_practice_context');
  });

  it('reschedules without counting a failure', async () => {
    const { worker, queue, store, clock } = setup({
      'test.steps': async ({ checkpoint }) =>
        checkpoint === null ? { kind: 'reschedule', delayMs: 5_000, checkpoint: { step: 2 } } : { kind: 'complete', result: checkpoint },
    });
    const { job } = await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.steps', idempotencyKey: 's1' });
    expect(await worker.tick()).toMatchObject({ rescheduled: 1 });
    clock.advance(4_999);
    expect(await worker.tick()).toMatchObject({ claimed: 0 });
    clock.advance(1);
    expect(await worker.tick()).toMatchObject({ succeeded: 1 });
    expect(await store.get(PRACTICE_A, job.id)).toMatchObject({ attempts: 0, result: { step: 2 } });
  });

  it('reclaims jobs from a crashed worker and raises a task when they run out of attempts', async () => {
    const { store, clock, humanTasks, queue } = setup({});
    const { job } = await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.work', idempotencyKey: 'c1', maxAttempts: 1 });
    await store.claim({ now: clock.now(), limit: 1, maxRunningPerPractice: 1, excludePracticeIds: [], leaseMs: 1_000 });
    clock.advance(1_000);
    const worker = new Worker({ store, clock, humanTasks, handlers: {} });
    expect(await worker.tick()).toMatchObject({ dead: 1, claimed: 0 });
    expect(humanTasks.tasks).toEqual([expect.objectContaining({ jobId: job.id, reason: 'lease_expired' })]);
  });

  it('reports a lost lease when the outcome cannot be saved', async () => {
    const { queue, store, clock, humanTasks } = setup({});
    const lossy: QueueStore = {
      enqueue: (job, now) => store.enqueue(job, now),
      claim: (options) => store.claim(options),
      reclaimExpired: (now) => store.reclaimExpired(now),
      get: (practiceId, jobId) => store.get(practiceId, jobId),
      list: (practiceId, status) => store.list(practiceId, status),
      complete: async () => false,
      reschedule: async () => false,
      fail: async () => false,
    };
    const worker = new Worker({
      store: lossy,
      clock,
      humanTasks,
      maxConcurrencyPerPractice: 3,
      handlers: {
        'test.ok': async () => undefined,
        'test.later': async () => ({ kind: 'reschedule', delayMs: 1 }),
        'test.boom': async () => {
          throw new Error('x');
        },
      },
    });
    for (const type of ['test.ok', 'test.later', 'test.boom']) {
      await queue.enqueue(systemCtx(PRACTICE_A), { type, idempotencyKey: type });
    }
    expect(await worker.tick()).toMatchObject({ claimed: 3, lostLease: 3 });
    expect(humanTasks.tasks).toEqual([]);
  });

  it('keeps the job in dead-letter when the human task cannot be created', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failingSink: HumanTaskSink = { createTask: async () => Promise.reject(new Error('review queue down')) };
    const { queue, store } = setup({});
    const clock = new FakeClock();
    const worker = new Worker({ store, clock, humanTasks: failingSink, handlers: {} });
    const { job } = await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.missing', idempotencyKey: 'm1' });
    expect(await worker.tick()).toMatchObject({ dead: 1 });
    expect((await store.get(PRACTICE_A, job.id))?.status).toBe('dead');
    expect(error).toHaveBeenCalledWith(expect.stringContaining(job.id));
  });

  describe('rate limits', () => {
    it("throttles a practice that is out of tokens while others keep running", async () => {
      const clock = new FakeClock();
      const limiter = new PracticeRateLimiter({ capacity: 2, refillPerSecond: 1 }, clock);
      const ran: string[] = [];
      const { queue, store } = setup({});
      const worker = new Worker({
        store,
        clock,
        humanTasks: new InMemoryHumanTaskSink(),
        handlers: { 'test.call': async ({ practiceId }) => void ran.push(practiceId) },
        capacity: 10,
        maxConcurrencyPerPractice: 5,
        rateLimiter: limiter,
      });
      for (let i = 0; i < 6; i += 1) await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.call', idempotencyKey: `a${i}` });
      for (let i = 0; i < 2; i += 1) await queue.enqueue(systemCtx(PRACTICE_B), { type: 'test.call', idempotencyKey: `b${i}` });

      // Tick 1: A gets its burst of 2, the other 3 claimed A jobs are deferred 1 second; B runs both.
      expect(await worker.tick()).toMatchObject({ claimed: 7, succeeded: 4, deferred: 3 });
      expect(ran.filter((p) => p === PRACTICE_B)).toHaveLength(2);
      // A's bucket is empty, so A is not even claimed until it refills.
      expect(await worker.tick()).toMatchObject({ claimed: 0 });
      clock.advance(1_000);
      expect(await worker.tick()).toMatchObject({ claimed: 4, succeeded: 1, deferred: 3 });
      expect(ran.filter((p) => p === PRACTICE_A)).toHaveLength(3);
      expect(await store.list(PRACTICE_A, 'queued')).toHaveLength(3);
    });
  });

  it('run() ticks until aborted and sleeps only when idle', async () => {
    const controller = new AbortController();
    const sleeps: number[] = [];
    let calls = 0;
    const { queue, store, clock } = setup({});
    const worker = new Worker({
      store,
      clock,
      humanTasks: new InMemoryHumanTaskSink(),
      handlers: {
        'test.work': async () => {
          calls += 1;
        },
      },
    });
    await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.work', idempotencyKey: 'r1' });
    const sleep = async (ms: number, signal?: AbortSignal) => {
      sleeps.push(ms);
      if (sleeps.length === 1) {
        await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.work', idempotencyKey: 'r2' });
        return;
      }
      controller.abort(new Error('stop'));
      throw signal?.reason;
    };
    await worker.run(controller.signal, 250, sleep);
    expect(calls).toBe(2);
    expect(sleeps).toEqual([250, 250]);
  });

  it('run() returns at once when already aborted', async () => {
    const { worker } = setup({});
    const controller = new AbortController();
    controller.abort();
    await expect(worker.run(controller.signal)).resolves.toBeUndefined();
  });
});
