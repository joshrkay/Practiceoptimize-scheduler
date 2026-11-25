import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeAlerts,
  FakeApprovals,
  FakeClock,
  FakeCoordination,
  FakeDirectory,
  FakeFacilities,
  FakePreferences,
  InMemoryVendorStore,
  nth,
} from './fakes.js';
import {
  directoryRep,
  hammertoeCase,
  mtpFusionCase,
  noImplantCase,
  preferredRep,
} from './fixtures.js';
import { initialsOf, toVendorRequestFields } from './phi.js';
import { defaultVendorPolicy } from './ports.js';
import type { VendorPolicyPort } from './ports.js';
import { VendorService } from './service.js';

const NOW = new Date('2026-11-25T12:00:00Z');
const autonomous: VendorPolicyPort = { modeFor: () => Promise.resolve('autonomous') };

function setup(opts: { policy?: VendorPolicyPort; leadDays?: number; prefs?: boolean; enabled?: boolean } = {}) {
  const coordination = new FakeCoordination();
  const approvals = new FakeApprovals();
  const alerts = new FakeAlerts();
  const clock = new FakeClock(NOW);
  const store = new InMemoryVendorStore();
  const service = new VendorService({
    coordination,
    approvals,
    alerts,
    clock,
    store,
    preferences: new FakePreferences(opts.prefs === false ? {} : { 'surgeon-1': preferredRep }),
    directory: new FakeDirectory(directoryRep),
    facilities: new FakeFacilities({
      'asc-1': { name: 'Lakeside ASC', timezone: 'America/New_York', trayLeadTimeDays: opts.leadDays ?? 5 },
    }),
    policy: opts.policy ?? autonomous,
    ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
  });
  return { service, coordination, approvals, alerts, clock, store };
}

describe('PHI allowlist', () => {
  it('sends initials and case reference only, never name, DOB or diagnosis', async () => {
    const { service, coordination } = setup();
    await service.onSlotApproved(mtpFusionCase);
    const m = nth(coordination.sent, 0);
    const text = `${m.subject}\n${m.body}\n${JSON.stringify(m)}`;
    for (const secret of ['Zelda', 'Testpatient', '1961', '07-19', 'Hallux', 'rigidus', 'arthritis']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('ZT');
    expect(text).toContain('CASE-1041');
  });

  it('mapper output has exactly the allowlisted keys', () => {
    const f = toVendorRequestFields(mtpFusionCase, { name: 'Lakeside ASC', timezone: 'America/New_York' });
    expect(Object.keys(f).sort()).toEqual(
      [
        'caseRef', 'date', 'facilityName', 'implantSystem', 'patientInitials',
        'procedure', 'specialEquipment', 'startTime', 'trayNeeds',
      ].sort(),
    );
    expect(f.date).toBe('2026-12-05');
    expect(f.startTime).toBe('9:30 AM');
    expect(initialsOf(' ann', 'bo')).toBe('AB');
  });
});

describe('request creation', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('sends date, time, facility, procedure, implant system and trays to the preferred rep', async () => {
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    expect(r.status).toBe('sent');
    const m = nth(ctx.coordination.sent, 0);
    expect(m.to).toEqual(preferredRep);
    for (const s of ['2026-12-05', '9:30 AM', 'Lakeside ASC', 'First MTP joint fusion', 'ToeFuse Plate Set', 'Fusion plate tray']) {
      expect(m.body).toContain(s);
    }
  });

  it('falls back to the directory when no preference exists', async () => {
    ctx = setup({ prefs: false });
    await ctx.service.onSlotApproved(hammertoeCase);
    expect(nth(ctx.coordination.sent, 0).to).toEqual(directoryRep);
  });

  it('reports no_rep when nobody is found', async () => {
    const s = new VendorService({
      ...{
        coordination: ctx.coordination, approvals: ctx.approvals, alerts: ctx.alerts,
        clock: ctx.clock, store: ctx.store,
      },
      preferences: new FakePreferences(),
      directory: new FakeDirectory(null),
      facilities: new FakeFacilities({}),
    });
    expect(await s.onSlotApproved(mtpFusionCase)).toEqual({ status: 'no_rep' });
  });

  it('creates no request for a case without implants or special equipment', async () => {
    expect(await ctx.service.onSlotApproved(noImplantCase)).toEqual({ status: 'no_request' });
    expect(ctx.coordination.sent).toHaveLength(0);
  });

  it('creates a request for special equipment alone', async () => {
    await ctx.service.onSlotApproved({ ...noImplantCase, specialEquipment: ['Mini C-arm'] });
    expect(nth(ctx.coordination.sent, 0).body).toContain('None (equipment only)');
    expect(nth(ctx.coordination.sent, 0).body).toContain('Mini C-arm');
  });

  it('does nothing when the feature flag is off', async () => {
    ctx = setup({ enabled: false });
    expect(await ctx.service.onSlotApproved(mtpFusionCase)).toEqual({ status: 'no_request' });
  });

  it('does not double-send for the same case', async () => {
    await ctx.service.onSlotApproved(mtpFusionCase);
    const again = await ctx.service.onSlotApproved(mtpFusionCase);
    expect(again.status).toBe('duplicate');
    expect(ctx.coordination.sent).toHaveLength(1);
  });
});

describe('approve-first policy', () => {
  it('defaults to approve-first and queues instead of sending', async () => {
    const ctx = setup({ policy: defaultVendorPolicy });
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    expect(r.status).toBe('awaiting_approval');
    expect(ctx.coordination.sent).toHaveLength(0);
    expect(ctx.approvals.items).toHaveLength(1);
    const item = nth(ctx.approvals.items, 0);
    expect(await ctx.service.approve(item.requestId, item.pendingId)).toBe(true);
    expect(ctx.coordination.sent).toHaveLength(1);
    expect((await ctx.store.get(item.requestId))?.status).toBe('active');
    expect(await ctx.service.approve(item.requestId, item.pendingId)).toBe(false);
    expect(await ctx.service.approve('nope', 'x')).toBe(false);
  });

  it('cancelling before approval sends nothing', async () => {
    const ctx = setup({ policy: defaultVendorPolicy });
    await ctx.service.onSlotApproved(mtpFusionCase);
    expect(await ctx.service.onCaseCancelled('practice-1', 'case-mtp-1')).toBe(true);
    expect(ctx.coordination.sent).toHaveLength(0);
    expect(await ctx.service.onCaseCancelled('practice-1', 'case-mtp-1')).toBe(false);
  });
});

describe('confirmation tracking and re-confirmation', () => {
  it('Scenario 1: rep says yes, then re-confirmation goes out 48h before surgery', async () => {
    const ctx = setup();
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    if (r.status !== 'sent') throw new Error('expected sent');
    const rec = await ctx.service.recordReply(r.requestId, { attendance: 'confirmed', trayDelivery: 'confirmed' });
    expect(rec?.attendance).toBe('confirmed');
    expect(rec?.trayDelivery).toBe('confirmed');

    // Too early: 10 days out.
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([]);
    // 47 hours before start.
    ctx.clock.set(new Date('2026-12-03T15:30:00Z'));
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([r.requestId]);
    expect(ctx.coordination.sent.map((m) => m.kind)).toEqual(['request', 'reconfirm']);
    // Only once.
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([]);
    // After surgery start nothing goes out.
    expect(ctx.coordination.sent).toHaveLength(2);
  });

  it('records a decline and ignores replies for unknown or cancelled requests', async () => {
    const ctx = setup();
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    if (r.status !== 'sent') throw new Error('expected sent');
    expect((await ctx.service.recordReply(r.requestId, { trayDelivery: 'declined' }))?.trayDelivery).toBe('declined');
    expect(await ctx.service.recordReply('missing', { attendance: 'confirmed' })).toBeNull();
    await ctx.service.onCaseCancelled('practice-1', 'case-mtp-1');
    expect(await ctx.service.recordReply(r.requestId, { attendance: 'confirmed' })).toBeNull();
  });

  it('skips the re-confirmation when the request itself went out inside the window', async () => {
    const ctx = setup();
    ctx.clock.set(new Date('2026-12-04T12:00:00Z'));
    await ctx.service.onSlotApproved(mtpFusionCase);
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([]);
  });

  it('skips reconfirmation for surgeries already started and queues it under approve-first', async () => {
    const ctx = setup({ policy: defaultVendorPolicy });
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    if (r.status !== 'awaiting_approval') throw new Error('expected queue');
    await ctx.service.approve(r.requestId, nth(ctx.approvals.items, 0).pendingId);
    ctx.clock.set(new Date('2026-12-03T15:30:00Z'));
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([r.requestId]);
    expect(nth(ctx.approvals.items, 1).kind).toBe('reconfirm');
    // Already queued: not queued twice.
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([]);
    ctx.clock.set(new Date('2026-12-06T00:00:00Z'));
    expect(await ctx.service.runReconfirmations('practice-1')).toEqual([]);
  });
});

describe('lead time', () => {
  it('Scenario 2: 5-day tray lead, case 3 days out: sent and flagged', async () => {
    const ctx = setup({ leadDays: 5 });
    ctx.clock.set(new Date('2026-12-02T14:30:00Z'));
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    expect(r.status).toBe('sent');
    if (r.status !== 'sent') return;
    expect(r.leadTimeRisk).toMatchObject({ requiredDays: 5, actualDays: 3 });
    expect(ctx.coordination.sent).toHaveLength(1);
    expect(ctx.alerts.flags).toEqual([
      expect.objectContaining({ code: 'vendor_lead_time_risk', caseId: 'case-mtp-1' }),
    ]);
  });

  it('does not flag when lead time is met', async () => {
    const ctx = setup({ leadDays: 5 });
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    expect(r).toMatchObject({ status: 'sent', leadTimeRisk: null });
    expect(ctx.alerts.flags).toHaveLength(0);
  });
});

describe('changes and cancellation', () => {
  it('a date change sends an updated request and resets confirmations', async () => {
    const ctx = setup();
    const r = await ctx.service.onSlotApproved(mtpFusionCase);
    if (r.status !== 'sent') throw new Error('expected sent');
    await ctx.service.recordReply(r.requestId, { attendance: 'confirmed', trayDelivery: 'confirmed' });
    const moved = { ...mtpFusionCase, surgeryStart: '2026-12-08T13:00:00Z' };
    expect(await ctx.service.onCaseChanged(moved)).toBe('updated');
    const m = nth(ctx.coordination.sent, 1);
    expect(m.kind).toBe('update');
    expect(m.body).toContain('2026-12-08');
    expect(m.body).toContain('Changed: date, start time');
    expect(m.body).not.toContain('Zelda');
    const rec = await ctx.store.get(r.requestId);
    expect(rec?.attendance).toBe('pending');
    expect(rec?.surgeryStart).toBe(moved.surgeryStart);
    expect(await ctx.service.onCaseChanged(moved)).toBe('unchanged');
  });

  it('sends a cancellation notice with no tray or patient detail', async () => {
    const ctx = setup();
    await ctx.service.onSlotApproved(mtpFusionCase);
    expect(await ctx.service.onCaseCancelled('practice-1', 'case-mtp-1')).toBe(true);
    const m = nth(ctx.coordination.sent, 1);
    expect(m.kind).toBe('cancel');
    expect(m.subject).toContain('CANCELLED');
    expect(m.body).not.toContain('ZT');
  });

  it('cancels when implants are removed from the case', async () => {
    const ctx = setup();
    await ctx.service.onSlotApproved(mtpFusionCase);
    expect(await ctx.service.onCaseChanged({ ...mtpFusionCase, implantSystem: null })).toBe('cancelled');
    expect(nth(ctx.coordination.sent, 1).kind).toBe('cancel');
  });

  it('creates a request when a change adds implants to a case with none', async () => {
    const ctx = setup();
    expect(await ctx.service.onCaseChanged(noImplantCase)).toBe('unchanged');
    expect(await ctx.service.onCaseChanged({ ...noImplantCase, implantSystem: 'HammerFix Implant (synthetic)' })).toBe('created');
    expect(ctx.coordination.sent).toHaveLength(1);
  });
});
