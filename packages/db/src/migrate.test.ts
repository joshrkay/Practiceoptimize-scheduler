import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from './migrate.js';
import { createTestSchema, requireDatabaseUrl, type TestSchema } from './test-schema.js';

describe('loadMigrations', () => {
  it('loads the repository migrations in filename order', async () => {
    const files = await loadMigrations();
    const names = files.map((f) => f.filename);
    expect(names).toContain('0009_practice_model.sql');
    expect(names).toEqual([...names].sort());
    expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects badly named .sql files and ignores other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
    try {
      await writeFile(join(dir, 'README.md'), 'not a migration');
      await writeFile(join(dir, '0001_ok.sql'), 'SELECT 1;');
      expect((await loadMigrations(dir)).map((f) => f.filename)).toEqual(['0001_ok.sql']);
      await writeFile(join(dir, 'add-things.sql'), 'SELECT 1;');
      await expect(loadMigrations(dir)).rejects.toThrow(/add-things\.sql/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('requireDatabaseUrl', () => {
  it('fails loudly when DATABASE_URL is missing', () => {
    expect(() => requireDatabaseUrl({})).toThrow(/DATABASE_URL is not set/);
    expect(requireDatabaseUrl({ DATABASE_URL: 'postgres://x' })).toBe('postgres://x');
  });
});

describe('runMigrations', () => {
  let db: TestSchema;
  let dir: string;

  beforeAll(async () => {
    db = await createTestSchema('migrate');
    dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  });

  afterAll(async () => {
    await db?.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('applied every repository migration when the schema was created', async () => {
    const { rows } = await db.ownerPool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toEqual((await loadMigrations()).map((f) => f.filename));
  });

  it('skips migrations that were already applied', async () => {
    const client = await db.ownerPool.connect();
    try {
      const result = await runMigrations(client);
      expect(result.applied).toEqual([]);
      expect(result.skipped).toContain('0009_practice_model.sql');
    } finally {
      client.release();
    }
  });

  it('applies new files in order, rolls back a failing one, and refuses edited history', async () => {
    const client = await db.ownerPool.connect();
    try {
      await writeFile(join(dir, '0001_first.sql'), 'CREATE TABLE runner_probe (n int);');
      await writeFile(join(dir, '0002_second.sql'), 'INSERT INTO runner_probe VALUES (2);');
      expect(await runMigrations(client, { dir })).toEqual({
        applied: ['0001_first.sql', '0002_second.sql'],
        skipped: [],
      });

      await writeFile(join(dir, '0003_broken.sql'), 'INSERT INTO runner_probe VALUES (3); SELECT nope;');
      await expect(runMigrations(client, { dir })).rejects.toThrow(/nope/);
      const probe = await client.query('SELECT n FROM runner_probe ORDER BY n');
      expect(probe.rows).toEqual([{ n: 2 }]);
      const recorded = await client.query("SELECT 1 FROM schema_migrations WHERE filename = '0003_broken.sql'");
      expect(recorded.rowCount).toBe(0);

      await rm(join(dir, '0003_broken.sql'));
      await writeFile(join(dir, '0001_first.sql'), 'CREATE TABLE runner_probe (n bigint);');
      await expect(runMigrations(client, { dir })).rejects.toThrow(/0001_first\.sql changed/);
    } finally {
      client.release();
    }
  });
});
