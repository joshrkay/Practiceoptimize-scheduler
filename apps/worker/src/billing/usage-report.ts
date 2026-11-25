import type { BillableEventStore } from './store.js';
import { formatMonth, monthOf, monthRange, type BillableEvent, type BillingMonth } from './types.js';

export interface LocationUsage {
  locationId: string;
  billableCases: number;
  urgentAddOns: number;
  cases: BillableEvent[];
}

export interface UsageReport {
  practiceId: string;
  month: BillingMonth;
  totalBillableCases: number;
  locations: LocationUsage[];
}

export async function buildMonthlyUsageReport(
  store: BillableEventStore,
  practiceId: string,
  month: BillingMonth,
): Promise<UsageReport> {
  const { start, end } = monthRange(month);
  const events = await store.listForPractice(practiceId, start, end);
  const byLocation = new Map<string, BillableEvent[]>();
  for (const e of events) {
    const list = byLocation.get(e.locationId) ?? [];
    list.push(e);
    byLocation.set(e.locationId, list);
  }
  const locations = [...byLocation.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locationId, cases]) => ({
      locationId,
      billableCases: cases.length,
      urgentAddOns: cases.filter((c) => c.urgentAddOn).length,
      cases,
    }));
  return { practiceId, month, totalBillableCases: events.length, locations };
}

/** Month-to-date billable cases for the practice usage page. `now` decides the month (UTC). */
export function monthToDateUsage(
  store: BillableEventStore,
  practiceId: string,
  now: Date = new Date(),
): Promise<UsageReport> {
  return buildMonthlyUsageReport(store, practiceId, monthOf(now.toISOString()));
}

function csvCell(value: string): string {
  // Neutralize spreadsheet formula injection, then apply RFC 4180 quoting.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CSV_HEADER = [
  'practice_id',
  'month',
  'location_id',
  'case_reference',
  'series_id',
  'urgent_add_on',
  'booked_at',
  'billable_quantity',
] as const;

/** One line per billable case (quantity 1) so a billing tool can sum or group. No PHI columns exist. */
export function usageReportToCsv(report: UsageReport): string {
  const lines: string[] = [CSV_HEADER.join(',')];
  for (const loc of report.locations) {
    for (const c of loc.cases) {
      lines.push(
        [
          report.practiceId,
          formatMonth(report.month),
          loc.locationId,
          c.caseReference,
          c.seriesId ?? '',
          c.urgentAddOn ? 'true' : 'false',
          c.bookedAt,
          '1',
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
