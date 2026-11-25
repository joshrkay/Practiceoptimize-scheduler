import type { AuditEvent, AuditSink } from './types.js';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** INSERT-only PostgreSQL sink. The table has no update or delete path. */
export class PgAuditSink implements AuditSink {
  constructor(private readonly db: Queryable) {}

  async append(e: AuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events (id, practice_id, location_id, actor_type, actor_id, action,
         target_type, target_id, inputs_hash, result, autonomy_tier, approver_id,
         external_transaction_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        e.id, e.practiceId, e.locationId, e.actor.type, e.actor.id, e.action,
        e.target.type, e.target.id, e.inputsHash, e.result, e.autonomyTier, e.approverId,
        e.externalTransactionId, e.occurredAt,
      ],
    );
  }
}
