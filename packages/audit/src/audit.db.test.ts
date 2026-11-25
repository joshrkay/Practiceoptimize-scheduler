import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAuditSink, recordAudit, type AuditEventInput } from './index.js';

const url = process.env['DATABASE_URL'];
if (!url && process.env['CI']) {
  throw new Error('DATABASE_URL is required in CI for audit DB tests');
}
const connectionString = url ?? 'postgres://postgres:postgres@localhost:5432/scheduler_test';

const schema = `audit_test_${randomBytes(6).toString('hex')}`;
const sql = readFileSync(
  new URL('../../db/migrations/0008_audit_events.sql', import.meta.url),
  'utf8',
);
const input: AuditEventInput = {
  practiceId: 'practice-podiatry-001',
  locationId: 'loc-asc-main',
  actor: { type: 'agent', id: 'scheduler-agent' },
  action: 'availity.eligibility.check',
  target: { type: 'case', id: 'case-0001' },
  inputs: { caseId: 'case-0001' },
  result: 'success',
  autonomyTier: 1,
  approverId: null,
  externalTransactionId: 'GTID-SYNTH-0001',
};

// A single connection so search_path and SET ROLE apply to every statement.
const client = new pg.Client({ connectionString });

async function rejection(text: string): Promise<{ code?: string; message: string }> {
  await client.query('SAVEPOINT s');
  try {
    await client.query(text);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    return e as { code?: string; message: string };
  }
  throw new Error(`expected failure: ${text}`);
}

beforeAll(async () => {
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(sql);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO scheduler_app`);
  await recordAudit(new PgAuditSink(client), input);
  await client.query('BEGIN');
});

afterAll(async () => {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.query('RESET ROLE').catch(() => undefined);
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
});

describe('audit_events in PostgreSQL', () => {
  it('stores the event through PgAuditSink', async () => {
    const { rows } = await client.query('SELECT * FROM audit_events');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      practice_id: 'practice-podiatry-001',
      actor_type: 'agent',
      external_transaction_id: 'GTID-SYNTH-0001',
      autonomy_tier: 1,
    });
  });

  it('rejects UPDATE, DELETE and TRUNCATE even for the table owner (trigger)', async () => {
    for (const stmt of [
      `UPDATE audit_events SET action = 'x'`,
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
    ]) {
      const err = await rejection(stmt);
      expect(err.message).toContain('append-only');
    }
  });

  it('the application role has no UPDATE/DELETE/TRUNCATE grant', async () => {
    await client.query('SET LOCAL ROLE scheduler_app');
    for (const stmt of [
      `UPDATE audit_events SET action = 'x'`,
      'DELETE FROM audit_events',
      'TRUNCATE audit_events',
    ]) {
      const err = await rejection(stmt);
      expect(err.code).toBe('42501');
      expect(err.message).toContain('permission denied');
    }
    // It can still append and read.
    await recordAudit(new PgAuditSink(client), { ...input, actor: { type: 'user', id: 'u1' } });
    const { rows } = await client.query('SELECT count(*)::int AS n FROM audit_events');
    expect(rows[0]).toEqual({ n: 2 });
    await client.query('RESET ROLE');
  });

  it('rejects malformed events (check constraints)', async () => {
    const err = await rejection(
      `INSERT INTO audit_events VALUES (gen_random_uuid(),'p',null,'robot','a','act','t','1','nothex','success',1,null,null,now())`,
    );
    expect(err.code).toBe('23514');
  });
});
