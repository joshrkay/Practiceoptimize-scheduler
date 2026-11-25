import type { Pool, QueryResult } from 'pg';
import type { BillableEventStore } from './store.js';
import type { BillableEvent } from './types.js';

interface Row {
  practice_id: string;
  location_id: string;
  case_reference: string;
  series_id: string | null;
  urgent_add_on: boolean;
  booked_at: Date;
}

type Query = (sql: string, params: unknown[]) => Promise<QueryResult<Row>>;

/**
 * PostgreSQL implementation (migration 0094_billable_events.sql). Every statement runs in a
 * transaction that sets `app.practice_id` so row-level security applies, and filters by practice_id.
 */
export class PgBillableEventStore implements BillableEventStore {
  constructor(private readonly pool: Pool) {}

  private async inPractice<T>(practiceId: string, fn: (q: Query) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.practice_id', $1, true)", [practiceId]);
      const result = await fn((sql, params) => client.query<Row>(sql, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  append(e: BillableEvent): Promise<boolean> {
    return this.inPractice(e.practiceId, async (q) => {
      const res = await q(
        `INSERT INTO billable_events
           (practice_id, location_id, case_reference, series_id, urgent_add_on, booked_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (practice_id, case_reference) DO NOTHING`,
        [e.practiceId, e.locationId, e.caseReference, e.seriesId, e.urgentAddOn, e.bookedAt],
      );
      return (res.rowCount ?? 0) === 1;
    });
  }

  listForPractice(
    practiceId: string,
    startInclusive: string,
    endExclusive: string,
  ): Promise<BillableEvent[]> {
    return this.inPractice(practiceId, async (q) => {
      const res = await q(
        `SELECT practice_id, location_id, case_reference, series_id, urgent_add_on, booked_at
           FROM billable_events
          WHERE practice_id = $1 AND booked_at >= $2 AND booked_at < $3
          ORDER BY booked_at, case_reference`,
        [practiceId, startInclusive, endExclusive],
      );
      return res.rows.map((r) => ({
        practiceId: r.practice_id,
        locationId: r.location_id,
        caseReference: r.case_reference,
        seriesId: r.series_id,
        urgentAddOn: r.urgent_add_on,
        bookedAt: r.booked_at.toISOString(),
      }));
    });
  }
}
