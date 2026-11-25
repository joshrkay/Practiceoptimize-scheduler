import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock, InMemoryHumanTaskSink, sequenceRandom } from '../fakes.js';
import { JobQueue } from '../queue/job-queue.js';
import { InMemoryQueueStore } from '../queue/memory-store.js';
import { PRACTICE_A, systemCtx } from '../queue/testing/store-contract.js';
import type { JsonValue } from '../queue/types.js';
import { Worker, type JobRunContext } from '../queue/worker.js';
import { submitAndPoll, type PollRef, type PollResponse } from './submit-and-poll.js';

interface Scenario {
  name: string;
  responses: PollResponse[];
  expect: {
    status: 'succeeded' | 'dead';
    polls: number;
    waitsMs?: number[];
    retries?: number;
    result: JsonValue;
    humanTask: string | null;
  };
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../../tests/fixtures/worker/poll-scenarios.json', import.meta.url), 'utf8'),
) as { maxPolls: number; intervalMs: number; scenarios: Scenario[] };

/** Drives one scenario through a real worker and in-memory store, advancing the fake clock to each run. */
async function runScenario(scenario: Scenario) {
  const clock = new FakeClock();
  const store = new InMemoryQueueStore();
  const humanTasks = new InMemoryHumanTaskSink();
  const responses = [...scenario.responses];
  const submit = vi.fn(async (_ctx: JobRunContext) => responses.shift() as PollResponse);
  const poll = vi.fn(async (_ref: PollRef, _ctx: JobRunContext) => responses.shift() as PollResponse);
  const worker = new Worker({
    store,
    clock,
    humanTasks,
    random: sequenceRandom([0.5]),
    handlers: {
      'payer.prior_auth.submit': submitAndPoll({
        submit,
        poll,
        maxPolls: fixture.maxPolls,
        intervalMs: fixture.intervalMs,
      }),
    },
  });
  const { job } = await new JobQueue(store, clock).enqueue(systemCtx(PRACTICE_A), {
    type: 'payer.prior_auth.submit',
    idempotencyKey: 'auth-req-0001',
    payload: { caseId: 'case-syn-0001' },
    maxAttempts: 3,
  });
  const waits: number[] = [];
  let succeeded = 0;
  let retries = 0;
  for (let i = 0; i < 20; i += 1) {
    const report = await worker.tick();
    succeeded += report.succeeded;
    retries += report.retried;
    const current = (await store.get(PRACTICE_A, job.id))!;
    if (current.status === 'succeeded' || current.status === 'dead') break;
    const wait = current.runAt.getTime() - clock.now().getTime();
    if (report.rescheduled) waits.push(wait);
    clock.advance(wait);
  }
  return { final: (await store.get(PRACTICE_A, job.id))!, submit, poll, waits, succeeded, retries, humanTasks };
}

describe('submitAndPoll', () => {
  it('Scenario 1: a 202 that completes on the third poll stores the result and completes the job once', async () => {
    const scenario = fixture.scenarios.find((s) => s.name === 'completes on the third poll')!;
    const { final, submit, poll, succeeded } = await runScenario(scenario);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(3);
    for (const call of poll.mock.calls) {
      expect(call[0]).toEqual({ location: 'https://payer.example.com/results/syn-req-0001' });
    }
    expect(succeeded).toBe(1);
    expect(final).toMatchObject({ status: 'succeeded', attempts: 0, result: scenario.expect.result });
  });

  for (const scenario of fixture.scenarios) {
    it(`fixture: ${scenario.name}`, async () => {
      const { final, submit, poll, waits, retries, humanTasks } = await runScenario(scenario);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(poll).toHaveBeenCalledTimes(scenario.expect.polls);
      expect(final.status).toBe(scenario.expect.status);
      expect(final.result).toEqual(scenario.expect.result);
      if (scenario.expect.waitsMs) expect(waits).toEqual(scenario.expect.waitsMs);
      expect(retries).toBe(scenario.expect.retries ?? 0);
      expect(humanTasks.tasks.map((t) => t.reason)).toEqual(scenario.expect.humanTask ? [scenario.expect.humanTask] : []);
    });
  }

  it('caps a server-requested wait and accepts a custom result ID reader', async () => {
    const handler = submitAndPoll({
      submit: async () => ({ status: 202, headers: { 'Retry-After': '86400' }, body: { ticket: 'syn-t-1' } }),
      poll: async () => ({ status: 200 }),
      maxPolls: 2,
      intervalMs: 1_000,
      maxIntervalMs: 60_000,
      extractResultId: (body) => (body as { ticket: string }).ticket,
    });
    const ctx = { checkpoint: null, now: new Date() } as unknown as JobRunContext;
    expect(await handler(ctx)).toEqual({
      kind: 'reschedule',
      delayMs: 60_000,
      checkpoint: { ref: { resultId: 'syn-t-1' }, polls: 0 },
    });
    expect(await handler({ ...ctx, checkpoint: { ref: { resultId: 'syn-t-1' }, polls: 0 } })).toEqual({
      kind: 'complete',
      result: null,
    });
  });

  it('rejects a non-positive poll limit', () => {
    expect(() =>
      submitAndPoll({ submit: async () => ({ status: 200 }), poll: async () => ({ status: 200 }), maxPolls: 0, intervalMs: 1 }),
    ).toThrow(/maxPolls/);
  });
});
