/** Behaviour every QueueStore must have. Run against each implementation from its own test file. */
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, InMemoryHumanTaskSink, sequenceRandom } from '../../fakes.js';
import { parsePracticeId, type PracticeContext, type PracticeId } from '../../ports.js';
import { JobQueue } from '../job-queue.js';
import type { NewJob, QueueStore } from '../types.js';
import { Worker } from '../worker.js';

export const PRACTICE_A = parsePracticeId('0a0a0a0a-0000-4000-8000-00000000000a');
export const PRACTICE_B = parsePracticeId('0b0b0b0b-0000-4000-8000-00000000000b');
export const PRACTICE_C = parsePracticeId('0c0c0c0c-0000-4000-8000-00000000000c');

export const systemCtx = (practiceId: PracticeId): PracticeContext => ({
  kind: 'system',
  practiceId,
  source: 'test',
});

const T0 = new Date('2026-01-05T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function newJob(practiceId: PracticeId, key: string, overrides: Partial<NewJob> = {}): NewJob {
  return { practiceId, type: 'test.noop', idempotencyKey: key, payload: { n: key }, maxAttempts: 3, runAt: T0, ...overrides };
}

const claimAll = (store: QueueStore, overrides: Partial<Parameters<QueueStore['claim']>[0]> = {}) =>
  store.claim({ now: T0, limit: 100, maxRunningPerPractice: 100, excludePracticeIds: [], leaseMs: 60_000, ...overrides });

export function queueStoreContract(name: string, makeStore: () => Promise<QueueStore>): void {
  describe(`${name} (QueueStore contract)`, () => {
    let store: QueueStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    it('enqueues idempotently per practice and key', async () => {
      const first = await store.enqueue(newJob(PRACTICE_A, 'k1'), T0);
      const again = await store.enqueue(newJob(PRACTICE_A, 'k1', { payload: { changed: true } }), at(5));
      const otherPractice = await store.enqueue(newJob(PRACTICE_B, 'k1'), T0);
      expect(first.created).toBe(true);
      expect(again.created).toBe(false);
      expect(again.job.id).toBe(first.job.id);
      expect(again.job.payload).toEqual({ n: 'k1' });
      expect(otherPractice.created).toBe(true);
      expect(first.job).toMatchObject({ status: 'queued', attempts: 0, practiceId: PRACTICE_A, checkpoint: null });
    });

    it('claims round-robin: oldest job of every practice before a second job of any', async () => {
      for (const k of ['a1', 'a2', 'a3']) await store.enqueue(newJob(PRACTICE_A, k), T0);
      await store.enqueue(newJob(PRACTICE_B, 'b1', { runAt: at(10) }), T0);
      const claimed = await claimAll(store, { now: at(10), limit: 2, maxRunningPerPractice: 2 });
      expect(claimed.map((j) => j.idempotencyKey).sort()).toEqual(['a1', 'b1']);
      const next = await claimAll(store, { now: at(10), limit: 5, maxRunningPerPractice: 2 });
      expect(next.map((j) => j.idempotencyKey)).toEqual(['a2']);
      for (const j of claimed) {
        expect(j.status).toBe('running');
        expect(j.leaseToken).toEqual(expect.any(String));
        expect(j.leaseExpiresAt).toEqual(at(60_010));
      }
    });

    it('never lets a practice exceed its running limit across claims', async () => {
      for (const k of ['a1', 'a2', 'a3', 'a4']) await store.enqueue(newJob(PRACTICE_A, k), T0);
      expect(await claimAll(store, { maxRunningPerPractice: 2 })).toHaveLength(2);
      expect(await claimAll(store, { maxRunningPerPractice: 2 })).toHaveLength(0);
    });

    it('skips excluded practices, future jobs, and zero limits', async () => {
      await store.enqueue(newJob(PRACTICE_A, 'a1'), T0);
      await store.enqueue(newJob(PRACTICE_B, 'b1', { runAt: at(1_000) }), T0);
      expect(await claimAll(store, { excludePracticeIds: [PRACTICE_A] })).toEqual([]);
      expect(await claimAll(store, { limit: 0 })).toEqual([]);
      const claimed = await claimAll(store);
      expect(claimed.map((j) => j.idempotencyKey)).toEqual(['a1']);
    });

    it('completes once, only while holding the lease, and stores the result', async () => {
      await store.enqueue(newJob(PRACTICE_A, 'a1'), T0);
      const [job] = await claimAll(store);
      expect(await store.complete(job!.id, '00000000-0000-4000-8000-000000000000', { ok: 1 }, at(1))).toBe(false);
      expect(await store.complete(job!.id, job!.leaseToken!, { ok: true }, at(1))).toBe(true);
      expect(await store.complete(job!.id, job!.leaseToken!, { ok: 'again' }, at(2))).toBe(false);
      const done = await store.get(PRACTICE_A, job!.id);
      expect(done).toMatchObject({ status: 'succeeded', result: { ok: true }, leaseToken: null, completedAt: at(1) });
    });

    it('reschedules without counting a failure, keeping or replacing the checkpoint', async () => {
      await store.enqueue(newJob(PRACTICE_A, 'a1'), T0);
      let [job] = await claimAll(store);
      expect(await store.reschedule(job!.id, job!.leaseToken!, at(500), { step: 1 }, T0)).toBe(true);
      expect(await store.get(PRACTICE_A, job!.id)).toMatchObject({ status: 'queued', attempts: 0, checkpoint: { step: 1 }, runAt: at(500) });
      [job] = await claimAll(store, { now: at(500) });
      expect(await store.reschedule(job!.id, job!.leaseToken!, at(900), undefined, at(500))).toBe(true);
      expect((await store.get(PRACTICE_A, job!.id))?.checkpoint).toEqual({ step: 1 });
      expect(await store.reschedule(job!.id, job!.leaseToken!, at(900), null, at(500))).toBe(false);
    });

    it('fails into a retry, then into dead-letter', async () => {
      await store.enqueue(newJob(PRACTICE_A, 'a1'), T0);
      let [job] = await claimAll(store);
      expect(await store.fail(job!.id, job!.leaseToken!, { now: T0, error: 'http_503', retryAt: at(2_000) })).toBe(true);
      expect(await store.get(PRACTICE_A, job!.id)).toMatchObject({ status: 'queued', attempts: 1, lastError: 'http_503', runAt: at(2_000) });
      expect(await claimAll(store, { now: at(1_999) })).toEqual([]);
      [job] = await claimAll(store, { now: at(2_000) });
      expect(await store.fail(job!.id, job!.leaseToken!, { now: at(2_000), error: 'http_400', retryAt: null })).toBe(true);
      expect(await store.fail(job!.id, job!.leaseToken!, { now: at(2_000), error: 'http_400', retryAt: null })).toBe(false);
      expect(await store.list(PRACTICE_A, 'dead')).toEqual([
        expect.objectContaining({ id: job!.id, attempts: 2, lastError: 'http_400', completedAt: at(2_000) }),
      ]);
    });

    it('returns expired leases to the queue and dead-letters jobs out of attempts', async () => {
      await store.enqueue(newJob(PRACTICE_A, 'a1', { maxAttempts: 2 }), T0);
      await store.enqueue(newJob(PRACTICE_A, 'a2', { maxAttempts: 1 }), T0);
      const claimed = await claimAll(store);
      expect(await store.reclaimExpired(at(59_999))).toEqual({ requeued: 0, dead: [] });
      const { requeued, dead } = await store.reclaimExpired(at(60_000));
      expect(requeued).toBe(1);
      expect(dead.map((j) => j.idempotencyKey)).toEqual(['a2']);
      expect(dead[0]).toMatchObject({ status: 'dead', attempts: 1, lastError: 'lease_expired' });
      const a1 = claimed.find((j) => j.idempotencyKey === 'a1')!;
      expect(await store.get(PRACTICE_A, a1.id)).toMatchObject({ status: 'queued', attempts: 1, runAt: at(60_000) });
      // The old worker's lease no longer counts.
      expect(await store.complete(a1.id, a1.leaseToken!, null, at(60_001))).toBe(false);
    });

    it('scopes reads to the practice', async () => {
      const { job } = await store.enqueue(newJob(PRACTICE_A, 'a1'), T0);
      expect(await store.get(PRACTICE_B, job.id)).toBeNull();
      expect(await store.list(PRACTICE_B)).toEqual([]);
      expect(await store.list(PRACTICE_A)).toHaveLength(1);
      expect(await store.list(PRACTICE_A, 'running')).toEqual([]);
    });

    it("noisy neighbour: practice B's 5 jobs finish without waiting for practice A's 1,000", async () => {
      const clock = new FakeClock(T0);
      const queue = new JobQueue(store, clock);
      const finished: PracticeId[] = [];
      const worker = new Worker({
        store,
        clock,
        random: sequenceRandom([0.5]),
        humanTasks: new InMemoryHumanTaskSink(),
        capacity: 4,
        maxConcurrencyPerPractice: 2,
        handlers: {
          'test.work': async ({ practiceId }) => {
            finished.push(practiceId);
          },
        },
      });
      // A's backlog is enqueued first, so a plain FIFO queue would run all of it before B.
      for (let i = 0; i < 1000; i += 1) {
        await queue.enqueue(systemCtx(PRACTICE_A), { type: 'test.work', idempotencyKey: `a-${i}` });
      }
      for (let i = 0; i < 5; i += 1) {
        await queue.enqueue(systemCtx(PRACTICE_B), { type: 'test.work', idempotencyKey: `b-${i}` });
      }
      let ticks = 0;
      while (finished.filter((p) => p === PRACTICE_B).length < 5) {
        ticks += 1;
        await worker.tick();
        clock.advance(1);
        if (ticks > 10) break;
      }
      expect(ticks).toBe(3);
      expect(finished.filter((p) => p === PRACTICE_A).length).toBeLessThanOrEqual(7);
      expect(await store.list(PRACTICE_B, 'succeeded')).toHaveLength(5);
      expect(await store.list(PRACTICE_A, 'queued')).toHaveLength(1000 - finished.filter((p) => p === PRACTICE_A).length);
    });
  });
}
