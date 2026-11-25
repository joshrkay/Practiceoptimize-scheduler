import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { crossCheck } from './crosscheck.js';
import {
  FakeClock,
  FakeDirectRoute,
  FakeDirectory,
  FakePolicy,
  FakeReviewQueue,
  FakeSendTool,
  InMemorySubmissionStore,
} from './fakes.js';
import { renderCancellation, renderPosting, renderReconfirmation } from './format.js';
import { PostingError, PostingService, isFacilityPostingEnabled } from './service.js';
import type { FacilityDirectoryEntry, PostingCase, SignedOrder } from './types.js';

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../../../../tests/fixtures/coordination/${name}`, import.meta.url), 'utf8')) as T;

const fixture = load<{
  practiceId: string;
  facility: FacilityDirectoryEntry;
  case: PostingCase;
  order: SignedOrder;
}>('posting-asc-a.json');
const confirmationFax = load<{ practiceId: string; caseId: string; confirmationNumber: string }>(
  'posting-confirmation-fax.json',
);

const P = fixture.practiceId;

function setup(facility: FacilityDirectoryEntry = fixture.facility, enabled = true) {
  const directory = new FakeDirectory();
  directory.add(P, facility);
  const sendTool = new FakeSendTool();
  const directRoute = new FakeDirectRoute();
  const policy = new FakePolicy();
  const reviewQueue = new FakeReviewQueue();
  const clock = new FakeClock(new Date('2026-12-01T12:00:00Z'));
  const store = new InMemorySubmissionStore();
  let n = 0;
  const service = new PostingService({
    directory,
    sendTool,
    directRoute,
    policy,
    reviewQueue,
    clock,
    store,
    enabled,
    newId: () => `sub-${++n}`,
  });
  return { service, directory, sendTool, directRoute, policy, reviewQueue, clock, store };
}

const input = () => ({ case: { ...fixture.case }, order: { ...fixture.order } });

describe('scenario: posting confirmed (ASC taking faxes)', () => {
  it('queues for approval, faxes the sheet after approval, records the confirmation number', async () => {
    const { service, sendTool, reviewQueue } = setup();
    const res = await service.prepare(input());
    expect(res.status).toBe('pending_approval');
    expect(sendTool.sent).toHaveLength(0);
    expect(reviewQueue.approvals).toHaveLength(1);

    if (res.status !== 'pending_approval') throw new Error('unreachable');
    const sent = await service.approve(P, res.submission.id, 'scheduler-1');
    expect(sent.status).toBe('sent');
    expect(sent.approvalBasis).toBe('scheduler');
    expect(sendTool.sent).toHaveLength(1);
    const req = sendTool.sent[0]!;
    expect(req.channel).toEqual({ kind: 'fax', number: '+15555550142' });
    expect(req.document.format).toBe('sheet');
    for (const text of [
      'Date: 2026-12-15',
      'Start time: 08:30',
      'CPT: 28297',
      'Laterality: left',
      'Estimated duration (min): 90',
      'Surgeon: Dr. Test Surgeon',
      'Assistant: Test Assistant PA',
      'Anesthesia: MAC with popliteal block',
      'Positioning: Supine, thigh tourniquet',
      'Equipment: Mini C-arm, Pneumatic tourniquet',
      'Implants: Lapidus plate system',
      'Rep: Synthetic Implant Co rep',
    ]) {
      expect(req.document.body).toContain(text);
    }

    const confirmed = await service.recordConfirmation(confirmationFax);
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.confirmationNumber).toBe('ASC-884213');
    expect(confirmed?.confirmedAt).toBe('2026-12-01T12:00:00.000Z');
  });

  it('returns undefined when no sent posting awaits a confirmation', async () => {
    const { service } = setup();
    expect(await service.recordConfirmation(confirmationFax)).toBeUndefined();
  });
});

describe('cross-check blocks and escalates', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  async function expectBlocked(field: 'date' | 'side' | 'procedure', c: PostingCase, o: SignedOrder) {
    const res = await ctx.service.prepare({ case: c, order: o });
    expect(res.status).toBe('blocked');
    if (res.status !== 'blocked') throw new Error('unreachable');
    expect(res.reason).toBe('mismatch');
    expect(res.mismatches.map((m) => m.field)).toEqual([field]);
    expect(ctx.sendTool.sent).toHaveLength(0);
    expect(ctx.reviewQueue.approvals).toHaveLength(0);
    expect(ctx.reviewQueue.escalations).toHaveLength(1);
    expect(ctx.reviewQueue.escalations[0]!.mismatches).toEqual(res.mismatches);
    expect(ctx.reviewQueue.escalations[0]!.summary).toContain(field);
    expect((await ctx.store.get(P, res.submission.id))?.status).toBe('blocked');
    return res;
  }

  it('side mismatch (scenario 2): shows posting and order values', async () => {
    const res = await expectBlocked('side', { ...fixture.case, laterality: 'right' }, fixture.order);
    expect(res.mismatches[0]).toEqual({ field: 'side', posting: 'right', order: 'left' });
  });

  it('date mismatch', async () => {
    await expectBlocked('date', { ...fixture.case, date: '2026-12-16' }, fixture.order);
  });

  it('procedure mismatch', async () => {
    await expectBlocked('procedure', { ...fixture.case, procedure: 'Right hammertoe correction' }, fixture.order);
  });

  it('a mismatch cannot be bypassed by the urgent add-on exception', async () => {
    const res = await ctx.service.prepare({
      case: { ...fixture.case, urgentAddOn: true, laterality: 'right' },
      order: { ...fixture.order, urgent: true },
    });
    expect(res.status).toBe('blocked');
    expect(ctx.sendTool.sent).toHaveLength(0);
  });

  it('procedure comparison ignores case and spacing only', () => {
    const c = { ...fixture.case, procedure: '  LEFT first  metatarsal bunionectomy (lapidus) ' };
    expect(crossCheck(c, fixture.order)).toEqual([]);
  });

  it('blocks an unsigned order', async () => {
    const res = await ctx.service.prepare({ case: fixture.case, order: { ...fixture.order, signed: false } });
    expect(res.status === 'blocked' && res.reason).toBe('order_not_signed');
    expect(ctx.reviewQueue.escalations).toHaveLength(1);
  });

  it('blocks an incomplete posting and names the missing fields', async () => {
    const res = await ctx.service.prepare({ case: { ...fixture.case, cpt: [], surgeon: '' }, order: fixture.order });
    expect(res.status === 'blocked' && res.reason).toBe('incomplete');
    expect(ctx.reviewQueue.escalations[0]!.summary).toContain('cpt, surgeon');
  });
});

describe('urgent add-on exception (ADR-0007)', () => {
  it('sends without a scheduler approval when the signed urgent order is the approval', async () => {
    const { service, sendTool, reviewQueue } = setup();
    const res = await service.prepare({
      case: { ...fixture.case, urgentAddOn: true },
      order: { ...fixture.order, urgent: true },
    });
    expect(res.status).toBe('sent');
    if (res.status !== 'sent') throw new Error('unreachable');
    expect(res.submission.approvalBasis).toBe('urgent_signed_order');
    expect(sendTool.sent).toHaveLength(1);
    expect(reviewQueue.approvals).toHaveLength(0);
  });

  it('an unsigned urgent order is not an approval', async () => {
    const { service, sendTool } = setup();
    const res = await service.prepare({
      case: { ...fixture.case, urgentAddOn: true },
      order: { ...fixture.order, urgent: true, signed: false },
    });
    expect(res.status).toBe('blocked');
    expect(sendTool.sent).toHaveLength(0);
  });

  it('a non-urgent order on an urgent add-on still needs approval', async () => {
    const { service, sendTool } = setup();
    const res = await service.prepare({ case: { ...fixture.case, urgentAddOn: true }, order: fixture.order });
    expect(res.status).toBe('pending_approval');
    expect(sendTool.sent).toHaveLength(0);
  });
});

describe('channels and formats', () => {
  it.each([
    [{ kind: 'email', address: 'or-desk@example.test' } as const, 'compact' as const, ' | '],
    [{ kind: 'portal_task', portalName: 'Synthetic Portal', assigneeRole: 'scheduler' } as const, 'portal_form' as const, '[Date] 2026-12-15'],
  ])('sends by %j in the %s format', async (channel, postingFormat, marker) => {
    const { service, sendTool } = setup({ ...fixture.facility, channel, postingFormat });
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    await service.approve(P, res.submission.id, 'sched');
    expect(sendTool.sent[0]!.channel).toEqual(channel);
    expect(sendTool.sent[0]!.document.format).toBe(postingFormat);
    expect(sendTool.sent[0]!.document.body).toContain(marker);
  });

  it('renders None for optional fields', () => {
    const { assistant: _a, rep: _r, ...rest } = fixture.case;
    const c: PostingCase = { ...rest, equipment: [], implants: [], positioning: '' };
    const doc = renderPosting('sheet', 'initial', c, 1);
    expect(doc.body).toContain('Assistant: None');
    expect(doc.body).toContain('Rep: None');
    expect(doc.body).toContain('Implants: None');
    expect(doc.body).toContain('Positioning: None');
  });

  it('renders cancellation and reconfirmation in compact and sheet formats', () => {
    expect(renderCancellation('compact', fixture.case, 'patient request').body).toContain('Reason: patient request');
    expect(renderCancellation('sheet', fixture.case, 'x', 'N-1').body).toContain('Confirmation number: N-1');
    expect(renderReconfirmation('compact', fixture.case, undefined).body).toContain('not yet received');
  });
});

describe('office procedure room', () => {
  it('needs no external posting', async () => {
    const { service, sendTool, store, reviewQueue } = setup({ ...fixture.facility, siteType: 'office_procedure_room' });
    expect(await service.prepare(input())).toEqual({ status: 'not_required', reason: 'office_procedure_room' });
    expect(await service.cancel({ practiceId: P, caseId: fixture.case.caseId, reason: 'x' })).toEqual({
      status: 'nothing_to_cancel',
    });
    expect(sendTool.sent).toHaveLength(0);
    expect(reviewQueue.approvals).toHaveLength(0);
    expect(await store.listByPractice(P)).toHaveLength(0);
  });
});

describe('direct scheduling route hook (RAH-77)', () => {
  const direct = { ...fixture.facility, directScheduling: { available: true, systemId: 'asc-sched-1' } };

  it('uses the direct route when the directory says it is available', async () => {
    const { service, sendTool, directRoute } = setup(direct);
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    const sent = await service.approve(P, res.submission.id, 'sched');
    expect(sent.route).toBe('direct_scheduling');
    expect(directRoute.submitted[0]!.systemId).toBe('asc-sched-1');
    expect(sendTool.sent).toHaveLength(0);
  });

  it('falls back to the directory channel when the direct route does not accept', async () => {
    const { service, sendTool, directRoute } = setup(direct);
    directRoute.accept = false;
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    const sent = await service.approve(P, res.submission.id, 'sched');
    expect(sent.route).toBe('directory_channel');
    expect(sendTool.sent).toHaveLength(1);
  });

  it('ignores the direct route when the entry marks it unavailable', async () => {
    const { service, directRoute } = setup({ ...direct, directScheduling: { available: false, systemId: 's' } });
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    await service.approve(P, res.submission.id, 'sched');
    expect(directRoute.submitted).toHaveLength(0);
  });
});

describe('72-hour reconfirmation', () => {
  async function posted() {
    const ctx = setup();
    const res = await ctx.service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    await ctx.service.approve(P, res.submission.id, 'sched');
    await ctx.service.recordConfirmation(confirmationFax);
    return ctx;
  }

  it('does nothing earlier than 72 hours before surgery', async () => {
    const { service } = await posted();
    expect(await service.runReconfirmations(P)).toEqual([]);
  });

  it('queues one reconfirmation inside the window, sends after approval, records the answer', async () => {
    const { service, clock, sendTool, reviewQueue, store } = await posted();
    clock.set(new Date('2026-12-12T14:00:00Z')); // 71.5h before 08:30 -05:00 on the 15th
    const created = await service.runReconfirmations(P);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('reconfirmation');
    expect(created[0]!.document.body).toContain('ASC-884213');
    expect(reviewQueue.approvals).toHaveLength(2);
    expect(sendTool.sent).toHaveLength(1); // approve-first: nothing sent yet
    expect(await service.runReconfirmations(P)).toEqual([]); // not asked twice

    await service.approve(P, created[0]!.id, 'sched');
    expect(sendTool.sent).toHaveLength(2);
    const answered = await service.recordConfirmation({ ...confirmationFax, confirmationNumber: 'ASC-RECONF-1' });
    expect(answered?.kind).toBe('reconfirmation');
    const parent = (await store.listByCase(P, fixture.case.caseId)).find((s) => s.kind === 'initial');
    expect(parent?.reconfirmedAt).toBe('2026-12-12T14:00:00.000Z');
    expect(parent?.reconfirmationNumber).toBe('ASC-RECONF-1');
    expect(parent?.confirmationNumber).toBe('ASC-884213');
  });

  it('skips surgeries already started or cancelled, and does nothing when disabled', async () => {
    const { service, clock } = await posted();
    clock.set(new Date('2026-12-16T00:00:00Z'));
    expect(await service.runReconfirmations(P)).toEqual([]);
    clock.set(new Date('2026-12-12T14:00:00Z'));
    await service.cancel({ practiceId: P, caseId: fixture.case.caseId, reason: 'patient request' });
    expect(await service.runReconfirmations(P)).toEqual([]);
    expect(await setup(fixture.facility, false).service.runReconfirmations(P)).toEqual([]);
  });
});

describe('changes and cancellation', () => {
  async function posted() {
    const ctx = setup();
    const res = await ctx.service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    await ctx.service.approve(P, res.submission.id, 'sched');
    return ctx;
  }

  it('a change sends an updated posting (after approval) that re-passes the cross-check', async () => {
    const { service, sendTool } = await posted();
    const newCase = { ...fixture.case, startTime: '10:00' };
    const res = await service.change({ case: newCase, order: fixture.order });
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    expect(res.submission.kind).toBe('update');
    expect(res.submission.version).toBe(2);
    expect(sendTool.sent).toHaveLength(1);
    await service.approve(P, res.submission.id, 'sched');
    expect(sendTool.sent[1]!.document.subject).toContain('UPDATE (revision 2)');
    expect(sendTool.sent[1]!.document.body).toContain('Start time: 10:00');

    const bad = await service.change({ case: { ...newCase, laterality: 'right' }, order: fixture.order });
    expect(bad.status).toBe('blocked');
  });

  it('a change before anything was sent replaces the pending posting', async () => {
    const { service, store } = setup();
    const first = await service.prepare(input());
    const second = await service.change({ case: { ...fixture.case, startTime: '09:00' }, order: fixture.order });
    if (first.status !== 'pending_approval' || second.status !== 'pending_approval') throw new Error('unreachable');
    expect(second.submission.kind).toBe('initial');
    expect((await store.get(P, first.submission.id))?.status).toBe('superseded');
    await expect(service.approve(P, first.submission.id, 's')).rejects.toThrow(PostingError);
  });

  it('a cancellation sends a notice after approval and carries the confirmation number', async () => {
    const { service, sendTool } = await posted();
    await service.recordConfirmation(confirmationFax);
    const res = await service.cancel({ practiceId: P, caseId: fixture.case.caseId, reason: 'patient request' });
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    expect(res.submission.kind).toBe('cancellation');
    expect(sendTool.sent).toHaveLength(1);
    await service.approve(P, res.submission.id, 'sched');
    expect(sendTool.sent[1]!.document.body).toContain('OR POSTING CANCELLATION');
    expect(sendTool.sent[1]!.document.body).toContain('ASC-884213');
    expect(await service.cancel({ practiceId: P, caseId: fixture.case.caseId, reason: 'again' })).toEqual({
      status: 'nothing_to_cancel',
    });
  });

  it('cancelling a never-sent posting just withdraws it', async () => {
    const { service, sendTool, store } = setup();
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    expect(await service.cancel({ practiceId: P, caseId: fixture.case.caseId, reason: 'x' })).toEqual({
      status: 'nothing_to_cancel',
    });
    expect((await store.get(P, res.submission.id))?.status).toBe('superseded');
    expect(sendTool.sent).toHaveLength(0);
    expect(await service.cancel({ practiceId: P, caseId: 'unknown', reason: 'x' })).toEqual({
      status: 'nothing_to_cancel',
    });
  });
});

describe('guards', () => {
  it('does nothing when the feature flag is off', async () => {
    const { service, store } = setup(fixture.facility, false);
    expect(await service.prepare(input())).toEqual({ status: 'disabled' });
    expect(await service.cancel({ practiceId: P, caseId: 'c', reason: 'r' })).toEqual({ status: 'disabled' });
    expect(await store.listByPractice(P)).toHaveLength(0);
  });

  it('reads the flag from the environment, default false', () => {
    expect(isFacilityPostingEnabled({})).toBe(false);
    expect(isFacilityPostingEnabled({ FEATURE_COORD_FACILITY_POSTING: 'true' })).toBe(true);
  });

  it('respects a policy denial', async () => {
    const { service, policy, sendTool } = setup();
    policy.decision = 'deny';
    expect(await service.prepare(input())).toEqual({ status: 'denied_by_policy' });
    expect(sendTool.sent).toHaveLength(0);
  });

  it('rejects a pending posting and refuses a second approval', async () => {
    const { service } = setup();
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    expect((await service.reject(P, res.submission.id, 'sched')).status).toBe('rejected');
    await expect(service.approve(P, res.submission.id, 'sched')).rejects.toThrow(/not pending approval/);
    await expect(service.approve(P, 'missing', 'sched')).rejects.toThrow(/not found/);
  });

  it('errors on an unknown facility and an invalid time', async () => {
    const { service } = setup();
    await expect(service.prepare({ case: { ...fixture.case, facilityId: 'nope' }, order: fixture.order })).rejects.toThrow(
      /not in the directory/,
    );
    await expect(service.prepare({ case: { ...fixture.case, startTime: 'xx' }, order: fixture.order })).rejects.toThrow(
      /Invalid surgery/,
    );
  });

  it('keeps practices isolated', async () => {
    const { service } = setup();
    const res = await service.prepare(input());
    if (res.status !== 'pending_approval') throw new Error('unreachable');
    await expect(service.approve('other-practice', res.submission.id, 'sched')).rejects.toThrow(/not found/);
    expect(await service.recordConfirmation({ ...confirmationFax, practiceId: 'other-practice' })).toBeUndefined();
  });
});
