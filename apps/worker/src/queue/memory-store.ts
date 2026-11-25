import { randomUUID } from 'node:crypto';
import type { PracticeId } from '../ports.js';
import type { ClaimOptions, FailOptions, Job, JobStatus, JsonValue, NewJob, QueueStore } from './types.js';

type MutableJob = { -readonly [K in keyof Job]: Job[K] };

// Array sort is stable and the map keeps insertion order, so equal run times stay first-in, first-out.
const byRunAt = (a: Job, b: Job) => a.runAt.getTime() - b.runAt.getTime();

/** QueueStore held in process memory. For tests and local development; jobs are lost on restart. */
export class InMemoryQueueStore implements QueueStore {
  private readonly jobs = new Map<string, MutableJob>();
  private readonly keys = new Map<string, string>();

  constructor(private readonly newId: () => string = randomUUID) {}

  private snapshot(job: MutableJob): Job {
    return { ...job };
  }

  async enqueue(input: NewJob, now: Date): Promise<{ job: Job; created: boolean }> {
    const key = `${input.practiceId}\u0000${input.idempotencyKey}`;
    const existingId = this.keys.get(key);
    if (existingId !== undefined) {
      return { job: this.snapshot(this.jobs.get(existingId) as MutableJob), created: false };
    }
    const createdAt = new Date(now.getTime());
    const job: MutableJob = {
      id: this.newId(),
      practiceId: input.practiceId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: structuredClone(input.payload),
      checkpoint: null,
      status: 'queued',
      attempts: 0,
      maxAttempts: input.maxAttempts,
      runAt: new Date(input.runAt.getTime()),
      leaseToken: null,
      leaseExpiresAt: null,
      result: null,
      lastError: null,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    this.keys.set(key, job.id);
    return { job: this.snapshot(job), created: true };
  }

  async claim(options: ClaimOptions): Promise<Job[]> {
    const { now, limit, maxRunningPerPractice, excludePracticeIds, leaseMs } = options;
    const excluded = new Set<string>(excludePracticeIds);
    const running = new Map<PracticeId, number>();
    const ready = new Map<PracticeId, MutableJob[]>();
    for (const job of this.jobs.values()) {
      if (job.status === 'running') running.set(job.practiceId, (running.get(job.practiceId) ?? 0) + 1);
      if (job.status === 'queued' && job.runAt <= now && !excluded.has(job.practiceId)) {
        const list = ready.get(job.practiceId) ?? [];
        list.push(job);
        ready.set(job.practiceId, list);
      }
    }
    // Rank each practice's ready jobs; pick rank 1 of every practice before rank 2 of any (round-robin).
    const candidates: { job: MutableJob; rank: number }[] = [];
    for (const [practiceId, list] of ready) {
      const room = maxRunningPerPractice - (running.get(practiceId) ?? 0);
      list.sort(byRunAt);
      list.slice(0, Math.max(0, room)).forEach((job, i) => candidates.push({ job, rank: i + 1 }));
    }
    candidates.sort((a, b) => a.rank - b.rank || byRunAt(a.job, b.job));
    const claimed: Job[] = [];
    for (const { job } of candidates.slice(0, limit)) {
      job.status = 'running';
      job.leaseToken = this.newId();
      job.leaseExpiresAt = new Date(now.getTime() + leaseMs);
      job.updatedAt = now;
      claimed.push(this.snapshot(job));
    }
    return claimed;
  }

  private leased(jobId: string, leaseToken: string): MutableJob | null {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'running' || job.leaseToken !== leaseToken) return null;
    return job;
  }

  async complete(jobId: string, leaseToken: string, result: JsonValue | null, now: Date): Promise<boolean> {
    const job = this.leased(jobId, leaseToken);
    if (!job) return false;
    job.status = 'succeeded';
    job.result = structuredClone(result);
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = now;
    job.completedAt = now;
    return true;
  }

  async reschedule(
    jobId: string,
    leaseToken: string,
    runAt: Date,
    checkpoint: JsonValue | null | undefined,
    now: Date,
  ): Promise<boolean> {
    const job = this.leased(jobId, leaseToken);
    if (!job) return false;
    job.status = 'queued';
    job.runAt = runAt;
    if (checkpoint !== undefined) job.checkpoint = structuredClone(checkpoint);
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = now;
    return true;
  }

  async fail(jobId: string, leaseToken: string, options: FailOptions): Promise<boolean> {
    const job = this.leased(jobId, leaseToken);
    if (!job) return false;
    job.attempts += 1;
    job.lastError = options.error;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.updatedAt = options.now;
    if (options.retryAt === null) {
      job.status = 'dead';
      job.completedAt = options.now;
    } else {
      job.status = 'queued';
      job.runAt = options.retryAt;
    }
    return true;
  }

  async reclaimExpired(now: Date): Promise<{ requeued: number; dead: Job[] }> {
    let requeued = 0;
    const dead: Job[] = [];
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt > now) continue;
      job.attempts += 1;
      job.lastError = 'lease_expired';
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.updatedAt = now;
      if (job.attempts >= job.maxAttempts) {
        job.status = 'dead';
        job.completedAt = now;
        dead.push(this.snapshot(job));
      } else {
        job.status = 'queued';
        job.runAt = now;
        requeued += 1;
      }
    }
    return { requeued, dead };
  }

  async get(practiceId: PracticeId, jobId: string): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    return job && job.practiceId === practiceId ? this.snapshot(job) : null;
  }

  async list(practiceId: PracticeId, status?: JobStatus): Promise<Job[]> {
    return [...this.jobs.values()]
      .filter((j) => j.practiceId === practiceId && (status === undefined || j.status === status))
      .sort(byRunAt)
      .map((j) => this.snapshot(j));
  }
}
