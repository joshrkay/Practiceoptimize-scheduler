import type { BillableEvent } from './types.js';

/** Append-only storage for billable events. There is deliberately no update or delete. */
export interface BillableEventStore {
  /**
   * Appends the event unless this practice already has one for the case reference.
   * Returns true when a new event was written, false when it was a duplicate.
   */
  append(event: BillableEvent): Promise<boolean>;
  /** Events for one practice with bookedAt in [startInclusive, endExclusive), ordered by bookedAt then reference. */
  listForPractice(
    practiceId: string,
    startInclusive: string,
    endExclusive: string,
  ): Promise<BillableEvent[]>;
}
