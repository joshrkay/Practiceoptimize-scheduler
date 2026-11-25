import { describe, expect, it } from 'vitest';
import {
  FakeDirectory,
  FakeEhr,
  FakeFacilityRules,
  FakePracticeRules,
  FakeReadiness,
  FakeRequestStore,
  FakeSend,
  FixedClock,
  applyMatchedDocument,
  chaseResults,
  checkRanges,
  confirmByHuman,
  requestClearance,
  requestTest,
  revalidateForSurgeryDate,
  routeSignedOrder,
  type Deps,
  type MatchedDocument,
} from './index.js';
import { addDays, daysBetween } from './dates.js';
import { bunionectomyCase as ctx, directoryEntries, items, ranges } from './fixtures.js';

function setup(opts: { days?: Record<string, number>; routing?: boolean; now?: string; dir?: boolean } = {}) {
  const readiness = new FakeReadiness(Object.values(items));
  const send = new FakeSend();
  const requests = new FakeRequestStore();
  const clock = new FixedClock(new Date(`${opts.now ?? '2026-11-25'}T09:00:00Z`));
  const deps: Deps = {
    readiness,
    send,
    requests,
    clock,
    directory: new FakeDirectory(opts.dir === false ? {} : directoryEntries),
    practiceRules: new FakePracticeRules(ranges, opts.routing ?? false),
    facilityRules: new FakeFacilityRules(opts.days),
  };
  return { deps, readiness, send, requests, clock };
}
const surgery = { facilityId: ctx.facilityId, surgeryDate: ctx.surgeryDate };
const letter: MatchedDocument = {
  documentId: 'doc-1',
  practiceId: ctx.practiceId,
  caseId: ctx.caseId,
  itemId: items.cardiology.id,
  kind: 'clearance_letter',
  receivedAt: '2026-12-03',
  decisionText: 'Patient is at acceptable risk for the planned procedure, per my evaluation.',
};
const lab = (value: number, over: Partial<MatchedDocument> = {}): MatchedDocument => ({
  documentId: 'doc-lab',
  practiceId: ctx.practiceId,
  caseId: ctx.caseId,
  itemId: items.a1c.id,
  kind: 'test_result',
  receivedAt: '2026-12-02',
  decisionText: 'A1c result',
  values: [{ code: 'a1c', value, unit: '%' }],
  ...over,
});

describe('requests', () => {
  it('sends minimum-necessary clearance request, autonomously, once', async () => {
    const s = setup();
    expect(await requestClearance(s.deps, ctx, items.cardiology)).toEqual({ status: 'sent', requestId: 'req-1' });
    expect(s.send.sent[0]).toEqual({
      practiceId: ctx.practiceId,
      caseId: ctx.caseId,
      itemId: 'item-cardiology',
      patientId: ctx.patientId,
      recipientId: 'dir-cardiology',
      purpose: 'clearance_request',
      autonomy: 'autonomous',
      surgeryDate: '2026-12-15',
      procedure: ctx.procedure,
      surgeonName: ctx.surgeonName,
      neededBy: '2026-12-08',
      requested: 'cardiology',
    });
    expect(await requestClearance(s.deps, ctx, items.cardiology)).toEqual({
      status: 'skipped',
      reason: 'already_requested',
    });
  });
  it('skips satisfied, reports missing recipient, rejects wrong kind', async () => {
    const s = setup({ dir: false });
    expect(await requestClearance(s.deps, ctx, items.cardiology)).toEqual({ status: 'no_recipient' });
    const done = { ...items.cardiology, status: 'satisfied' as const };
    expect(await requestClearance(s.deps, ctx, done)).toEqual({ status: 'skipped', reason: 'already_satisfied' });
    const doneTest = { ...items.a1c, status: 'satisfied' as const };
    expect(await requestTest(s.deps, ctx, doneTest, 'lab')).toEqual({ status: 'skipped', reason: 'already_satisfied' });
    await expect(requestClearance(s.deps, ctx, items.a1c)).rejects.toThrow();
    await expect(requestTest(s.deps, ctx, items.cardiology, 'lab')).rejects.toThrow();
  });
  it('sends test requests to lab and imaging with the test date', async () => {
    const s = setup();
    await requestTest(s.deps, ctx, items.a1c, 'lab');
    await requestTest(s.deps, ctx, items.vascular, 'imaging');
    expect(s.send.sent.map((r) => [r.recipientId, r.purpose, r.testDate])).toEqual([
      ['dir-lab', 'test_request', '2026-12-01'],
      ['dir-vascular', 'test_request', '2026-12-02'],
    ]);
    expect(await requestTest(s.deps, ctx, items.a1c, 'lab')).toEqual({ status: 'skipped', reason: 'already_requested' });
  });
});

describe('chasing results', () => {
  const siteFor = (i: { subtype: string }) => (i.subtype === 'a1c' ? 'lab' : 'imaging') as 'lab' | 'imaging';
  const ctxs = new Map([[ctx.caseId, ctx]]);
  it('does not chase before the test date', async () => {
    const s = setup({ now: '2026-12-01' });
    expect((await chaseResults(s.deps, ctxs, siteFor, ctx.practiceId)).chased).toEqual([]);
  });
  it('chases after the test date, respects interval and cap, then exhausts', async () => {
    const s = setup({ now: '2026-12-03' });
    expect((await chaseResults(s.deps, ctxs, siteFor, ctx.practiceId)).chased.sort()).toEqual([
      'item-a1c',
      'item-vascular',
    ]);
    expect((await chaseResults(s.deps, ctxs, siteFor, ctx.practiceId)).chased).toEqual([]);
    for (const d of ['2026-12-05', '2026-12-07']) {
      s.clock.current = new Date(`${d}T09:00:00Z`);
      expect((await chaseResults(s.deps, ctxs, siteFor, ctx.practiceId)).chased).toHaveLength(2);
    }
    s.clock.current = new Date('2026-12-09T09:00:00Z');
    const r = await chaseResults(s.deps, ctxs, siteFor, ctx.practiceId);
    expect(r.exhausted.sort()).toEqual(['item-a1c', 'item-vascular']);
    expect(r.chased).toEqual([]);
  });
  it('skips items under review, clearances, and unknown cases', async () => {
    const s = setup({ now: '2026-12-03' });
    await applyMatchedDocument(s.deps, lab(9.4), surgery);
    expect((await chaseResults(s.deps, ctxs, siteFor, ctx.practiceId)).chased).toEqual(['item-vascular']);
    expect((await chaseResults(s.deps, new Map(), siteFor, ctx.practiceId)).chased).toEqual([]);
  });
});

describe('Scenario 1: clearance obtained', () => {
  it('attaches the letter and closes the item recording the decision verbatim', async () => {
    const s = setup();
    await requestClearance(s.deps, ctx, items.cardiology);
    const out = await applyMatchedDocument(s.deps, letter, surgery);
    expect(out.status).toBe('satisfied');
    const stored = await s.readiness.getItem(ctx.practiceId, 'item-cardiology');
    expect(stored?.status).toBe('satisfied');
    expect(stored?.satisfiedBy).toEqual({
      source: 'document',
      documentId: 'doc-1',
      decisionText: letter.decisionText,
      issuedAt: '2026-12-03',
      validUntil: '2027-01-02',
    });
  });
  it('records a conditional/negative letter as written without interpreting it', async () => {
    const s = setup();
    const text = 'NOT cleared until echocardiogram is repeated.';
    const out = await applyMatchedDocument(s.deps, { ...letter, decisionText: text }, surgery);
    expect(out.status === 'satisfied' && out.item.satisfiedBy).toMatchObject({ decisionText: text });
  });
});

describe('Scenario 2: result needs review', () => {
  it('flags out-of-range result and leaves the item open', async () => {
    const s = setup();
    const out = await applyMatchedDocument(s.deps, lab(9.4), surgery);
    expect(out).toMatchObject({
      status: 'needs_review',
      flag: { reason: 'out_of_range', details: ['out_of_range:a1c'] },
    });
    const stored = await s.readiness.getItem(ctx.practiceId, 'item-a1c');
    expect(stored?.status).toBe('open');
    expect(stored?.reviewFlag).toBeDefined();
  });
  it('closes in-range results', async () => {
    const s = setup();
    expect((await applyMatchedDocument(s.deps, lab(6.8), surgery)).status).toBe('satisfied');
  });
  it('flags unconfigured codes, unit mismatches and empty results rather than interpreting', async () => {
    const s = setup();
    const a = await applyMatchedDocument(s.deps, lab(6, { values: [{ code: 'abi', value: 1, unit: 'ratio' }] }), surgery);
    expect(a).toMatchObject({ status: 'needs_review', flag: { reason: 'no_configured_range' } });
    const b = await applyMatchedDocument(s.deps, lab(6, { values: [{ code: 'a1c', value: 6, unit: 'mmol/mol' }] }), surgery);
    expect(b).toMatchObject({ status: 'needs_review', flag: { reason: 'unit_mismatch' } });
    const c = await applyMatchedDocument(s.deps, lab(6, { values: [] }), surgery);
    expect(c).toMatchObject({ status: 'needs_review', flag: { details: ['no_values_extracted'] } });
    const { values: _omit, ...noValues } = lab(6);
    const d = await applyMatchedDocument(s.deps, noValues, surgery);
    expect(d.status).toBe('needs_review');
  });
  it('surgeon confirmation closes a flagged item and clears the flag', async () => {
    const s = setup();
    await applyMatchedDocument(s.deps, lab(9.4), surgery);
    const out = await confirmByHuman(s.deps, {
      practiceId: ctx.practiceId,
      itemId: 'item-a1c',
      userId: 'surgeon-1',
      note: 'reviewed',
      facilityId: ctx.facilityId,
    });
    expect(out.status).toBe('satisfied');
    const stored = await s.readiness.getItem(ctx.practiceId, 'item-a1c');
    expect(stored?.reviewFlag).toBeUndefined();
    expect(stored?.satisfiedBy).toMatchObject({ source: 'human', userId: 'surgeon-1' });
  });
  it('checkRanges handles min-only and max-only rules', () => {
    expect(checkRanges([{ code: 'x', value: 1, unit: 'u' }], { x: { min: 2, unit: 'u' } })).toEqual(['out_of_range:x']);
    expect(checkRanges([{ code: 'x', value: 3, unit: 'u' }], { x: { min: 2, unit: 'u' } })).toEqual([]);
    expect(checkRanges([{ code: 'x', value: 3, unit: 'u' }], { x: { max: 2, unit: 'u' } })).toEqual(['out_of_range:x']);
  });
});

describe('guards', () => {
  it('rejects documents for other practices, cases, kinds, or missing items', async () => {
    const s = setup();
    expect(await applyMatchedDocument(s.deps, { ...letter, practiceId: 'other' }, surgery)).toEqual({
      status: 'rejected',
      reason: 'item_not_found',
    });
    expect(await applyMatchedDocument(s.deps, { ...letter, itemId: 'nope' }, surgery)).toEqual({
      status: 'rejected',
      reason: 'item_not_found',
    });
    expect(await applyMatchedDocument(s.deps, { ...letter, caseId: 'other' }, surgery)).toEqual({
      status: 'rejected',
      reason: 'item_mismatch',
    });
    expect(await applyMatchedDocument(s.deps, { ...letter, kind: 'test_result' }, surgery)).toEqual({
      status: 'rejected',
      reason: 'kind_mismatch',
    });
    expect((await s.readiness.getItem(ctx.practiceId, 'item-cardiology'))?.status).toBe('open');
  });
  it('human confirmation needs a user id and an existing item', async () => {
    const s = setup();
    const base = { practiceId: ctx.practiceId, note: '', facilityId: ctx.facilityId };
    await expect(confirmByHuman(s.deps, { ...base, itemId: 'item-a1c', userId: '' })).rejects.toThrow();
    expect(await confirmByHuman(s.deps, { ...base, itemId: 'nope', userId: 'u' })).toEqual({
      status: 'rejected',
      reason: 'item_not_found',
    });
  });
  it('request, chase and expiry paths never satisfy an item', async () => {
    const s = setup({ now: '2026-12-03' });
    await requestClearance(s.deps, ctx, items.cardiology);
    await requestTest(s.deps, ctx, items.a1c, 'lab');
    await chaseResults(s.deps, new Map([[ctx.caseId, ctx]]), () => 'lab', ctx.practiceId);
    await revalidateForSurgeryDate(s.deps, ctx.practiceId, ctx.caseId, '2027-03-01');
    for (const i of s.readiness.items.values()) expect(i.status).toBe('open');
  });
});

describe('validity and expiry', () => {
  it('defaults to 30 days and honors facility rules', async () => {
    const s = setup({ days: { 'asc-lakeside:cardiology': 90 } });
    const out = await applyMatchedDocument(s.deps, letter, surgery);
    expect(out.status === 'satisfied' && out.item.satisfiedBy?.validUntil).toBe(addDays('2026-12-03', 90));
    expect(daysBetween('2026-12-03', '2027-01-02')).toBe(30);
  });
  it('does not close a document already stale for the surgery date', async () => {
    const s = setup();
    const out = await applyMatchedDocument(s.deps, { ...letter, issuedAt: '2026-10-01' }, surgery);
    expect(out).toMatchObject({ status: 'needs_review', flag: { reason: 'expired_before_surgery' } });
    expect((await s.readiness.getItem(ctx.practiceId, 'item-cardiology'))?.status).toBe('open');
  });
  it('reopens only items whose validity ends before the moved surgery date', async () => {
    const s = setup();
    await applyMatchedDocument(s.deps, letter, surgery); // valid until 2027-01-02
    await applyMatchedDocument(s.deps, lab(6.5), surgery); // valid until 2027-01-01
    expect(await revalidateForSurgeryDate(s.deps, ctx.practiceId, ctx.caseId, '2027-01-01')).toEqual([]);
    expect(await revalidateForSurgeryDate(s.deps, ctx.practiceId, ctx.caseId, '2027-01-02')).toEqual(['item-a1c']);
    const a1c = await s.readiness.getItem(ctx.practiceId, 'item-a1c');
    expect(a1c).toMatchObject({ status: 'open' });
    expect(a1c?.satisfiedBy).toBeUndefined();
    expect(a1c?.reopenedReason).toContain('2027-01-02');
    expect((await s.readiness.getItem(ctx.practiceId, 'item-cardiology'))?.status).toBe('satisfied');
    expect(await revalidateForSurgeryDate(s.deps, ctx.practiceId, ctx.caseId, '2027-02-01')).toEqual([
      'item-cardiology',
    ]);
  });
});

describe('signed order routing', () => {
  const order = { orderId: 'o1', signedBy: 'surgeon-1', signedAt: '2026-11-20T10:00:00Z' };
  it('routes only signed orders and only when allowed', async () => {
    const ehr = new FakeEhr();
    expect(await routeSignedOrder(setup().deps, ehr, ctx.practiceId, order)).toEqual({ routed: false });
    expect(await routeSignedOrder(setup({ routing: true }).deps, ehr, ctx.practiceId, { ...order, signedBy: '' })).toEqual({
      routed: false,
    });
    expect(ehr.routed).toEqual([]);
    expect(await routeSignedOrder(setup({ routing: true }).deps, ehr, ctx.practiceId, order)).toEqual({ routed: true });
    expect(ehr.routed).toEqual([order]);
  });
});

describe('fakes', () => {
  it('isolate practices', async () => {
    const r = new FakeReadiness([items.a1c]);
    expect(await r.getItem('other', 'item-a1c')).toBeUndefined();
    expect(await r.listOpenItems('other')).toEqual([]);
    expect(await r.listItemsForCase('other', ctx.caseId)).toEqual([]);
  });
});
