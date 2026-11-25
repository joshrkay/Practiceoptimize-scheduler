import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from './migrate.js';

/** A migrated, uniquely named schema for one test file. Call `drop()` in `afterAll`. */
export interface TestSchema {
  readonly schema: string;
  readonly connectionString: string;
  /** Pool connected as the `DATABASE_URL` user (the schema owner), with `search_path` set to the schema. */
  readonly ownerPool: pg.Pool;
  /** Opens another pool on the schema, optionally switching to `role` at connection start. */
  pool(options?: { role?: string }): pg.Pool;
  /** Ends every pool this helper opened and drops the schema. */
  drop(): Promise<void>;
}

/**
 * Reads `DATABASE_URL`. Throws when it is missing so database tests fail loudly in CI instead of being
 * skipped.
 */
export function requireDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env['DATABASE_URL'];
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Database tests need PostgreSQL 16; see .env.example (CI provides a postgres service).',
    );
  }
  return url;
}

/**
 * Creates a schema named `<prefix>_<random>`, applies every migration to it, and returns pools scoped to it.
 * Each test file gets its own schema so files can run in parallel against one database.
 */
export async function createTestSchema(prefix = 'test'): Promise<TestSchema> {
  const connectionString = requireDatabaseUrl();
  const schema = `${prefix.toLowerCase().replace(/[^a-z0-9_]/g, '_')}_${randomBytes(6).toString('hex')}`;
  const pools: pg.Pool[] = [];
  const open = (role?: string): pg.Pool => {
    const settings = [`-c search_path=${schema}`];
    if (role) settings.push(`-c role=${role}`);
    const pool = new pg.Pool({ connectionString, options: settings.join(' '), max: 4 });
    pools.push(pool);
    return pool;
  };

  const ownerPool = open();
  await ownerPool.query(`CREATE SCHEMA "${schema}"`);
  const client = await ownerPool.connect();
  try {
    await runMigrations(client);
  } finally {
    client.release();
  }

  return {
    schema,
    connectionString,
    ownerPool,
    pool: (options = {}) => open(options.role),
    drop: async () => {
      await ownerPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.all(pools.map((pool) => pool.end()));
    },
  };
}
