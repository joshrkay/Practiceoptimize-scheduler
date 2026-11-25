import { describe, expect, it } from 'vitest';
import fixtures from '../../../../tests/fixtures/review/proposed-actions.json';
import { diffInputs } from './diff';
import {
  FakeAuditSink,
  FakeClock,
  FakeEscalator,
  FakeExecutor,
  type HardRuleCheck,
  type ProposedActionRef,
} from './ports';
import { DEFAULT_EXPIRY_MS, ReviewQueue } from './queue';
import { InMemoryReviewStore } from './store';
import type { NewReviewItem } from './types';

const A = { practiceId: 'practice-a', userId: 'user-1' };
const B = { practiceId: 'practice-b', userId: 'user-2' };
const [authFx, reminderFx, reminder2Fx, changePlanFx] = fixtures as unknown as NewReviewItem[];

// Hard rule used in tests: diagnosis codes must be valid-looking and not the known-wrong one.
const rules: HardRuleCheck = async (a: ProposedActionRef) =>
  a.inputs['diagnosisCode'] === 'WRONG'
    ? { ok: false, reason: 'Diagnosis code does not match the procedure.' }
    : a.inputs['blocked'] === true
      ? { ok: false, reason: 'Blocked by hard rule.' }
      : { ok: true };

function setup(config?: ConstructorParameters<typeof ReviewQueue>[0]['config']) {
  const store = new InMemoryReviewStore();
  const executor = new FakeExecutor();
  const audit = new FakeAuditSink();
  const clock = new FakeClock(new Date('2026-12-01T12:00:00Z'));
  const escalator = new FakeEscalator();
  const hardRuleChecks: ProposedActionRef[] = [];
  const queue = new ReviewQueue({
    store,
    executor,
    audit,
    clock,
    escalator,
    hardRuleCheck: async (a) => {
      hardRuleChecks.push(a);
      return rules(a);
    },
    ...(config ? { config } : {}),
  });
  return { store, executor, audit, clock, escalator, queue, hardRuleChecks };
}

const enqueue = async (q: ReviewQueue, item: NewReviewItem, practiceId = A.practiceId) => {
  const r = await q.enqueue(practiceId, item);
  if (!r.ok) throw new Error('enqueue failed');
  return r.item;
};

describe('enqueue and list', () => {
  it('stores action, inputs, reason, evidence, policy result and the default expiry', async () => {
    const { queue, clock } = setup();
    const item = await enqueue(queue, authFx!);
    expect(item.status).toBe('pending');
    expect(item.reason).toContain('prior authorization');
    expect(item.evidenceLinks).toHaveLength(1);
    expect(item.policyResult.tier).toBe('approval_required');
    expect(item.expiresAt.getTime()).toBe(clock.now().getTime() + DEFAULT_EXPIRY_MS);
  });

  it('honors configured and per-item expiry', async () => {
    const { queue, clock } = setup({ expiryMs: 1000 });
    expect((await enqueue(queue, reminderFx!)).expiresAt.getTime()).toBe(clock.now().getTime() + 1000);
    const custom = new Date('2027-01-01T00:00:00Z');
    expect((await enqueue(queue, { ...reminderFx!, expiresAt: custom })).expiresAt).toEqual(custom);
  });

  it('isolates practices and filters', async () => {
    const { queue } = setup();
    const a = await enqueue(queue, authFx!);
    await enqueue(queue, reminderFx!, B.practiceId);
    expect((await queue.list(A.practiceId)).map((i) => i.id)).toEqual([a.id]);
    expect(await queue.list(A.practiceId, { status: 'rejected' })).toEqual([]);
    expect(await queue.list(A.practiceId, { caseId: authFx!.caseId })).toHaveLength(1);
    expect(await queue.get(B.practiceId, a.id)).toBeUndefined();
    expect(await queue.approve(B, a.id)).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('Scenario 1: edit and approve', () => {
  it('executes the edited inputs, stores the diff and audits it', async () => {
    const { queue, executor, audit, store } = setup();
    const item = await enqueue(queue, { ...authFx!, inputs: { ...authFx!.inputs, diagnosisCode: 'WRONG' } });
    // A plain approve is blocked by the hard rule on the wrong code.
    expect(await queue.approve(A, item.id)).toMatchObject({ ok: false, code: 'hard_rule_failed' });
    expect(executor.executed).toHaveLength(0);

    const r = await queue.editAndApprove(A, item.id, { ...authFx!.inputs, diagnosisCode: 'M20.11' });
    expect(r.ok).toBe(true);
    expect(executor.executed).toHaveLength(1);
    expect(executor.executed[0]!.inputs['diagnosisCode']).toBe('M20.11');
    if (r.ok) {
      expect(r.item.status).toBe('edited_approved');
      expect(r.item.diff).toEqual([{ path: 'diagnosisCode', before: 'WRONG', after: 'M20.11' }]);
    }
    const audited = audit.events.find((e) => e.action === 'review.edited_approved');
    expect(audited?.details?.['diff']).toEqual([{ path: 'diagnosisCode', before: 'WRONG', after: 'M20.11' }]);
    const fb = await store.listFeedback(A.practiceId);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ label: 'edited', actorId: A.userId });
  });

  it('re-runs hard rules on edited inputs and does not execute on failure', async () => {
    const { queue, executor, hardRuleChecks } = setup();
    const item = await enqueue(queue, authFx!);
    const r = await queue.editAndApprove(A, item.id, { ...authFx!.inputs, diagnosisCode: 'WRONG' });
    expect(r).toMatchObject({ ok: false, code: 'hard_rule_failed' });
    expect(hardRuleChecks.at(-1)!.inputs['diagnosisCode']).toBe('WRONG');
    expect(executor.executed).toHaveLength(0);
    expect((await queue.get(A.practiceId, item.id))!.status).toBe('pending');
  });

  it('treats an unchanged edit as a plain approval and rejects non-object edits', async () => {
    const { queue, store } = setup();
    const item = await enqueue(queue, authFx!);
    const r = await queue.editAndApprove(A, item.id, { ...authFx!.inputs });
    expect(r.ok && r.item.status).toBe('approved');
    expect(await store.listFeedback(A.practiceId)).toHaveLength(0);
    expect(await queue.editAndApprove(A, item.id, [] as never)).toMatchObject({ code: 'invalid' });
    expect(await queue.editAndApprove(A, item.id, null as never)).toMatchObject({ code: 'invalid' });
  });
});

describe('approve and reject', () => {
  it('approve executes the original and audits it', async () => {
    const { queue, executor, audit } = setup();
    const item = await enqueue(queue, authFx!);
    const r = await queue.approve(A, item.id);
    expect(r.ok && r.item.status).toBe('approved');
    expect(executor.executed[0]!.inputs).toEqual(authFx!.inputs);
    expect(audit.events.some((e) => e.action === 'review.approved' && e.actorId === A.userId)).toBe(true);
  });

  it('cannot approve twice', async () => {
    const { queue, executor } = setup();
    const item = await enqueue(queue, authFx!);
    await queue.approve(A, item.id);
    expect(await queue.approve(A, item.id)).toMatchObject({ ok: false, code: 'not_pending' });
    expect(executor.executed).toHaveLength(1);
  });

  it('concurrent approvals execute once', async () => {
    const { queue, executor } = setup();
    const item = await enqueue(queue, authFx!);
    const results = await Promise.all([queue.approve(A, item.id), queue.approve(A, item.id)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(executor.executed).toHaveLength(1);
  });

  it('records execution failure', async () => {
    const { queue, executor, audit } = setup();
    executor.failWith = 'portal down';
    const item = await enqueue(queue, authFx!);
    const r = await queue.approve(A, item.id);
    expect(r).toMatchObject({ ok: false, code: 'execution_failed' });
    expect((await queue.get(A.practiceId, item.id))!.status).toBe('failed');
    expect(audit.events.some((e) => e.action === 'review.execution_failed')).toBe(true);
  });

  it('reject needs a reason, records it as feedback and does not execute', async () => {
    const { queue, executor, store } = setup();
    const item = await enqueue(queue, authFx!);
    expect(await queue.reject(A, item.id, '  ')).toMatchObject({ code: 'invalid' });
    const r = await queue.reject(A, item.id, 'Wrong procedure');
    expect(r.ok && r.item.rejectionReason).toBe('Wrong procedure');
    expect(executor.executed).toHaveLength(0);
    expect(await store.listFeedback(A.practiceId)).toMatchObject([{ label: 'rejected', reason: 'Wrong procedure' }]);
    expect(await queue.reject(A, item.id, 'again')).toMatchObject({ code: 'not_pending' });
    expect(await queue.reject(A, 'nope', 'x')).toMatchObject({ code: 'not_found' });
  });

  it('refuses to decide an expired item', async () => {
    const { queue, clock, executor } = setup();
    const item = await enqueue(queue, authFx!);
    clock.advanceMs(DEFAULT_EXPIRY_MS + 1);
    expect(await queue.approve(A, item.id)).toMatchObject({ ok: false, code: 'expired' });
    expect(executor.executed).toHaveLength(0);
  });
});

describe('bulk approve', () => {
  it('approves a group, with failing items dropping out with their reason', async () => {
    const { queue, executor, hardRuleChecks } = setup();
    const ok = await enqueue(queue, reminderFx!);
    const bad = await enqueue(queue, { ...reminder2Fx!, inputs: { ...reminder2Fx!.inputs, blocked: true } });
    const r = await queue.bulkApprove(A, 'reminder', [ok.id, bad.id, ok.id]);
    if (!('approved' in r)) throw new Error('expected bulk result');
    expect(r.approved.map((i) => i.id)).toEqual([ok.id]);
    expect(r.dropped).toEqual([{ itemId: bad.id, code: 'hard_rule_failed', reason: 'Blocked by hard rule.' }]);
    expect(executor.executed).toHaveLength(1);
    expect(hardRuleChecks).toHaveLength(2); // one check per item
  });

  it('drops missing, wrong-type, human-only and other-practice items', async () => {
    const { queue } = setup();
    const rem = await enqueue(queue, reminderFx!);
    const auth = await enqueue(queue, authFx!);
    const humanOnly = await enqueue(queue, { ...reminder2Fx!, policyResult: { ...reminder2Fx!.policyResult, humanOnly: true } });
    const other = await enqueue(queue, reminder2Fx!, B.practiceId);
    const r = await queue.bulkApprove(A, 'reminder', [rem.id, auth.id, humanOnly.id, other.id, 'missing']);
    if (!('approved' in r)) throw new Error('expected bulk result');
    expect(r.approved).toHaveLength(1);
    expect(r.dropped.map((d) => d.code).sort()).toEqual(['human_only', 'not_found', 'not_found', 'wrong_type']);
  });

  it('never bulk approves auth submissions or change plans, even if configured eligible', async () => {
    const { queue, executor } = setup({ bulkEligibleActionTypes: ['auth_submission', 'change_plan', 'reminder'] });
    const auth = await enqueue(queue, authFx!);
    const plan = await enqueue(queue, changePlanFx!);
    expect(await queue.bulkApprove(A, 'auth_submission', [auth.id])).toMatchObject({ ok: false, code: 'invalid' });
    expect(await queue.bulkApprove(A, 'change_plan', [plan.id])).toMatchObject({ ok: false, code: 'invalid' });
    expect(await queue.bulkApprove(A, 'unknown_type', [])).toMatchObject({ ok: false });
    expect(executor.executed).toHaveLength(0);
  });
});

describe('Scenario 2: take over', () => {
  it('pauses the planner until released', async () => {
    const { queue, audit } = setup();
    const caseId = 'case-podiatry-001';
    expect(await queue.plannerMayAct(A.practiceId, caseId)).toBe(true);
    expect((await queue.takeOver(A, caseId)).ok).toBe(true);
    expect(await queue.takeOver(A, caseId)).toMatchObject({ ok: false });
    // A new payer event arrives: the planner is told not to act, and cannot enqueue.
    expect(await queue.plannerMayAct(A.practiceId, caseId)).toBe(false);
    expect(await queue.enqueue(A.practiceId, authFx!)).toMatchObject({ ok: false, code: 'case_taken_over' });
    expect(await queue.list(A.practiceId)).toHaveLength(0);
    // Other practices and cases are unaffected.
    expect(await queue.plannerMayAct(B.practiceId, caseId)).toBe(true);
    expect(await queue.plannerMayAct(A.practiceId, 'other-case')).toBe(true);

    expect((await queue.release(A, caseId)).ok).toBe(true);
    expect((await queue.release(A, caseId)).ok).toBe(false);
    expect(await queue.plannerMayAct(A.practiceId, caseId)).toBe(true);
    expect((await queue.enqueue(A.practiceId, authFx!)).ok).toBe(true);
    expect(audit.events.map((e) => e.action)).toEqual(['case.taken_over', 'case.released']);
  });
});

describe('expiry', () => {
  it('expires overdue items and escalates to the practice admin', async () => {
    const { queue, clock, escalator, audit } = setup({ expiryMs: 1000 });
    const old = await enqueue(queue, authFx!);
    clock.advanceMs(500);
    const fresh = await enqueue(queue, reminderFx!);
    clock.advanceMs(600);
    const expired = await queue.expireDue(A.practiceId);
    expect(expired.map((i) => i.id)).toEqual([old.id]);
    expect(escalator.escalations).toEqual([{ practiceId: A.practiceId, itemId: old.id, reason: 'Expired without review' }]);
    expect((await queue.get(A.practiceId, fresh.id))!.status).toBe('pending');
    expect(audit.events.some((e) => e.action === 'review.expired')).toBe(true);
    expect(await queue.expireDue(A.practiceId)).toEqual([]);
  });
});

describe('diffInputs', () => {
  it('diffs nested objects by path and arrays as whole values', () => {
    expect(
      diffInputs({ a: { b: 1, c: 2 }, l: [1], x: 1 }, { a: { b: 1, c: 3 }, l: [1, 2], y: 1 }),
    ).toEqual([
      { path: 'a.c', before: 2, after: 3 },
      { path: 'l', before: [1], after: [1, 2] },
      { path: 'x', before: 1, after: undefined },
      { path: 'y', before: undefined, after: 1 },
    ]);
    expect(diffInputs({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
