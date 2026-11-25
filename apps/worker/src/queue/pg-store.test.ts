import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgQueueStore } from './pg-store.js';
import { PRACTICE_A, PRACTICE_B, queueStoreContract } from './testing/store-contract.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL && process.env['CI']) {
  throw new Error('DATABASE_URL is required in CI for the PostgreSQL queue store tests');
}

const MIGRATION = fileURLToPath(new URL('../../../../packages/db/migrations/0014_jobs.sql', import.meta.url));
const schema = `rah14_jobs_${randomBytes(6).toString('hex')}`;

describe.skipIf(!DATABASE_URL)('PgQueueStore', () => {
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6, options: `-c search_path=${schema}` });
    await pool.query(await readFile(MIGRATION, 'utf8'));
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  queueStoreContract('PgQueueStore', async () => {
    await pool.query('TRUNCATE jobs');
    return new PgQueueStore(pool);
  });

  describe('PostgreSQL specifics', () => {
    const now = new Date('2026-01-05T12:00:00.000Z');

    it('never hands the same job to two concurrent claimers (FOR UPDATE SKIP LOCKED)', async () => {
      await pool.query('TRUNCATE jobs');
      const store = new PgQueueStore(pool);
      for (let i = 0; i < 40; i += 1) {
        const practiceId = i % 2 === 0 ? PRACTICE_A : PRACTICE_B;
        await store.enqueue(
          { practiceId, type: 'test.noop', idempotencyKey: `k-${i}`, payload: null, maxAttempts: 3, runAt: now },
          now,
        );
      }
      const claims = await Promise.all(
        Array.from({ length: 5 }, () =>
          store.claim({ now, limit: 8, maxRunningPerPractice: 100, excludePracticeIds: [], leaseMs: 60_000 }),
        ),
      );
      const ids = claims.flat().map((j) => j.id);
      expect(new Set(ids).size).toBe(ids.length);
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running'`);
      expect(rows[0]?.n).toBe(ids.length);
    });

    it('puts practice_id on every row and rejects unsafe metadata at the database', async () => {
      await expect(
        pool.query(
          `INSERT INTO jobs (practice_id, type, idempotency_key, max_attempts, run_at, created_at, updated_at)
           VALUES (NULL, 'test.noop', 'k', 1, now(), now(), now())`,
        ),
      ).rejects.toThrow(/practice_id/);
      await expect(
        pool.query(
          `INSERT INTO jobs (practice_id, type, idempotency_key, max_attempts, run_at, created_at, updated_at)
           VALUES ($1, 'Prior auth for Jane Doe', 'k', 1, now(), now(), now())`,
          [PRACTICE_A],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it('isolates practices for application roles with row-level security', async () => {
      await pool.query('TRUNCATE jobs');
      const store = new PgQueueStore(pool);
      const base = { type: 'test.noop', payload: null, maxAttempts: 1, runAt: now };
      await store.enqueue({ ...base, practiceId: PRACTICE_A, idempotencyKey: 'a' }, now);
      await store.enqueue({ ...base, practiceId: PRACTICE_B, idempotencyKey: 'b' }, now);
      const role = `${schema}_app`;
      const client = await pool.connect();
      try {
        await client.query(`CREATE ROLE ${role} NOLOGIN`);
        await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
        await client.query(`GRANT SELECT ON jobs TO ${role}`);
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query(`SELECT set_config('app.current_practice_id', $1, true)`, [PRACTICE_B]);
        const { rows } = await client.query<{ practice_id: string }>('SELECT practice_id FROM jobs');
        expect(rows.map((r) => r.practice_id)).toEqual([PRACTICE_B]);
        await client.query('ROLLBACK');
      } finally {
        await client.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await client.query(`DROP ROLE IF EXISTS ${role}`);
        client.release();
      }
    });
  });
});
