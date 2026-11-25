import { describe, expect, it, vi } from 'vitest';
import { createInMemorySchedulingPorts, type SchedulingFixture } from './fakes.js';
import { SLOT_FINDING_FLAG, envFeatureFlags } from './ports.js';
import { findSlots, type SlotFindingResult } from './slot-finder.js';
import { caseFrom, loadFixture } from './test-fixture.js';

const ports = (fx: SchedulingFixture) => createInMemorySchedulingPorts(fx, { slotFindingEnabled: true });
const starts = (r: SlotFindingResult) => r.slots.map((s) => `${s.start} ${s.roomId} ${s.windowKind}`);
const codes = (r: { code: string }[]) => r.map((x) => x.code);

describe('findSlots', () => {
  it('Scenario 1: recommends an in-network ASC with privileges and returns three slots with reasons', async () => {
    const fx = loadFixture();
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));

    expect(result.status).toBe('slots_found');
    expect(result.site?.site.id).toBe('site-asc-mesa');
    expect(result.site?.site.kind).toBe('asc');
    expect(result.site?.networkStatus).toBe('in_network');
    expect(starts(result)).toEqual([
      '2026-12-10T13:00:00.000Z OR-2 released',
      '2026-12-29T13:00:00.000Z OR-1 surgeon_block',
      '2027-01-05T13:00:00.000Z OR-1 surgeon_block',
    ]);
    const first = result.slots[0]!;
    expect(first.end).toBe('2026-12-10T14:30:00.000Z');
    expect(first.siteName).toBe('Mesa Foot and Ankle ASC');
    expect(codes(first.reasons)).toEqual([
      'released_time',
      'fits_duration',
      'case_order_match',
      'within_authorization',
      'readiness_lead_time',
      'team_free',
      'within_privileges',
    ]);
    expect(first.reasons.find((r) => r.code === 'readiness_lead_time')?.message).toContain('2026-12-08');
    expect(first.reasons.find((r) => r.code === 'within_authorization')?.message).toContain('2026-12-01 to 2027-01-31');
    expect(codes(result.slots[1]!.reasons)[0]).toBe('surgeon_block');
    for (const slot of result.slots) {
      expect(slot.booking).toEqual({ approval: 'approve_first', onApproval: 'post_to_facility' });
    }
    expect(result.notes).toEqual([]);
  });

  it('never proposes a slot that overlaps booked cases or team busy time, or breaks time bounds', async () => {
    const fx = loadFixture();
    fx.surgeonPreferences['surgeon-ramos']!.caseOrder = 'any';
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    const busy = [...fx.booked.filter((b) => b.practiceId === fx.practiceId), ...fx.teamBusy];
    for (const s of result.slots) {
      expect(Date.parse(s.start)).toBeGreaterThanOrEqual(Date.parse('2026-12-08T15:00:00.000Z'));
      expect(Date.parse(s.end)).toBeLessThanOrEqual(Date.parse('2027-01-31T23:59:59.000Z'));
      expect(Date.parse(s.end) - Date.parse(s.start)).toBe(90 * 60_000);
      for (const b of busy) {
        expect(Date.parse(s.end) <= Date.parse(b.start) || Date.parse(s.start) >= Date.parse(b.end)).toBe(true);
      }
    }
    // With no case-order preference the earliest days come first and no case-order reason is given.
    expect(starts(result)).toEqual([
      '2026-12-08T15:00:00.000Z OR-1 surgeon_block',
      '2026-12-10T13:00:00.000Z OR-2 released',
      '2026-12-15T15:30:00.000Z OR-1 surgeon_block',
    ]);
    expect(codes(result.slots[0]!.reasons)).not.toContain('case_order_match');
  });

  it('ranks slots that miss the case-order preference after those that match, and says so', async () => {
    const fx = loadFixture();
    fx.blockWindows = fx.blockWindows.filter((w) => ['2026-12-08', '2026-12-15'].some((d) => w.start.startsWith(d)));
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(starts(result)).toEqual([
      '2026-12-08T15:00:00.000Z OR-1 surgeon_block',
      '2026-12-15T15:30:00.000Z OR-1 surgeon_block',
    ]);
    expect(codes(result.slots[0]!.reasons)).toContain('case_order_miss');
    expect(codes(result.notes)).toEqual(['fewer_slots']);
  });

  it('honours a last-case preference', async () => {
    const fx = loadFixture();
    fx.surgeonPreferences['surgeon-ramos']!.caseOrder = 'last_case';
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(starts(result)).toEqual([
      '2026-12-08T19:30:00.000Z OR-1 surgeon_block',
      '2026-12-10T15:30:00.000Z OR-2 released',
      '2026-12-15T19:30:00.000Z OR-1 surgeon_block',
    ]);
    expect(result.slots[0]!.reasons.find((r) => r.code === 'case_order_match')?.message).toContain('Last case');
  });

  it('reports a missed last-case preference when the block end is taken', async () => {
    const fx = loadFixture();
    fx.surgeonPreferences['surgeon-ramos']!.caseOrder = 'last_case';
    fx.blockWindows = fx.blockWindows.filter((w) => w.id === 'blk-mesa-or1-2026-12-08');
    fx.booked.push({ practiceId: fx.practiceId, facilityId: 'site-asc-mesa', roomId: 'OR-1', start: '2026-12-08T20:00:00.000Z', end: '2026-12-08T21:00:00.000Z' });
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(starts(result)).toEqual(['2026-12-08T18:30:00.000Z OR-1 surgeon_block']);
    expect(codes(result.slots[0]!.reasons)).toContain('case_order_miss');
  });

  it('later cases in a case series respect the surgeon planned spacing', async () => {
    const fx = loadFixture();
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-series-2'), now: fx.now }, ports(fx));
    // Previous case 2026-12-10; spacing 21-42 days => 2026-12-31 .. 2027-01-21.
    expect(starts(result)).toEqual([
      '2027-01-05T13:00:00.000Z OR-1 surgeon_block',
      '2027-01-12T13:00:00.000Z OR-1 surgeon_block',
      '2027-01-19T13:00:00.000Z OR-1 surgeon_block',
    ]);
    expect(result.slots[0]!.reasons.find((r) => r.code === 'series_spacing')?.message).toBe(
      "26 days after case 1 of the series, within the surgeon's planned spacing of 21-42 days",
    );
  });

  it('uses zero minimum spacing when the surgeon has none configured', async () => {
    const fx = loadFixture();
    delete fx.surgeonPreferences['surgeon-ramos']!.seriesSpacingDays;
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-series-2'), now: fx.now }, ports(fx));
    expect(result.status).toBe('slots_found');
    expect(result.slots[0]!.reasons.find((r) => r.code === 'series_spacing')?.message).toContain('at least 0 days');
  });

  it('asks for the previous case date before scheduling a later case in a series', async () => {
    const fx = loadFixture();
    const c = caseFrom(fx, 'case-bunion-series-2');
    const result = await findSlots(
      { schedulingCase: { ...c, series: { seriesId: 'series-bilateral-bunion', sequence: 2 } }, now: fx.now },
      ports(fx),
    );
    expect(result.status).toBe('missing_series_anchor');
    expect(result.slots).toEqual([]);
  });

  it('Scenario 2: a high-risk patient waits for the scheduler to choose the site', async () => {
    const fx = loadFixture();
    const c = caseFrom(fx, 'case-bunion-high');
    const waiting = await findSlots({ schedulingCase: c, now: fx.now }, ports(fx));
    expect(waiting.status).toBe('awaiting_site_choice');
    expect(waiting.siteRecommendation?.selection).toBe('human_only');
    expect(waiting.siteRecommendation?.options.map((o) => o.site.id)).toEqual(['site-asc-mesa']);
    expect(waiting.slots).toEqual([]);
    expect(codes(waiting.notes)).toContain('high_risk_human_only');

    const chosen = await findSlots({ schedulingCase: c, now: fx.now, chosenSiteId: 'site-asc-mesa' }, ports(fx));
    expect(chosen.status).toBe('slots_found');
    expect(starts(chosen)).toEqual([
      '2026-12-29T13:00:00.000Z OR-1 surgeon_block',
      '2027-01-05T13:00:00.000Z OR-1 surgeon_block',
      '2027-01-12T13:00:00.000Z OR-1 surgeon_block',
    ]);
  });

  it('refuses a chosen site that is out of network, lacks privileges, or is a hospital', async () => {
    const fx = loadFixture();
    const c = caseFrom(fx, 'case-bunion-high');
    for (const siteId of ['site-asc-saguaro', 'site-asc-paloverde', 'site-hospital-valley']) {
      const result = await findSlots({ schedulingCase: c, now: fx.now, chosenSiteId: siteId }, ports(fx));
      expect(result.status).toBe('site_not_eligible');
      expect(result.slots).toEqual([]);
    }
  });

  it('reports no eligible site when nothing passes the filters', async () => {
    const fx = loadFixture();
    fx.privileges = [];
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(result.status).toBe('no_eligible_site');
  });

  it('never proposes a slot after the surgeon privileges expire', async () => {
    const fx = loadFixture();
    fx.privileges.find((p) => p.facilityId === 'site-asc-mesa')!.validUntil = '2026-12-20T00:00:00.000Z';
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(result.slots.length).toBe(3);
    for (const s of result.slots) expect(Date.parse(s.end)).toBeLessThanOrEqual(Date.parse('2026-12-20T00:00:00.000Z'));
    expect(result.slots[0]!.reasons.find((r) => r.code === 'within_privileges')?.message).toContain('2026-12-20');
  });

  it('proposes nothing when authorization is denied', async () => {
    const fx = loadFixture();
    fx.authorizations['case-bunion-low'] = { status: 'denied' };
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(result.status).toBe('authorization_denied');
    expect(result.slots).toEqual([]);
  });

  it('flags pending, open-ended and not-required authorizations in the reasons', async () => {
    const cases: [SchedulingFixture['authorizations'][string] | undefined, string, string][] = [
      [{ status: 'pending' }, 'authorization_pending', 'pending'],
      [{ status: 'approved' }, 'within_authorization', 'Authorization approved'],
      [undefined, 'authorization_not_required', 'no authorization'],
    ];
    for (const [auth, code, text] of cases) {
      const fx = loadFixture();
      if (auth) fx.authorizations['case-bunion-low'] = auth;
      else delete fx.authorizations['case-bunion-low'];
      const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
      expect(result.status).toBe('slots_found');
      expect(result.slots[0]!.reasons.find((r) => r.code === code)?.message).toContain(text);
    }
  });

  it('returns no slots when the constraints leave no time to search', async () => {
    const fx = loadFixture();
    fx.authorizations['case-bunion-low'] = {
      status: 'approved',
      validFrom: '2026-11-01T00:00:00.000Z',
      validTo: '2026-12-05T00:00:00.000Z',
    };
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(result.status).toBe('no_slots');
    expect(codes(result.notes)).toEqual(['no_search_window']);
  });

  it('returns no slots when no block time fits', async () => {
    const fx = loadFixture();
    const result = await findSlots(
      { schedulingCase: { ...caseFrom(fx, 'case-bunion-low'), estimatedDurationMinutes: 600 }, now: fx.now },
      ports(fx),
    );
    expect(result.status).toBe('no_slots');
    expect(codes(result.notes)).toEqual(['no_slots']);
  });

  it('respects the search horizon', async () => {
    const fx = loadFixture();
    const result = await findSlots(
      { schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now, searchTo: '2026-12-12T00:00:00.000Z' },
      ports(fx),
    );
    expect(starts(result)).toEqual([
      '2026-12-10T13:00:00.000Z OR-2 released',
      '2026-12-08T15:00:00.000Z OR-1 surgeon_block',
    ]);
  });

  it('uses released and open time only where the facility shares it', async () => {
    const fx = loadFixture();
    const mesa = fx.sites.find((s) => s.id === 'site-asc-mesa')!;
    mesa.sharesReleasedTime = false;
    mesa.sharesOpenTime = true;
    fx.surgeonPreferences['surgeon-ramos']!.caseOrder = 'any';
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, ports(fx));
    expect(starts(result)).toEqual([
      '2026-12-08T15:00:00.000Z OR-1 surgeon_block',
      '2026-12-11T13:00:00.000Z OR-2 open',
      '2026-12-15T15:30:00.000Z OR-1 surgeon_block',
    ]);
    expect(result.slots[1]!.reasons[0]!.code).toBe('open_time');
  });

  it('ignores another surgeon block and another practice block or booking', async () => {
    const fx = loadFixture();
    const ownBlocks = fx.blockWindows.filter((w) => w.surgeonId === 'surgeon-ramos' && w.practiceId === fx.practiceId);
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, {
      ...ports(fx),
      blockTime: {
        // A connector that returns everything unfiltered; slot finding must still filter.
        getFacilitySchedule: async () => ({ windows: fx.blockWindows, booked: fx.booked }),
      },
    });
    const usedIds = new Set(result.slots.map((s) => s.blockWindowId));
    for (const id of usedIds) {
      expect(ownBlocks.map((w) => w.id).concat('rel-mesa-or2-2026-12-10')).toContain(id);
    }
    expect(starts(result)[1]).toBe('2026-12-29T13:00:00.000Z OR-1 surgeon_block');
  });

  it('books in the office procedure room for a local-only case when the surgeon prefers it', async () => {
    const fx = loadFixture();
    fx.surgeonPreferences['surgeon-ramos']!.preferredSiteIds = ['site-office-pr'];
    fx.surgeonPreferences['surgeon-ramos']!.caseOrder = 'any';
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-hammertoe-local'), now: fx.now }, ports(fx));
    expect(result.site?.site.kind).toBe('office_procedure_room');
    expect(starts(result)).toEqual(['2026-12-09T15:00:00.000Z PR-1 open']);
    expect(result.slots[0]!.reasons.find((r) => r.code === 'team_free')?.message).toBe('Surgeon is free');
    expect(codes(result.slots[0]!.reasons)).not.toContain('within_privileges');
  });

  it('is gated by FEATURE_SLOT_FINDING and touches no ports when off', async () => {
    const fx = loadFixture();
    const off = createInMemorySchedulingPorts(fx);
    const spy = vi.spyOn(off.facilities, 'listSites');
    const result = await findSlots({ schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now }, off);
    expect(result.status).toBe('disabled');
    expect(result.siteRecommendation).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reads the flag from the environment, defaulting to off', () => {
    expect(envFeatureFlags({}).isEnabled(SLOT_FINDING_FLAG)).toBe(false);
    expect(envFeatureFlags({ FEATURE_SLOT_FINDING: 'false' }).isEnabled(SLOT_FINDING_FLAG)).toBe(false);
    expect(envFeatureFlags({ FEATURE_SLOT_FINDING: 'true' }).isEnabled(SLOT_FINDING_FLAG)).toBe(true);
  });

  it('is deterministic for the same inputs', async () => {
    const fx = loadFixture();
    const p = ports(fx);
    const input = { schedulingCase: caseFrom(fx, 'case-bunion-low'), now: fx.now };
    expect(await findSlots(input, p)).toEqual(await findSlots(input, p));
  });
});
