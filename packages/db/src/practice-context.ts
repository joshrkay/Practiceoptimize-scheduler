import type { Queryable } from './queryable.js';

/** The PostgreSQL setting row-level security policies read (see migration 0010). */
export const PRACTICE_SETTING = 'app.practice_id';

/** The application database role: not a superuser, no BYPASSRLS. */
export const APP_ROLE = 'scheduler_app';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A checked-out connection, as returned by `pg.Pool#connect()`. */
export interface PooledConnection extends Queryable {
  release(destroy?: boolean | Error): void;
}

/** Anything that hands out pooled connections, such as a `pg.Pool`. */
export interface ConnectionPool {
  connect(): Promise<PooledConnection>;
}

export class PracticeContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PracticeContextError';
  }
}

/**
 * Runs `work` in one transaction scoped to a practice: every query sees and writes only that practice's
 * rows, enforced by row-level security.
 *
 * `practiceId` must come from the authenticated session (the signed-in user's practice, or the practice a
 * job was enqueued for by authenticated code), never from a request body or model output.
 *
 * The setting is transaction-local (`set_config(..., true)`), so it is gone when the connection returns to
 * the pool. The call refuses to run on a connection whose role is a superuser or has BYPASSRLS, because
 * row-level security would not apply there.
 */
export async function withPracticeTransaction<T>(
  pool: ConnectionPool,
  practiceId: string,
  work: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (!UUID.test(practiceId)) {
    throw new PracticeContextError('A practice-scoped transaction needs a practice id (UUID)');
  }
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ bypasses_rls: boolean }>(
        `SELECT set_config($1, $2, true) AS practice_id,
                (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls`,
        [PRACTICE_SETTING, practiceId],
      );
      if (rows[0]?.bypasses_rls !== false) {
        throw new PracticeContextError(
          `Refusing a practice-scoped transaction as a role that bypasses row-level security; connect as ${APP_ROLE}`,
        );
      }
      const tx: Queryable = { query: (text, values) => client.query(text, values) };
      const result = await work(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        broken = rollbackError as Error;
      }
      throw error;
    }
  } finally {
    client.release(broken ?? false);
  }
}
