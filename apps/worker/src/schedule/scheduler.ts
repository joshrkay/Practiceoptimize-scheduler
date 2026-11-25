import { parsePracticeId, systemClock, type Clock, type PracticeId } from '../ports.js';
import { assertSafeIdempotencyKey } from '../queue/guards.js';
import type { EnqueueRequest, JobQueue } from '../queue/job-queue.js';
import type { Job } from '../queue/types.js';
import { nextCronRun, parseCron, type CronExpression } from './cron.js';

export interface ScheduleDefinition {
  /** Stable, PHI-free name, unique per practice, e.g. `nightly_ehr_sync`. Part of each run's idempotency key. */
  readonly name: string;
  readonly practiceId: PracticeId;
  /** Five-field cron, evaluated in `timeZone`. */
  readonly cron: string;
  /** IANA zone of the practice, e.g. `America/Chicago`. Default UTC. */
  readonly timeZone?: string;
  readonly job: Omit<EnqueueRequest, 'idempotencyKey' | 'runAt'>;
}

interface Entry {
  readonly def: ScheduleDefinition;
  readonly expr: CronExpression;
  next: Date;
}

/**
 * Enqueues cron-style jobs. Each occurrence gets the idempotency key `schedule:<name>:<ISO time>`, so several
 * scheduler instances (or a restart) never enqueue the same run twice. After downtime only the latest missed
 * occurrence runs.
 */
export class Scheduler {
  private readonly entries: Entry[];

  constructor(
    private readonly queue: JobQueue,
    schedules: readonly ScheduleDefinition[],
    private readonly clock: Clock = systemClock,
    /** Occurrences after this instant are due. Default now. Pass the last tick time to catch up after restart. */
    since: Date = clock.now(),
  ) {
    this.entries = schedules.map((def) => {
      parsePracticeId(def.practiceId);
      assertSafeIdempotencyKey(`schedule:${def.name}`);
      const expr = parseCron(def.cron);
      return { def, expr, next: nextCronRun(expr, since, def.timeZone) };
    });
  }

  /** Enqueues every schedule that is due. Returns the jobs created by this tick. */
  async tick(): Promise<Job[]> {
    const now = this.clock.now();
    const created: Job[] = [];
    for (const entry of this.entries) {
      if (entry.next > now) continue;
      let occurrence = entry.next;
      for (let n = nextCronRun(entry.expr, occurrence, entry.def.timeZone); n <= now; ) {
        occurrence = n;
        n = nextCronRun(entry.expr, n, entry.def.timeZone);
      }
      const { def } = entry;
      const result = await this.queue.enqueue(
        { kind: 'system', practiceId: def.practiceId, source: `schedule:${def.name}` },
        { ...def.job, idempotencyKey: `schedule:${def.name}:${occurrence.toISOString()}`, runAt: occurrence },
      );
      if (result.created) created.push(result.job);
      entry.next = nextCronRun(entry.expr, now, def.timeZone);
    }
    return created;
  }

  /** When each schedule next fires, keyed by `<practiceId>/<name>`. */
  nextRuns(): Record<string, Date> {
    return Object.fromEntries(this.entries.map((e) => [`${e.def.practiceId}/${e.def.name}`, e.next]));
  }
}
