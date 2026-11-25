/** A de-identified, append-only billable event. Contains no PHI. */
export interface BillableEvent {
  practiceId: string;
  locationId: string;
  caseReference: string;
  seriesId: string | null;
  urgentAddOn: boolean;
  /** When the case first reached Booked (ISO 8601, UTC). Decides the billing month. */
  bookedAt: string;
}

/** Calendar month in UTC, e.g. { year: 2026, month: 11 }. */
export interface BillingMonth {
  year: number;
  /** 1-12 */
  month: number;
}

export function monthRange(m: BillingMonth): { start: string; end: string } {
  if (!Number.isInteger(m.year) || !Number.isInteger(m.month) || m.month < 1 || m.month > 12) {
    throw new RangeError(`invalid billing month ${m.year}-${m.month}`);
  }
  return {
    start: new Date(Date.UTC(m.year, m.month - 1, 1)).toISOString(),
    end: new Date(Date.UTC(m.year, m.month, 1)).toISOString(),
  };
}

export function monthOf(iso: string): BillingMonth {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid timestamp ${iso}`);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function formatMonth(m: BillingMonth): string {
  return `${m.year}-${String(m.month).padStart(2, '0')}`;
}
