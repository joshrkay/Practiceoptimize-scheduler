import { describe, expect, it } from 'vitest';
import { FakeClock } from '../fakes.js';
import { JobQueue } from '../queue/job-queue.js';
import { InMemoryQueueStore } from '../queue/memory-store.js';
import { PRACTICE_A, PRACTICE_B } from '../queue/testing/store-contract.js';
import { Scheduler, type ScheduleDefinition } from './scheduler.js';

const nightly: ScheduleDefinition = {
  name: 'nightly_ehr_sync',
  practiceId: PRACTICE_A,
  cron: '0 2 * * *',
  timeZone: 'America/Chicago',
  job: { type: 'ehr.sync.nightly', payload: { scope: 'cases' } },
};

function setup(schedules: ScheduleDefinition[], start = '2026-03-02T07:00:00.000Z') {
  const clock = new FakeClock(start);
  const store = new InMemoryQueueStore();
  const queue = new JobQueue(store, clock);
  return { clock, store, queue, scheduler: new Scheduler(queue, schedules, clock) };
}

describe('Scheduler', () => {
  it('enqueues each occurrence once, in system context for the practice', async () => {
    const { clock, store, scheduler, queue } = setup([nightly]);
    expect(scheduler.nextRuns()).toEqual({ [`${PRACTICE_A}/nightly_ehr_sync`]: new Date('2026-03-02T08:00:00.000Z') });
    expect(await scheduler.tick()).toEqual([]);
    clock.set('2026-03-02T08:00:30.000Z');
    const created = await scheduler.tick();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      practiceId: PRACTICE_A,
      type: 'ehr.sync.nightly',
      idempotencyKey: 'schedule:nightly_ehr_sync:2026-03-02T08:00:00.000Z',
      runAt: new Date('2026-03-02T08:00:00.000Z'),
      payload: { scope: 'cases' },
    });
    expect(await scheduler.tick()).toEqual([]);
    // A second scheduler instance (another worker) cannot enqueue the same run again.
    const other = new Scheduler(queue, [nightly], clock, new Date('2026-03-02T07:59:00.000Z'));
    expect(await other.tick()).toEqual([]);
    expect(await store.list(PRACTICE_A)).toHaveLength(1);
  });

  it('after downtime runs only the latest missed occurrence', async () => {
    const { clock, scheduler } = setup([{ ...nightly, cron: '0 * * * *', timeZone: 'UTC' }]);
    clock.set('2026-03-02T11:30:00.000Z');
    const created = await scheduler.tick();
    expect(created.map((j) => j.idempotencyKey)).toEqual(['schedule:nightly_ehr_sync:2026-03-02T11:00:00.000Z']);
    expect(Object.values(scheduler.nextRuns())).toEqual([new Date('2026-03-02T12:00:00.000Z')]);
  });

  it('keeps practices separate', async () => {
    const { clock, scheduler, store } = setup([nightly, { ...nightly, practiceId: PRACTICE_B, timeZone: 'UTC' }]);
    clock.set('2026-03-02T08:00:00.000Z');
    expect(await scheduler.tick()).toHaveLength(1);
    expect(await store.list(PRACTICE_B)).toEqual([]);
    clock.set('2026-03-03T02:00:00.000Z');
    expect(await scheduler.tick()).toHaveLength(1);
    expect(await store.list(PRACTICE_B)).toHaveLength(1);
  });

  it('rejects schedules without practice context or with unsafe names', () => {
    const { queue } = setup([]);
    expect(() => new Scheduler(queue, [{ ...nightly, practiceId: 'not-a-uuid' as never }])).toThrow(/practice context/);
    expect(() => new Scheduler(queue, [{ ...nightly, name: 'sync for Jane Doe' }])).toThrow(/PHI-free/);
  });
});
