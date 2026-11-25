import { describe, expect, it } from 'vitest';
import { isBusinessDay, subtractBusinessDays } from './business-days.js';
import {
  FakeAlerts,
  FakeCaseData,
  FakeClock,
  FakeHolidays,
  FakeOpenItems,
  FakePolicy,
  FakeRules,
  FakeSender,
  FakeStore,
} from './fakes.js';
import type { CaseDocument, CaseInfo } from './ports.js';
import { createPatPacketService } from './service.js';

const PRACTICE = 'practice-synthetic-1';
const CASE = 'case-bunionectomy-1';
const FACILITY = 'asc-synthetic-podiatry-1';

const doc = (id: string, type: string, extra: Partial<CaseDocument> = {}): CaseDocument => ({
  id,
  caseId: CASE,
  type,
  title: `${type} ${id}`,
  restricted: false,
  ready: true,
  receivedAt: '2026-11-20T10:00:00Z',
  ...extra,
});

// ASC fixture (the issue names a hospital fixture; hospitals are out of scope for the pilot).
const ascCase: CaseInfo = {
  caseId: CASE,
  practiceId: PRACTICE,
  facilityId: FACILITY,
  surgeryDate: '2026-12-08', // Tuesday; default cutoff is Tuesday 2026-12-01
  siteOfService: 'asc',
  anesthesia: 'mac',
  patientLabel: 'Synthetic Patient A',
  procedureLabel: 'Bunionectomy, left foot',
};

function setup(opts: { today?: string; holidays?: string[]; info?: Partial<CaseInfo> } = {}) {
  const cases = new FakeCaseData();
  cases.cases.set(CASE, { ...ascCase, ...opts.info });
  const rules = new FakeRules();
  rules.rules.set(FACILITY, {
    facilityId: FACILITY,
    // Deliberately not alphabetical: facility order must be preserved.
    requiredDocumentTypes: ['h_and_p', 'clearance', 'labs', 'consent'],
    channel: { kind: 'fax', destinationId: 'fax-pat-asc-1' },
  });
  const clock = new FakeClock(opts.today ?? '2026-12-01');
  const sender = new FakeSender();
  const alerts = new FakeAlerts();
  const openItems = new FakeOpenItems();
  const policy = new FakePolicy();
  const store = new FakeStore();
  const service = createPatPacketService({
    cases,
    rules,
    clock,
    holidays: new FakeHolidays(new Set(opts.holidays ?? [])),
    sender,
    alerts,
    openItems,
    policy,
    store,
    featureEnabled: () => true,
  });
  const complete = [
    doc('d-consent', 'consent'),
    doc('d-labs', 'labs'),
    doc('d-clear', 'clearance'),
    doc('d-hp', 'h_and_p'),
  ];
  return { cases, rules, clock, sender, alerts, openItems, policy, store, service, complete };
}

describe('business days', () => {
  it('skips weekends', () => {
    expect(new Date('2026-12-09T00:00:00Z').getUTCDay()).toBe(3); // Wednesday
    expect(subtractBusinessDays('2026-12-09', 5, new Set())).toBe('2026-12-02');
    expect(subtractBusinessDays('2026-12-07', 1, new Set())).toBe('2026-12-04'); // Monday -> Friday
    expect(subtractBusinessDays('2026-12-07', 0, new Set())).toBe('2026-12-07');
  });
  it('skips holidays', () => {
    expect(subtractBusinessDays('2026-12-01', 5, new Set())).toBe('2026-11-24');
    expect(subtractBusinessDays('2026-12-01', 5, new Set(['2026-11-26']))).toBe('2026-11-23');
    expect(isBusinessDay('2026-11-26', new Set(['2026-11-26']))).toBe(false);
    expect(isBusinessDay('2026-12-05', new Set())).toBe(false);
    expect(isBusinessDay('2026-12-04', new Set())).toBe(true);
  });
});

describe('PAT packet', () => {
  it('scenario 1: complete packet sent early in facility order with a cover sheet', async () => {
    const t = setup({ today: '2026-11-30' });
    t.cases.documents.set(CASE, t.complete);
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r.status).toBe('sent');
    expect(t.sender.sent).toHaveLength(1);
    const sent = t.sender.sent[0]!;
    expect(sent.documentIds).toEqual(['d-hp', 'd-clear', 'd-labs', 'd-consent']);
    expect(sent.kind).toBe('original');
    expect(sent.channel).toEqual({ kind: 'fax', destinationId: 'fax-pat-asc-1' });
    expect(sent.coverSheet).toContain('1. h_and_p d-hp (h_and_p)');
    expect(sent.coverSheet).toContain('4. consent d-consent (consent)');
    expect(sent.coverSheet).not.toContain('Pending');
    expect(t.alerts.alerts).toHaveLength(0);
  });

  it('waits before cutoff when something is missing', async () => {
    const t = setup({ today: '2026-11-30' });
    t.cases.documents.set(CASE, t.complete.filter((d) => d.type !== 'clearance'));
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r).toEqual({ status: 'waiting', cutoff: '2026-12-01', pendingTypes: ['clearance'] });
    expect(t.sender.sent).toHaveLength(0);
  });

  it('scenario 2: at cutoff with a missing clearance sends the rest with a pending list and alerts', async () => {
    const t = setup({ today: '2026-12-01' });
    t.cases.documents.set(CASE, t.complete.filter((d) => d.type !== 'clearance'));
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r.status).toBe('sent');
    expect(r.status === 'sent' && r.alerted).toBe(true);
    expect(t.sender.sent[0]!.documentIds).toEqual(['d-hp', 'd-labs', 'd-consent']);
    expect(t.sender.sent[0]!.coverSheet).toContain('Pending');
    expect(t.sender.sent[0]!.coverSheet).toContain('- clearance');
    expect(t.alerts.alerts).toEqual([
      { practiceId: PRACTICE, caseId: CASE, reason: 'pat_cutoff_missing_items', pendingTypes: ['clearance'] },
    ]);
  });

  it('a holiday moves the cutoff earlier', async () => {
    const t = setup({
      today: '2026-11-24',
      holidays: ['2026-11-26'],
      info: { surgeryDate: '2026-12-01' },
    });
    t.cases.documents.set(CASE, t.complete.filter((d) => d.type !== 'labs'));
    expect((await t.service.runPacketStep(PRACTICE, CASE)).status).toBe('sent');
  });

  it('late item goes as an addendum referencing the original; no second alert', async () => {
    const t = setup({ today: '2026-12-01' });
    const partial = t.complete.filter((d) => d.type !== 'clearance');
    t.cases.documents.set(CASE, partial);
    await t.service.runPacketStep(PRACTICE, CASE);
    t.clock.date = '2026-12-03';
    t.cases.documents.set(CASE, [...partial, doc('d-clear', 'clearance')]);
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r.status).toBe('sent');
    expect(t.sender.sent).toHaveLength(2);
    const addendum = t.sender.sent[1]!;
    expect(addendum.kind).toBe('addendum');
    expect(addendum.documentIds).toEqual(['d-clear']);
    expect(addendum.referencesPacketId).toBe(`${CASE}:original`);
    expect(addendum.coverSheet).toContain(`refers to packet ${CASE}:original`);
    expect(t.alerts.alerts).toHaveLength(1);
    // nothing further to send
    expect((await t.service.runPacketStep(PRACTICE, CASE)).status).toBe('nothing_new');
  });

  it('second addendum is numbered after the first', async () => {
    const t = setup({ today: '2026-12-01' });
    t.cases.documents.set(CASE, [doc('d-hp', 'h_and_p')]);
    await t.service.runPacketStep(PRACTICE, CASE);
    t.cases.documents.set(CASE, [doc('d-hp', 'h_and_p'), doc('d-clear', 'clearance')]);
    await t.service.runPacketStep(PRACTICE, CASE);
    t.cases.documents.set(CASE, [doc('d-hp', 'h_and_p'), doc('d-clear', 'clearance'), doc('d-labs', 'labs')]);
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r.status === 'sent' && r.packet.packetId).toBe(`${CASE}:addendum:2`);
  });

  it('includes only required types, never restricted, unready, or other-case documents', async () => {
    const t = setup({ today: '2026-11-30' });
    t.cases.documents.set(CASE, [
      ...t.complete,
      doc('x-ins', 'insurance_card'),
      doc('x-photo', 'clinical_photo'),
      doc('x-psych', 'consent', { id: 'x-restricted', restricted: true, receivedAt: '2026-11-25T10:00:00Z' }),
      doc('x-other', 'labs', { id: 'x-other-case', caseId: 'case-other', receivedAt: '2026-11-26T10:00:00Z' }),
      doc('x-draft', 'labs', { id: 'x-unready', ready: false, receivedAt: '2026-11-27T10:00:00Z' }),
      doc('x-old', 'h_and_p', { id: 'd-hp-old', receivedAt: '2026-11-01T10:00:00Z' }),
    ]);
    await t.service.runPacketStep(PRACTICE, CASE);
    expect(t.sender.sent[0]!.documentIds).toEqual(['d-hp', 'd-clear', 'd-labs', 'd-consent']);
  });

  it('a restricted-only required document counts as pending', async () => {
    const t = setup({ today: '2026-12-01' });
    t.cases.documents.set(CASE, [
      ...t.complete.filter((d) => d.type !== 'consent'),
      doc('x-r', 'consent', { restricted: true }),
    ]);
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r.status === 'sent' && r.packet.pendingTypes).toEqual(['consent']);
  });

  it('office procedure room under local anesthesia has no packet at all', async () => {
    const t = setup({ info: { siteOfService: 'office_procedure_room', anesthesia: 'local' } });
    t.cases.documents.set(CASE, t.complete);
    expect(await t.service.runPacketStep(PRACTICE, CASE)).toEqual({
      status: 'not_applicable',
      reason: 'office_procedure_room_local_anesthesia',
    });
    expect(t.sender.sent).toHaveLength(0);
    expect(t.alerts.alerts).toHaveLength(0);
  });

  it('office procedure room with sedation still gets a packet', async () => {
    const t = setup({ info: { siteOfService: 'office_procedure_room', anesthesia: 'mac' } });
    t.cases.documents.set(CASE, t.complete);
    expect((await t.service.runPacketStep(PRACTICE, CASE)).status).toBe('sent');
  });

  it('is idempotent: re-running does not resend', async () => {
    const t = setup({ today: '2026-11-30' });
    t.cases.documents.set(CASE, t.complete);
    await t.service.runPacketStep(PRACTICE, CASE);
    const again = await t.service.runPacketStep(PRACTICE, CASE);
    expect(again.status).toBe('nothing_new');
    expect(t.sender.sent).toHaveLength(1);
  });

  it('is idempotent when the store write was lost: same key returns the prior record', async () => {
    const t = setup({ today: '2026-11-30' });
    t.cases.documents.set(CASE, t.complete);
    await t.service.runPacketStep(PRACTICE, CASE);
    // Simulate a store that knows the key but not the case listing.
    const record = t.store.records[0]!;
    t.store.listForCase = async () => [];
    const again = await t.service.runPacketStep(PRACTICE, CASE);
    expect(again).toEqual({ status: 'already_sent', packet: record });
    expect(t.sender.sent).toHaveLength(1);
  });

  it('approve-first policy requests approval and sends nothing', async () => {
    const t = setup({ today: '2026-11-30' });
    t.policy.mode = 'approve_first';
    t.cases.documents.set(CASE, t.complete);
    const r = await t.service.runPacketStep(PRACTICE, CASE);
    expect(r.status).toBe('awaiting_approval');
    expect(t.sender.sent).toHaveLength(0);
    expect(t.policy.approvals).toHaveLength(1);
  });

  it('facility request for more becomes an open item, flagged when off the required list', async () => {
    const t = setup();
    const a = await t.service.handleFacilityRequest(PRACTICE, CASE, {
      sourceRequestId: 'req-1',
      documentType: 'labs',
      note: 'Please send repeat CBC',
    });
    await t.service.handleFacilityRequest(PRACTICE, CASE, {
      sourceRequestId: 'req-2',
      documentType: 'echo_report',
      note: 'Echo requested',
    });
    expect(a?.itemId).toBe('item-req-1');
    expect(t.openItems.items.get('req-1')?.outsideRequiredList).toBe(false);
    expect(t.openItems.items.get('req-2')?.outsideRequiredList).toBe(true);
    // An off-list document is never packeted even once it exists.
    t.clock.date = '2026-12-01';
    t.cases.documents.set(CASE, [...t.complete, doc('d-echo', 'echo_report')]);
    await t.service.runPacketStep(PRACTICE, CASE);
    expect(t.sender.sent[0]!.documentIds).not.toContain('d-echo');
  });

  it('handles unknown case, unknown rules, and missing case on facility request', async () => {
    const t = setup();
    expect(await t.service.runPacketStep(PRACTICE, 'nope')).toEqual({
      status: 'not_applicable',
      reason: 'case_not_found',
    });
    expect(await t.service.handleFacilityRequest(PRACTICE, 'nope', {
      sourceRequestId: 'r',
      documentType: 'labs',
      note: '',
    })).toBeUndefined();
    t.rules.rules.clear();
    expect(await t.service.runPacketStep(PRACTICE, CASE)).toEqual({
      status: 'not_applicable',
      reason: 'no_pat_rules',
    });
    await t.service.handleFacilityRequest(PRACTICE, CASE, { sourceRequestId: 'r2', documentType: 'labs', note: '' });
    expect(t.openItems.items.get('r2')?.outsideRequiredList).toBe(true);
  });

  it('nothing ready at cutoff sends nothing', async () => {
    const t = setup({ today: '2026-12-02' });
    t.cases.documents.set(CASE, []);
    expect((await t.service.runPacketStep(PRACTICE, CASE)).status).toBe('nothing_new');
  });

  it('honors a facility-specific cutoff', async () => {
    const t = setup({ today: '2026-12-03' });
    t.rules.rules.get(FACILITY)!.cutoffBusinessDays = 2; // Dec 4
    t.cases.documents.set(CASE, [doc('d-hp', 'h_and_p')]);
    expect((await t.service.runPacketStep(PRACTICE, CASE)).status).toBe('waiting');
  });

  it('is disabled unless the feature flag is on', async () => {
    const t = setup();
    const svc = createPatPacketService({
      cases: t.cases,
      rules: t.rules,
      clock: t.clock,
      holidays: new FakeHolidays(),
      sender: t.sender,
      alerts: t.alerts,
      openItems: t.openItems,
      policy: t.policy,
      store: t.store,
    });
    expect(await svc.runPacketStep(PRACTICE, CASE)).toEqual({ status: 'disabled' });
  });
});
