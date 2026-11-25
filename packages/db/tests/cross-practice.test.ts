/**
 * Cross-practice isolation suite (RAH-10).
 *
 * Discovers every base table with a `practice_id` column after all migrations have run and asserts, per
 * table, that row-level security keeps practices apart. New practice-owned tables are covered
 * automatically: a table without the policy, or without rows for both practices in
 * tests/fixtures/tenancy/two-practices.json, fails here.
 */
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, withPracticeTransaction } from '../src/practice-context.js';
import { createTestSchema } from '../src/test-schema.js';

interface TwoPracticesFixture {
  practices: { a: string; b: string };
  tables: { table: string; rows: Record<string, unknown>[] }[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/tenancy/two-practices.json', import.meta.url), 'utf8'),
) as TwoPracticesFixture;
const A = fixture.practices.a;
const B = fixture.practices.b;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENTIFIER.test(name)) throw new Error(`Unexpected identifier ${name}`);
  return `"${name}"`;
};

async function seed(owner: pg.Pool): Promise<void> {
  for (const { table, rows } of fixture.tables) {
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map((c) => {
        const v = row[c];
        return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
      });
      await owner.query(
        `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        values,
      );
    }
  }
}

// Discovery runs before tests are collected so each table gets its own named tests.
const db = await createTestSchema('cross_practice');
const app = db.pool({ role: APP_ROLE });
await seed(db.ownerPool);

const practiceTables = (
  await db.ownerPool.query<{ table_name: string }>(
    `SELECT c.table_name
     FROM information_schema.columns c
     JOIN information_schema.tables t USING (table_schema, table_name)
     WHERE c.table_schema = $1 AND c.column_name = 'practice_id' AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name`,
    [db.schema],
  )
).rows.map((r) => r.table_name);

afterAll(async () => {
  await db.drop();
});

const inPractice = <T>(practiceId: string, work: (tx: pg.ClientBase) => Promise<T>): Promise<T> =>
  withPracticeTransaction(app, practiceId, (tx) => work(tx as unknown as pg.ClientBase));

const count = async (q: { query: pg.ClientBase['query'] }, sql: string, values: unknown[] = []): Promise<number> => {
  const { rows } = await q.query<{ n: number }>(sql, values);
  return rows[0]?.n ?? -1;
};

describe('cross-practice isolation', () => {
  it('discovers the practice-owned tables', () => {
    expect(practiceTables).toEqual(
      expect.arrayContaining([
        'locations',
        'practice_facility_settings',
        'surgeon_facility_privileges',
        'surgeon_locations',
        'surgeons',
      ]),
    );
  });

  it('uses an application role that is not a superuser and cannot bypass row-level security', async () => {
    const { rows } = await db.ownerPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [APP_ROLE],
    );
    expect(rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const { rows: who } = await app.query<{ current_user: string }>('SELECT current_user');
    expect(who[0]?.current_user).toBe(APP_ROLE);
  });

  describe.each(practiceTables)('%s', (table) => {
    const t = quote(table);
    let primaryKey: string[] = [];
    let rowOfB: unknown;

    beforeAll(async () => {
      const pk = await db.ownerPool.query<{ attname: string }>(
        `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`,
        [table],
      );
      primaryKey = pk.rows.map((r) => r.attname);
      const b = await db.ownerPool.query<{ row: unknown }>(
        `SELECT to_jsonb(x) AS row FROM ${t} x WHERE practice_id = $1 LIMIT 1`,
        [B],
      );
      rowOfB = b.rows[0]?.row;
    });

    it('has forced row-level security with a policy on the session practice', async () => {
      const { rows } = await db.ownerPool.query<{ rls: boolean; forced: boolean; policies: number }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policies p
                 WHERE p.schemaname = $2 AND p.tablename = $3
                   AND p.qual LIKE '%app_current_practice_id()%'
                   AND (p.with_check IS NULL OR p.with_check LIKE '%app_current_practice_id()%')) AS policies
         FROM pg_class c WHERE c.oid = $1::regclass`,
        [table, db.schema, table],
      );
      expect(rows[0]).toEqual({ rls: true, forced: true, policies: 1 });
      expect(primaryKey.length).toBeGreaterThan(0);
    });

    it('has fixture rows for both practices (add them to two-practices.json)', async () => {
      expect(await count(db.ownerPool, `SELECT count(*)::int AS n FROM ${t} WHERE practice_id = $1`, [A])).toBeGreaterThan(0);
      expect(await count(db.ownerPool, `SELECT count(*)::int AS n FROM ${t} WHERE practice_id = $1`, [B])).toBeGreaterThan(0);
    });

    it.each([
      ['A', A],
      ['B', B],
    ])("practice %s's session sees exactly its own rows", async (_label, practiceId) => {
      const own = await count(db.ownerPool, `SELECT count(*)::int AS n FROM ${t} WHERE practice_id = $1`, [practiceId]);
      const seen = await inPractice(practiceId, async (tx) => {
        const { rows } = await tx.query<{ practice_id: string }>(`SELECT practice_id FROM ${t}`);
        return rows.map((r) => r.practice_id);
      });
      expect(seen).toHaveLength(own);
      expect(new Set(seen)).toEqual(new Set([practiceId]));
    });

    it('returns zero rows without practice context', async () => {
      expect(await count(app, `SELECT count(*)::int AS n FROM ${t}`)).toBe(0);
    });

    it("returns zero rows when practice A asks for practice B's row by key or by practice_id", async () => {
      const where = primaryKey.map((c) => `x.${quote(c)} = r.${quote(c)}`).join(' AND ');
      const [byKey, byPractice] = await inPractice(A, async (tx) => [
        await count(
          tx,
          `SELECT count(*)::int AS n FROM ${t} x, jsonb_populate_record(NULL::${t}, $1) r WHERE ${where}`,
          [rowOfB],
        ),
        await count(tx, `SELECT count(*)::int AS n FROM ${t} WHERE practice_id = $1`, [B]),
      ]);
      expect(byKey).toBe(0);
      expect(byPractice).toBe(0);
    });

    it("cannot update or delete practice B's rows from practice A", async () => {
      const [updated, deleted] = await inPractice(A, async (tx) => [
        (await tx.query(`UPDATE ${t} SET practice_id = practice_id WHERE practice_id = $1`, [B])).rowCount,
        (await tx.query(`DELETE FROM ${t} WHERE practice_id = $1`, [B])).rowCount,
      ]);
      expect(updated).toBe(0);
      expect(deleted).toBe(0);
      expect(await count(db.ownerPool, `SELECT count(*)::int AS n FROM ${t} WHERE practice_id = $1`, [B])).toBeGreaterThan(0);
    });

    it('cannot write a row into practice B, or move its own rows there, from practice A', async () => {
      await expect(
        inPractice(A, (tx) => tx.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_record(NULL::${t}, $1)`, [rowOfB])),
      ).rejects.toThrow(/row-level security/);
      await expect(
        inPractice(A, (tx) => tx.query(`UPDATE ${t} SET practice_id = $1 WHERE practice_id = $2`, [B, A])),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('shared and parent tables', () => {
    it('shows a session only its own practice and parent organization', async () => {
      const [practices, organizations] = await inPractice(A, async (tx) => [
        (await tx.query<{ id: string }>('SELECT id FROM practices')).rows.map((r) => r.id),
        (await tx.query<{ name: string }>('SELECT name FROM organizations')).rows.map((r) => r.name),
      ]);
      expect(practices).toEqual([A]);
      expect(organizations).toEqual(['Alpha Foot Health Group']);
      expect(await count(app, 'SELECT count(*)::int AS n FROM practices')).toBe(0);
      expect(await count(app, 'SELECT count(*)::int AS n FROM organizations')).toBe(0);
    });

    it('lets every practice read the shared facility but not change it or create practices', async () => {
      for (const practiceId of [A, B]) {
        expect(await inPractice(practiceId, (tx) => count(tx, 'SELECT count(*)::int AS n FROM facilities'))).toBe(1);
      }
      await expect(inPractice(A, (tx) => tx.query("UPDATE facilities SET name = 'Renamed'"))).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        inPractice(A, (tx) => tx.query("INSERT INTO practices (name) VALUES ('Sneaky Podiatry')")),
      ).rejects.toThrow(/permission denied/);
    });

    it('gives the application role no access to migration bookkeeping', async () => {
      await expect(inPractice(A, (tx) => tx.query('SELECT * FROM schema_migrations'))).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
