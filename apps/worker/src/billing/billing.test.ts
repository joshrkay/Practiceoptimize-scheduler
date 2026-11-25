import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CSV_HEADER,
  InMemoryBillableEventStore,
  InMemoryBookedEventSource,
  buildMonthlyUsageReport,
  createMetering,
  formatMonth,
  isMeteringEnabled,
  monthOf,
  monthRange,
  monthToDateUsage,
  usageReportToCsv,
  type CaseReachedBookedEvent,
} from './index.js';

interface FixtureEvent extends CaseReachedBookedEvent {
  label: string;
}
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../tests/fixtures/billing/month-of-cases.json', import.meta.url)),
    'utf8',
  ),
) as { practiceId: string; month: { year: number; month: number }; expectedBillable: number; events: FixtureEvent[] };

const P = 'practice-foot-ankle-a';
const ev = (over: Partial<CaseReachedBookedEvent> = {}): CaseReachedBookedEvent => ({
  practiceId: P,
  locationId: 'loc-main-office',
  caseReference: 'case-x',
  urgentAddOn: false,
  caseType: 'bunionectomy',
  occurredAt: '2026-11-03T14:00:00Z',
  ...over,
});

describe('metering', () => {
  it('counts a case booked, cancelled, reopened and rebooked once (scenario 1)', async () => {
    const store = new InMemoryBillableEventStore();
    const m = createMetering({ store, enabled: true });
    expect(await m.recordBooked(ev())).toBe('recorded');
    expect(await m.recordBooked(ev({ occurredAt: '2026-11-20T10:00:00Z' }))).toBe('duplicate');
    const report = await buildMonthlyUsageReport(store, P, { year: 2026, month: 11 });
    expect(report.totalBillableCases).toBe(1);
  });

  it('ignores reschedules and case-type changes', async () => {
    const store = new InMemoryBillableEventStore();
    const m = createMetering({ store, enabled: true });
    await m.recordBooked(ev());
    expect(await m.recordBooked(ev({ caseType: 'ankle-fusion' }))).toBe('duplicate');
    expect(await m.recordBooked(ev({ occurredAt: '2026-12-02T10:00:00Z' }))).toBe('duplicate');
    const dec = await buildMonthlyUsageReport(store, P, { year: 2026, month: 12 });
    expect(dec.totalBillableCases).toBe(0);
  });

  it('bills two series cases and an urgent add-on separately, with no PHI in the CSV (scenario 2)', async () => {
    const store = new InMemoryBillableEventStore();
    const m = createMetering({ store, enabled: true });
    await m.recordBooked(ev({ caseReference: 'case-2001', seriesId: 'series-1' }));
    await m.recordBooked(ev({ caseReference: 'case-2002', seriesId: 'series-1' }));
    await m.recordBooked(ev({ caseReference: 'case-3001', urgentAddOn: true, caseType: 'abscess-drainage' }));
    const report = await buildMonthlyUsageReport(store, P, { year: 2026, month: 11 });
    expect(report.totalBillableCases).toBe(3);
    expect(report.locations[0]?.urgentAddOns).toBe(1);
    const csv = usageReportToCsv(report);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines).toHaveLength(4);
    expect(csv).not.toMatch(/abscess|bunion|patient|name|mrn/i);
  });

  it('keeps the same reference in different practices separate', async () => {
    const store = new InMemoryBillableEventStore();
    const m = createMetering({ store, enabled: true });
    expect(await m.recordBooked(ev())).toBe('recorded');
    expect(await m.recordBooked(ev({ practiceId: 'practice-b' }))).toBe('recorded');
    expect((await buildMonthlyUsageReport(store, 'practice-b', { year: 2026, month: 11 })).totalBillableCases).toBe(1);
  });

  it('records nothing when the feature is off, and reads FEATURE_METERING', async () => {
    const store = new InMemoryBillableEventStore();
    expect(await createMetering({ store, enabled: false }).recordBooked(ev())).toBe('disabled');
    expect((await buildMonthlyUsageReport(store, P, { year: 2026, month: 11 })).totalBillableCases).toBe(0);
    expect(isMeteringEnabled({})).toBe(false);
    expect(isMeteringEnabled({ FEATURE_METERING: 'true' })).toBe(true);
    expect(isMeteringEnabled({ FEATURE_METERING: 'false' })).toBe(false);
    vi.stubEnv('FEATURE_METERING', 'TRUE');
    expect(isMeteringEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });

  it('rejects malformed events', async () => {
    const m = createMetering({ store: new InMemoryBillableEventStore(), enabled: true });
    await expect(m.recordBooked(ev({ practiceId: '' }))).rejects.toThrow(/practiceId/);
    await expect(m.recordBooked(ev({ caseReference: '' }))).rejects.toThrow(/caseReference/);
    await expect(m.recordBooked(ev({ occurredAt: 'nope' }))).rejects.toThrow(RangeError);
  });

  it('consumes events from the state-machine port and can unsubscribe', async () => {
    const store = new InMemoryBillableEventStore();
    const source = new InMemoryBookedEventSource();
    const off = createMetering({ store, enabled: true }).attach(source);
    await source.emit(ev());
    off();
    await source.emit(ev({ caseReference: 'case-y' }));
    expect((await monthToDateUsage(store, P, new Date('2026-11-25T00:00:00Z'))).totalBillableCases).toBe(1);
  });
});

describe('usage report', () => {
  it('reproduces the month-of-cases fixture by practice and location', async () => {
    const store = new InMemoryBillableEventStore();
    const m = createMetering({ store, enabled: true });
    for (const { label: _label, ...e } of fixture.events) await m.recordBooked(e);
    const report = await buildMonthlyUsageReport(store, fixture.practiceId, fixture.month);
    expect(report.totalBillableCases).toBe(fixture.expectedBillable);
    expect(report.locations.map((l) => [l.locationId, l.billableCases])).toEqual([
      ['loc-asc-east', 3],
      ['loc-main-office', 4],
    ]);
    const csv = usageReportToCsv(report);
    expect(csv.split('\r\n')).toHaveLength(fixture.expectedBillable + 2);
    expect(csv).not.toContain('practice-foot-ankle-b');
    expect(csv).not.toContain('case-0901');
  });

  it('month-to-date uses the current month and excludes later bookings', async () => {
    const store = new InMemoryBillableEventStore();
    const m = createMetering({ store, enabled: true });
    await m.recordBooked(ev({ caseReference: 'a', occurredAt: '2026-11-01T00:00:00Z' }));
    await m.recordBooked(ev({ caseReference: 'b', occurredAt: '2026-12-01T00:00:00Z' }));
    const r = await monthToDateUsage(store, P, new Date('2026-11-30T23:00:00Z'));
    expect(r.totalBillableCases).toBe(1);
    expect((await monthToDateUsage(store, P)).practiceId).toBe(P);
  });

  it('escapes CSV cells and neutralizes formulas', () => {
    const csv = usageReportToCsv({
      practiceId: P,
      month: { year: 2026, month: 11 },
      totalBillableCases: 1,
      locations: [
        {
          locationId: 'loc,"1"',
          billableCases: 1,
          urgentAddOns: 0,
          cases: [
            { practiceId: P, locationId: 'loc,"1"', caseReference: '=cmd', seriesId: null, urgentAddOn: false, bookedAt: '2026-11-01T00:00:00.000Z' },
          ],
        },
      ],
    });
    expect(csv).toContain('"loc,""1"""');
    expect(csv).toContain(",'=cmd,");
  });

  it('validates months', () => {
    expect(() => monthRange({ year: 2026, month: 13 })).toThrow(RangeError);
    expect(() => monthOf('garbage')).toThrow(RangeError);
    expect(formatMonth({ year: 2026, month: 3 })).toBe('2026-03');
    expect(monthRange({ year: 2026, month: 12 }).end).toBe('2027-01-01T00:00:00.000Z');
  });
});
