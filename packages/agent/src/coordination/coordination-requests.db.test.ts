import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCAL_URL = 'postgres://postgres:postgres@localhost:5432/scheduler_test';
if (!process.env.DATABASE_URL && process.env.CI) {
  throw new Error('DATABASE_URL is required in CI for the coordination_requests migration test');
}
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_URL;

const migration = readFileSync(
  fileURLToPath(new URL('../../../db/migrations/0036_coordination_requests.sql', import.meta.url)),
  'utf8',
);

const suffix = randomBytes(6).toString('hex');
const schema = `coord_test_${suffix}`;
const role = `coord_rls_${suffix}`;
const practiceA = '6f1c2a8e-0000-4000-8000-00000000a001';
const practiceB = '6f1c2a8e-0000-4000-8000-00000000a002';

let client: pg.Client;
let counter = 0;

interface Row {
  practice_id?: string;
  party_id?: string;
  request_type?: string;
  status?: string;
  approval_status?: string;
  sent_at?: string | null;
  answered_at?: string | null;
  cancelled_at?: string | null;
}

async function insert(row: Row = {}): Promise<string> {
  counter += 1;
  const id = `req-${counter}`;
  await client.query(
    `INSERT INTO coordination_requests
       (id, practice_id, case_id, party_id, party_role, request_type, step_id, stage, channel, status,
        approval_status, surgery_date, due_at, sent_at, answered_at, cancelled_at, blocks_readiness)
     VALUES ($1, $2, 'case-pod-0001', $3, 'primary_care', $4, 'step', 'scheduled', 'fax', $5, $6,
             '2027-02-10', '2027-02-03T00:00:00Z', $7, $8, $9, true)`,
    [
      id,
      row.practice_id ?? practiceA,
      row.party_id ?? 'party-pcp',
      row.request_type ?? 'clearance',
      row.status ?? 'open',
      row.approval_status ?? 'not_required',
      row.sent_at === undefined ? '2027-01-04T15:00:00Z' : row.sent_at,
      row.answered_at ?? null,
      row.cancelled_at ?? null,
    ],
  );
  return id;
}

async function pgError(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(migration);
  await client.query(`CREATE ROLE ${role} NOLOGIN`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE ON coordination_requests TO ${role}`);
});

afterAll(async () => {
  if (!client) return;
  await client.query('RESET ROLE');
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP ROLE IF EXISTS ${role}`);
  await client.end();
});

describe('migration 0036_coordination_requests', () => {
  it('allows one active request per practice, case, party and type', async () => {
    const first = await insert();
    expect(await pgError(insert())).toBe('23505');
    expect(await pgError(insert({ status: 'overdue' }))).toBe('23505');
    await insert({ party_id: 'party-cardiology' });
    await insert({ practice_id: practiceB });

    await client.query(`UPDATE coordination_requests SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [
      first,
    ]);
    await insert();
    await insert({ status: 'answered', answered_at: '2027-01-05T00:00:00Z' });
  });

  it('never stores a facility posting or peer-to-peer as not requiring approval', async () => {
    expect(await pgError(insert({ request_type: 'facility_posting', party_id: 'p1' }))).toBe('23514');
    expect(await pgError(insert({ request_type: 'peer_to_peer', party_id: 'p2' }))).toBe('23514');
    await insert({ request_type: 'facility_posting', party_id: 'p3', approval_status: 'pending', sent_at: null });
    expect(
      await pgError(insert({ request_type: 'peer_to_peer', party_id: 'p4', approval_status: 'pending' })),
    ).toBe('23514');
  });

  it('rejects unknown statuses and inconsistent timestamps', async () => {
    expect(await pgError(insert({ status: 'pending', party_id: 'p5' }))).toBe('23514');
    expect(await pgError(insert({ status: 'answered', party_id: 'p6' }))).toBe('23514');
  });

  it('isolates practices with row-level security', async () => {
    await client.query(`SET ROLE ${role}`);
    try {
      await client.query(`SELECT set_config('app.practice_id', $1, false)`, [practiceA]);
      const visible = await client.query<{ practice_id: string }>('SELECT DISTINCT practice_id FROM coordination_requests');
      expect(visible.rows.map((row) => row.practice_id)).toEqual([practiceA]);
      expect(await pgError(insert({ practice_id: practiceB, party_id: 'p7' }))).toBe('42501');

      await client.query(`SELECT set_config('app.practice_id', '', false)`);
      const none = await client.query<{ count: string }>('SELECT count(*) FROM coordination_requests');
      expect(none.rows[0]?.count).toBe('0');
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
