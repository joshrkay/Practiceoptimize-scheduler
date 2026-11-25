import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APP_ROLE,
  PracticeContextError,
  withPracticeTransaction,
  type ConnectionPool,
  type PooledConnection,
} from './practice-context.js';
import { createTestSchema, type TestSchema } from './test-schema.js';

const PRACTICE = 'c0000000-0000-4000-8000-00000000000c';

describe('withPracticeTransaction', () => {
  let db: TestSchema;

  beforeAll(async () => {
    db = await createTestSchema('practice_context');
    await db.ownerPool.query(
      "INSERT INTO practices (id, name) VALUES ($1, 'Gamma Podiatry'), ('d0000000-0000-4000-8000-00000000000d', 'Delta Podiatry')",
      [PRACTICE],
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('rejects a missing or malformed practice id before touching the database', async () => {
    const pool = { connect: () => Promise.reject(new Error('should not connect')) };
    await expect(withPracticeTransaction(pool, '', async () => 1)).rejects.toThrow(PracticeContextError);
    await expect(withPracticeTransaction(pool, "x' OR 1=1 --", async () => 1)).rejects.toThrow(/UUID/);
  });

  it('refuses to run as a role that bypasses row-level security', async () => {
    await expect(withPracticeTransaction(db.ownerPool, PRACTICE, async () => 1)).rejects.toThrow(
      /bypasses row-level security/,
    );
  });

  it('scopes the transaction to the practice and clears the setting afterwards', async () => {
    const app = db.pool({ role: APP_ROLE });
    const seen = await withPracticeTransaction(app, PRACTICE, async (tx) => {
      const { rows } = await tx.query<{ id: string; setting: string }>(
        "SELECT id, current_setting('app.practice_id') AS setting FROM practices",
      );
      return rows;
    });
    expect(seen).toEqual([{ id: PRACTICE, setting: PRACTICE }]);

    // Same pooled connections afterwards: no context, no rows.
    for (let i = 0; i < 4; i += 1) {
      const { rows } = await app.query<{ setting: string | null; n: number }>(
        "SELECT current_setting('app.practice_id', true) AS setting, (SELECT count(*)::int FROM practices) AS n",
      );
      expect(rows[0]?.n).toBe(0);
      expect(rows[0]?.setting ?? '').toBe('');
    }
  });

  it('rolls back and rethrows when the work fails', async () => {
    const app = db.pool({ role: APP_ROLE });
    await expect(
      withPracticeTransaction(app, PRACTICE, async (tx) => {
        await tx.query('SELECT 1');
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    const { rows } = await app.query<{ n: number }>('SELECT 1 AS n');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('destroys the connection when rollback itself fails', async () => {
    const released: unknown[] = [];
    const connection: PooledConnection = {
      query: async (text: string) => {
        if (text === 'ROLLBACK') throw new Error('connection lost');
        if (text.includes('set_config')) return { rows: [{ bypasses_rls: false }] } as never;
        return { rows: [] } as never;
      },
      release: (destroy) => {
        released.push(destroy);
      },
    };
    const pool: ConnectionPool = { connect: async () => connection };
    await expect(
      withPracticeTransaction(pool, PRACTICE, () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);

    const unknownRole: ConnectionPool = {
      connect: async () => ({ ...connection, query: async () => ({ rows: [] }) as never }),
    };
    await expect(withPracticeTransaction(unknownRole, PRACTICE, async () => 1)).rejects.toThrow(PracticeContextError);
  });
});
