/**
 * Minimal shape of a readiness item as this module needs it. The checklist generator
 * (packages/case-model/src/readiness) owns the real type; wire it to this at integration.
 */
export type ItemOwner = 'scheduler' | 'outreach' | 'coordination';

/** open: not yet satisfied. done: satisfied. flagged: result outside the rule's threshold. */
export type ItemState = 'open' | 'done' | 'flagged';

export interface TrackedItem {
  readonly id: string;
  /** Human label shown in the Today view, for example "Cardiac clearance". */
  readonly label: string;
  readonly required: boolean;
  readonly state: ItemState;
  readonly owner: ItemOwner;
  /** Due date; defaults to the cutoff date (surgery date minus cutoff days). */
  readonly dueAt?: Date;
  /** Days before the due date at which the item counts as at risk. Default 3. */
  readonly warningWindowDays?: number;
  /** Set when done; a done item whose expiry has passed is expired. */
  readonly expiresAt?: Date;
  /** Last time a reminder was requested from the owning journey. */
  readonly lastReminderAt?: Date;
}

export interface TrackedCase {
  readonly caseId: string;
  readonly practiceId: string;
  readonly surgeryDate: Date;
  /** Urgent add-ons are not tracked for readiness. */
  readonly urgentAddOn: boolean;
  readonly items: readonly TrackedItem[];
}
