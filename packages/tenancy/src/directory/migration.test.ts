import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['DATABASE_URL'];
if (!url) {
  if (process.env['CI']) throw new Error('DATABASE_URL is required in CI');
}
const schema = `dir_${randomBytes(6).toString('hex')}`;
const sql = readFileSync(new URL('../../../db/migrations/0035_directory.sql', import.meta.url), 'utf8');

describe.skipIf(!url)('0035_directory migration', () => {
  const client = new pg.Client({ connectionString: url });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(sql);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  });

  const party = (id: string, practice: string | null) =>
    client.query(
      `INSERT INTO directory_parties (id, practice_id, name, kind, role, preferred_channel)
       VALUES ($1, $2, 'n', 'lab', 'r', 'fax')`,
      [id, practice],
    );

  it('allows shared (null practice) and practice-owned parties', async () => {
    await party('p1', null);
    await party('p2', 'practice-a');
    const r = await client.query('SELECT count(*)::int AS n FROM directory_parties WHERE practice_id IS NULL');
    expect(r.rows[0].n).toBe(1);
  });

  it('rejects invalid channel and kind', async () => {
    await expect(
      client.query(
        `INSERT INTO directory_parties (id, name, kind, role, preferred_channel) VALUES ('bad','n','lab','r','sms')`,
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO directory_parties (id, name, kind, role, preferred_channel) VALUES ('bad','n','hospital','r','fax')`,
      ),
    ).rejects.toThrow();
  });

  it('requires verified-by and verified-at together', async () => {
    await client.query(`INSERT INTO directory_endpoints (party_id, channel, address) VALUES ('p1','fax','+1-555-0199')`);
    await expect(
      client.query(
        `INSERT INTO directory_endpoints (party_id, channel, address, verified_by) VALUES ('p2','fax','+1-555-0198','x')`,
      ),
    ).rejects.toThrow(/verification_pair/);
    await client.query(
      `INSERT INTO directory_endpoints (party_id, channel, address, verified_by, verified_at)
       VALUES ('p2','fax','+1-555-0198','x', now())`,
    );
  });

  it('cascades endpoint deletes with the party', async () => {
    await client.query(`DELETE FROM directory_parties WHERE id = 'p1'`);
    const r = await client.query(`SELECT count(*)::int AS n FROM directory_endpoints WHERE party_id = 'p1'`);
    expect(r.rows[0].n).toBe(0);
  });
});
