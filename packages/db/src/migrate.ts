import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** Directory holding the SQL migrations, applied in filename order. */
export const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

/** Migration filenames: four-digit issue number, underscore, snake_case name. */
const MIGRATION_FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Any key, shared by every schema in the cluster, so concurrent runners (for example parallel test files,
 * each migrating its own schema) never create cluster-wide objects such as roles at the same time.
 */
const MIGRATION_LOCK_KEY = 7_202_611;

export interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface RunMigrationsOptions {
  /** Defaults to `packages/db/migrations`. */
  readonly dir?: string;
}

export interface RunMigrationsResult {
  /** Filenames applied by this run, in order. */
  readonly applied: readonly string[];
  /** Filenames that were already applied and were skipped. */
  readonly skipped: readonly string[];
}

/** Reads every `.sql` file in `dir`, sorted by filename. Rejects badly named files. */
export async function loadMigrations(dir: string = migrationsDir): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const filename of names) {
    if (!MIGRATION_FILENAME.test(filename)) {
      throw new Error(`Migration filename "${filename}" must look like 0009_practice_model.sql`);
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    files.push({ filename, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

/**
 * Applies pending migrations to the connection's current schema (its `search_path`), each in its own
 * transaction, and records them in `schema_migrations`. A migration that was already applied but whose
 * file has since changed is an error: write a new migration instead of editing an old one.
 *
 * Run this as the schema owner (a migration role), never as the application role.
 */
export async function runMigrations(
  client: pg.ClientBase,
  options: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const migrations = await loadMigrations(options.dir);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE filename = $1',
        [migration.filename],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.checksum !== migration.checksum) {
          throw new Error(`Migration ${migration.filename} changed after it was applied`);
        }
        skipped.push(migration.filename);
      } else {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
          migration.filename,
          migration.checksum,
        ]);
        applied.push(migration.filename);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return { applied, skipped };
}
