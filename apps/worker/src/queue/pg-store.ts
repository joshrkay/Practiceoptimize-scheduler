import type { Pool } from 'pg';
import type { PracticeId } from '../ports.js';
import type { ClaimOptions, FailOptions, Job, JobStatus, JsonValue, NewJob, QueueStore } from './types.js';

/** Row shape of the `jobs` table (packages/db/migrations/0014_jobs.sql). */
interface JobRow {
  id: string;
  practice_id: string;
  type: string;
  idempotency_key: string;
  payload: JsonValue;
  checkpoint: JsonValue | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  result: JsonValue | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const COLUMNS = `id, practice_id, type, idempotency_key, payload, checkpoint, status, attempts, max_attempts, run_at,
  lease_token, lease_expires_at, result, last_error, created_at, updated_at, completed_at`;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    practiceId: row.practice_id as PracticeId,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    checkpoint: row.checkpoint,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    result: row.result,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

const json = (value: JsonValue | null | undefined) => (value === undefined ? null : JSON.stringify(value));

/**
 * Fair claim. For every practice with ready jobs, rank its ready jobs oldest first, drop ranks beyond its free
 * concurrency, then take rank 1 of every practice before rank 2 of any. `FOR UPDATE SKIP LOCKED` lets several
 * workers claim at once without blocking or double-claiming. Two workers claiming in the same instant can each
 * see the same running count, so a practice may briefly exceed its limit by the number of concurrent claimers.
 */
const CLAIM_SQL = `
WITH running AS (
  SELECT practice_id, count(*)::int AS n FROM jobs WHERE status = 'running' GROUP BY practice_id
),
practices AS (
  SELECT DISTINCT practice_id FROM jobs
  WHERE status = 'queued' AND run_at <= $1 AND NOT (practice_id = ANY($4::uuid[]))
),
ranked AS (
  SELECT c.id, c.run_at, c.seq, c.rn
  FROM practices p
  LEFT JOIN running r ON r.practice_id = p.practice_id
  CROSS JOIN LATERAL (
    SELECT j.id, j.run_at, j.seq, row_number() OVER (ORDER BY j.run_at, j.seq) AS rn
    FROM jobs j
    WHERE j.practice_id = p.practice_id AND j.status = 'queued' AND j.run_at <= $1
    ORDER BY j.run_at, j.seq
    LIMIT $3
  ) c
  WHERE c.rn <= $3 - coalesce(r.n, 0)
),
picked AS (
  SELECT id FROM ranked ORDER BY rn, run_at, seq LIMIT $2
),
locked AS (
  SELECT j.id FROM jobs j WHERE j.id IN (SELECT id FROM picked) AND j.status = 'queued'
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs SET status = 'running', lease_token = gen_random_uuid(), lease_expires_at = $5, updated_at = $1
WHERE id IN (SELECT id FROM locked)
RETURNING ${COLUMNS}`;

/** QueueStore on PostgreSQL. Connect as the role that owns `jobs` (it claims across practices). */
export class PgQueueStore implements QueueStore {
  constructor(private readonly pool: Pool) {}

  async enqueue(input: NewJob, now: Date): Promise<{ job: Job; created: boolean }> {
    const inserted = await this.pool.query<JobRow>(
      `INSERT INTO jobs (practice_id, type, idempotency_key, payload, max_attempts, run_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $7)
       ON CONFLICT (practice_id, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [input.practiceId, input.type, input.idempotencyKey, json(input.payload), input.maxAttempts, input.runAt, now],
    );
    if (inserted.rows[0]) return { job: toJob(inserted.rows[0]), created: true };
    const existing = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM jobs WHERE practice_id = $1 AND idempotency_key = $2`,
      [input.practiceId, input.idempotencyKey],
    );
    return { job: toJob(existing.rows[0] as JobRow), created: false };
  }

  async claim(options: ClaimOptions): Promise<Job[]> {
    if (options.limit < 1 || options.maxRunningPerPractice < 1) return [];
    const { rows } = await this.pool.query<JobRow>(CLAIM_SQL, [
      options.now,
      options.limit,
      options.maxRunningPerPractice,
      [...options.excludePracticeIds],
      new Date(options.now.getTime() + options.leaseMs),
    ]);
    return rows.map(toJob);
  }

  async complete(jobId: string, leaseToken: string, result: JsonValue | null, now: Date): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'succeeded', result = $3::jsonb, lease_token = NULL, lease_expires_at = NULL,
         updated_at = $4, completed_at = $4
       WHERE id = $1 AND status = 'running' AND lease_token = $2`,
      [jobId, leaseToken, json(result), now],
    );
    return rowCount === 1;
  }

  async reschedule(
    jobId: string,
    leaseToken: string,
    runAt: Date,
    checkpoint: JsonValue | null | undefined,
    now: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'queued', run_at = $3,
         checkpoint = CASE WHEN $4::boolean THEN $5::jsonb ELSE checkpoint END,
         lease_token = NULL, lease_expires_at = NULL, updated_at = $6
       WHERE id = $1 AND status = 'running' AND lease_token = $2`,
      [jobId, leaseToken, runAt, checkpoint !== undefined, json(checkpoint), now],
    );
    return rowCount === 1;
  }

  async fail(jobId: string, leaseToken: string, options: FailOptions): Promise<boolean> {
    const dead = options.retryAt === null;
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET attempts = attempts + 1, last_error = $3, lease_token = NULL, lease_expires_at = NULL,
         status = CASE WHEN $4::boolean THEN 'dead' ELSE 'queued' END,
         run_at = coalesce($5::timestamptz, run_at),
         completed_at = CASE WHEN $4::boolean THEN $6::timestamptz ELSE NULL END,
         updated_at = $6::timestamptz
       WHERE id = $1 AND status = 'running' AND lease_token = $2`,
      [jobId, leaseToken, options.error, dead, options.retryAt, options.now],
    );
    return rowCount === 1;
  }

  async reclaimExpired(now: Date): Promise<{ requeued: number; dead: Job[] }> {
    const { rows } = await this.pool.query<JobRow>(
      `WITH expired AS (
         SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at <= $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs SET attempts = attempts + 1, last_error = 'lease_expired', lease_token = NULL,
         lease_expires_at = NULL, updated_at = $1,
         status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'queued' END,
         run_at = CASE WHEN attempts + 1 >= max_attempts THEN run_at ELSE $1 END,
         completed_at = CASE WHEN attempts + 1 >= max_attempts THEN $1 ELSE NULL END
       WHERE id IN (SELECT id FROM expired)
       RETURNING ${COLUMNS}`,
      [now],
    );
    const jobs = rows.map(toJob);
    return { requeued: jobs.filter((j) => j.status === 'queued').length, dead: jobs.filter((j) => j.status === 'dead') };
  }

  async get(practiceId: PracticeId, jobId: string): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM jobs WHERE practice_id = $1 AND id = $2`,
      [practiceId, jobId],
    );
    return rows[0] ? toJob(rows[0]) : null;
  }

  async list(practiceId: PracticeId, status?: JobStatus): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT ${COLUMNS} FROM jobs WHERE practice_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY run_at, seq`,
      [practiceId, status ?? null],
    );
    return rows.map(toJob);
  }
}
