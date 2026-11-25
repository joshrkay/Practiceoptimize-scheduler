import type { QueryResult, QueryResultRow } from 'pg';

/** Anything that runs a parameterized query: a `pg.Pool`, a `pg.Client`, or a checked-out pool client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}
