import { describe, expect, it, vi } from 'vitest';
import { readWorkerConfig } from './config.js';
import { FakeClock, fakeSleep } from './fakes.js';
import { parsePracticeId, realSleep, systemClock, systemRandom } from './ports.js';

describe('ports', () => {
  it('normalizes practice IDs and rejects anything else', () => {
    expect(parsePracticeId('0A0A0A0A-0000-4000-8000-00000000000A')).toBe('0a0a0a0a-0000-4000-8000-00000000000a');
    for (const bad of [undefined, '', 'practice-1', 42]) expect(() => parsePracticeId(bad)).toThrow(/practice context/);
  });

  it('exposes real clock, randomness and sleep', async () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
    const r = systemRandom();
    expect(r >= 0 && r < 1).toBe(true);
    vi.useFakeTimers();
    try {
      const done = realSleep(1_000);
      vi.advanceTimersByTime(1_000);
      await expect(done).resolves.toBeUndefined();
      const controller = new AbortController();
      const aborted = realSleep(1_000, controller.signal);
      controller.abort(new Error('stop'));
      await expect(aborted).rejects.toThrow('stop');
      await expect(realSleep(1, controller.signal)).rejects.toThrow('stop');
      const withSignal = realSleep(10, new AbortController().signal);
      vi.advanceTimersByTime(10);
      await expect(withSignal).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fake sleep advances the fake clock', async () => {
    const clock = new FakeClock('2026-01-05T00:00:00Z');
    const sleep = fakeSleep(clock);
    await sleep(1_500);
    expect(clock.now().toISOString()).toBe('2026-01-05T00:00:01.500Z');
    expect(sleep.calls).toEqual([1_500]);
    const c = new AbortController();
    c.abort(new Error('stop'));
    await expect(sleep(1, c.signal)).rejects.toThrow('stop');
    expect(new FakeClock().now()).toBeInstanceOf(Date);
  });
});

describe('readWorkerConfig', () => {
  it('uses defaults', () => {
    expect(readWorkerConfig({})).toEqual({ maxConcurrencyPerPractice: 2, pollMaxAttempts: 20 });
    expect(readWorkerConfig()).toEqual(expect.objectContaining({ pollMaxAttempts: expect.any(Number) }));
  });
  it('reads the practice name, falling back to the issue name', () => {
    expect(readWorkerConfig({ QUEUE_MAX_CONCURRENCY_PER_PRACTICE: '4', POLL_MAX_ATTEMPTS: '9' })).toEqual({
      maxConcurrencyPerPractice: 4,
      pollMaxAttempts: 9,
    });
    expect(readWorkerConfig({ QUEUE_MAX_CONCURRENCY_PER_TENANT: '3', POLL_MAX_ATTEMPTS: ' ' })).toEqual({
      maxConcurrencyPerPractice: 3,
      pollMaxAttempts: 20,
    });
  });
  it('rejects invalid values', () => {
    expect(() => readWorkerConfig({ POLL_MAX_ATTEMPTS: '0' })).toThrow(/POLL_MAX_ATTEMPTS/);
    expect(() => readWorkerConfig({ QUEUE_MAX_CONCURRENCY_PER_PRACTICE: '1.5' })).toThrow(/QUEUE_MAX_CONCURRENCY_PER_PRACTICE/);
  });
});
