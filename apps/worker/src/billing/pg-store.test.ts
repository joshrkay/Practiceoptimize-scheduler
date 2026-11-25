import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBillableEventStore, buildMonthlyUsageReport, createMetering } from './index.js';

const url = process.env['DATABASE_URL'];
const suffix = randomBytes(5).toString('hex');
const schema = `billing_test_${suffix}`;
const role = `billing_app_${suffix}`;
const migration = readFileSync(
  fileURLToPath(new URL('../../../../packages/db/migrations/0094_billable_events.sql', import.meta.url)),
  'utf8',
);

let admin: Pool; // superuser connection, used only for setup/teardown
let pool: Pool; // restricted role, so row-level security is enforced
let store: PgBillableEventStore;

beforeAll(async () => {
  if (!url) throw new Error('DATABASE_URL is required for database tests');
  admin = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  const setup = new Pool({ connectionString: url, max: 1 });
  await setup.query(`CREATE SCHEMA ${schema}`);
  await setup.query(`CREATE ROLE ${role} NOLOGIN`);
  await setup.end();
  await admin.query(migration);
  await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON billable_events TO ${role}`);
  pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema} -c role=${role}` });
  store = new PgBillableEventStore(pool);
});

afterAll(async () => {
  await pool?.end();
  await admin?.end();
  if (!url) return;
  const cleanup = new Pool({ connectionString: url, max: 1 });
  await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
  await cleanup.end();
});

const base = {
  practiceId: 'practice-a',
  locationId: 'loc-1',
  caseReference: 'case-1',
  seriesId: null,
  urgentAddOn: false,
  bookedAt: '2026-11-03T14:00:00.000Z',
};

describe('PgBillableEventStore', () => {
  it('appends once per case and reports duplicates', async () => {
    expect(await store.append(base)).toBe(true);
    expect(await store.append({ ...base, bookedAt: '2026-11-20T14:00:00.000Z' })).toBe(false);
    const rows = await store.listForPractice('practice-a', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(rows).toEqual([base]);
  });

  it('feeds the metering flow and the monthly report', async () => {
    const m = createMetering({ store, enabled: true });
    await m.recordBooked({ practiceId: 'practice-a', locationId: 'loc-2', caseReference: 'case-2', seriesId: 's1', urgentAddOn: true, caseType: 'x', occurredAt: '2026-11-05T10:00:00Z' });
    const report = await buildMonthlyUsageReport(store, 'practice-a', { year: 2026, month: 11 });
    expect(report.totalBillableCases).toBe(2);
    expect(report.locations.map((l) => l.locationId)).toEqual(['loc-1', 'loc-2']);
  });

  it('isolates practices with the same case reference', async () => {
    expect(await store.append({ ...base, practiceId: 'practice-b' })).toBe(true);
    const a = await store.listForPractice('practice-a', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
    const b = await store.listForPractice('practice-b', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
    expect(a.every((r) => r.practiceId === 'practice-a')).toBe(true);
    expect(b).toHaveLength(1);
  });

  it('enforces row-level security by practice', async () => {
    const client = await pool.connect();
    try {
      const none = await client.query('SELECT * FROM billable_events');
      expect(none.rows).toHaveLength(0); // no practice set: nothing visible
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.practice_id', 'practice-a', true)");
      await expect(
        client.query(
          "INSERT INTO billable_events (practice_id, location_id, case_reference, booked_at) VALUES ('practice-b','l','spoof', now())",
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rejects update, delete and truncate in the database', async () => {
    await expect(admin.query("UPDATE billable_events SET location_id = 'x'")).rejects.toThrow(/append-only/);
    await expect(admin.query('DELETE FROM billable_events')).rejects.toThrow(/append-only/);
    await expect(admin.query('TRUNCATE billable_events')).rejects.toThrow(/append-only/);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.practice_id', 'practice-a', true)");
      await expect(client.query('DELETE FROM billable_events')).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rolls back and releases the connection when a write fails', async () => {
    await expect(store.append({ ...base, caseReference: '' })).rejects.toThrow();
    expect(await store.append({ ...base, caseReference: 'case-after-error' })).toBe(true);
  });
});
