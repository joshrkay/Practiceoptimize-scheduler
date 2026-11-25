/** In-memory fakes of the worker's ports, for tests here and in packages that use the worker. */
import type { Clock, HumanTaskRequest, HumanTaskSink, Random, Sleep } from './ports.js';

/** A clock that only moves when told to. */
export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date | string = '2026-01-05T12:00:00.000Z') {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(at: Date | string): void {
    this.ms = new Date(at).getTime();
  }
}

/** A sleep that advances a fake clock instead of waiting. Records each requested delay. */
export function fakeSleep(clock: FakeClock): Sleep & { readonly calls: number[] } {
  const calls: number[] = [];
  const sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason;
    calls.push(ms);
    clock.advance(ms);
  };
  return Object.assign(sleep, { calls });
}

/** A random source that cycles through fixed values. */
export function sequenceRandom(values: readonly number[]): Random {
  if (values.length === 0) throw new Error('sequenceRandom needs at least one value');
  let i = 0;
  return () => {
    const v = values[i % values.length] as number;
    i += 1;
    return v;
  };
}

export class InMemoryHumanTaskSink implements HumanTaskSink {
  readonly tasks: HumanTaskRequest[] = [];

  async createTask(request: HumanTaskRequest): Promise<void> {
    this.tasks.push(request);
  }
}
