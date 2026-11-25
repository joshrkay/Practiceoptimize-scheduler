import { describe, expect, it } from 'vitest';
import type { AuditSink } from './ports.js';
import type { Case, CaseState, ReadinessItem } from './case.js';
import { CASE_STATES } from './case.js';
import { readinessItemId } from './readiness.js';
import {
  AUTO_CLOSE_DAYS_AFTER_SURGERY,
  CASE_TRANSITIONS,
  addDays,
  allowedTransitions,
  autoCloseAt,
  blockCase,
  bookCase,
  canTransition,
  cancelCase,
  changeCaseType,
  closeCase,
  completeIntake,
  completeReadinessItem,
  completeRescheduling,
  confirmCase,
  createCaseFromOrder,
  linkAuthorization,
  markReady,
  recheckReadiness,
  recordSurgeryDone,
  reopenCancelledCase,
  requestAuthorization,
  startRescheduling,
  unblockCase,
  type NewCaseInput,
  type TransitionContext,
} from './state-machine.js';
import {
  agent,
  context,
  expectOk,
  firstAuthorization,
  firstCase,
  loadCaseFixture,
  scheduler,
} from './test-support.js';

const NOW = '2026-11-20T15:00:00.000Z';

const clinicalItem = (caseId: string, status: ReadinessItem['status'] = 'open'): ReadinessItem => ({
  id: readinessItemId(caseId, 'history_and_physical'),
  kind: 'history_and_physical',
  category: 'clinical',
  phase: 'pre_op',
  required: true,
  status,
});

function seriesFixture() {
  const fixture = loadCaseFixture('bunionectomy-staged-series');
  return { input: firstCase(fixture, 0), auth: firstAuthorization(fixture), fixture };
}

/** Insured left bunionectomy taken to Booked with the series authorization. */
async function bookedInsured(ctx: TransitionContext, extra: Partial<NewCaseInput> = {}): Promise<Case> {
  const { input, auth } = seriesFixture();
  let c = expectOk(await createCaseFromOrder({ ...input, ...extra }, ctx));
  c = expectOk(await completeIntake(c, ctx));
  c = expectOk(await requestAuthorization(c, ctx));
  c = expectOk(await linkAuthorization(c, auth, ctx));
  return expectOk(await bookCase(c, ctx));
}

async function completeAll(c: Case, ctx: TransitionContext): Promise<Case> {
  let next = c;
  for (const item of c.readinessItems) {
    if (item.status === 'complete' || item.phase !== 'pre_op') continue;
    next = expectOk(await completeReadinessItem(next, item.id, { reference: 'ref-synthetic' }, ctx));
  }
  return next;
}

describe('CASE_TRANSITIONS', () => {
  it('has an entry for every state and only targets known states', () => {
    expect(Object.keys(CASE_TRANSITIONS).sort()).toEqual([...CASE_STATES].sort());
    for (const from of CASE_STATES) {
      for (const to of allowedTransitions(from)) expect(CASE_STATES).toContain(to);
    }
  });

  it('makes Closed terminal and allows Cancelled only to reopen', () => {
    expect(allowedTransitions('closed')).toEqual([]);
    expect(allowedTransitions('cancelled')).toEqual(['rescheduling']);
    expect(canTransition('surgery_done', 'cancelled')).toBe(false);
    expect(canTransition('ordered', 'booked')).toBe(true);
    expect(canTransition('ready', 'surgery_done')).toBe(false);
  });

  it('lets every pre-surgery state be blocked and cancelled', () => {
    const preSurgery: CaseState[] = ['ordered', 'intake_done', 'auth_pending', 'booked', 'ready', 'confirmed', 'rescheduling'];
    for (const s of preSurgery) {
      expect(canTransition(s, 'blocked')).toBe(true);
      expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });
});

describe('createCaseFromOrder', () => {
  it('refuses an unsigned order', async () => {
    const { input } = seriesFixture();
    const { signature: _signature, ...unsigned } = input.order;
    const { ctx, audit } = context(NOW);
    expect(await createCaseFromOrder({ ...input, order: unsigned }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'order_not_signed' },
    });
    expect(audit.events).toEqual([]);
  });

  it('refuses an order from another practice', async () => {
    const { input } = seriesFixture();
    const { ctx } = context(NOW);
    const result = await createCaseFromOrder({ ...input, practiceId: 'practice-synthetic-other' }, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'practice_mismatch' } });
  });

  it('refuses an urgent order without a slot', async () => {
    const input = firstCase(loadCaseFixture('urgent-foot-infection-office'));
    const { slot: _slot, ...noSlot } = input;
    const { ctx } = context(NOW);
    expect(await createCaseFromOrder(noSlot, ctx)).toMatchObject({ ok: false, error: { code: 'slot_required' } });
  });

  it('creates a routine case in Ordered with insurance items and an audit event', async () => {
    const { input } = seriesFixture();
    const { ctx, audit } = context(NOW, agent);
    const c = expectOk(await createCaseFromOrder(input, ctx));
    expect(c.state).toBe('ordered');
    expect(c.seriesId).toBe('series-bunion-staged-01');
    expect(c.readinessItems.map((i) => i.kind)).toEqual(['eligibility_check', 'prior_authorization']);
    expect(c.billableAt).toBeUndefined();
    expect(audit.events).toEqual([
      expect.objectContaining({
        action: 'case.created',
        practiceId: input.practiceId,
        caseId: input.id,
        actor: agent,
        toState: 'ordered',
        changeEventId: `${input.id}:0`,
      }),
    ]);
  });

  it('books an urgent self-pay add-on without waiting for the deposit (ADR-0007)', async () => {
    const input = firstCase(loadCaseFixture('urgent-foot-infection-office'));
    const { ctx } = context(NOW);
    const c = expectOk(
      await createCaseFromOrder(
        { ...input, caseType: 'self_pay', procedures: input.procedures.map((p) => ({ ...p, billing: 'self_pay' })) },
        ctx,
      ),
    );
    expect(c.state).toBe('booked');
    expect(c.readinessItems.find((i) => i.kind === 'deposit')?.status).toBe('open');
    expect(c.readinessItems.some((i) => i.kind === 'payer_notification_post_surgery')).toBe(false);
  });

  it('does not create the case when the audit write fails', async () => {
    const { input } = seriesFixture();
    const failing: AuditSink = { record: () => Promise.reject(new Error('audit unavailable')) };
    await expect(createCaseFromOrder(input, { now: NOW, actor: scheduler, audit: failing })).rejects.toThrow(
      'audit unavailable',
    );
  });

  it('does not mutate its input', async () => {
    const { input } = seriesFixture();
    const snapshot = structuredClone(input);
    const { ctx } = context(NOW);
    await createCaseFromOrder(input, ctx);
    expect(input).toEqual(snapshot);
  });
});

describe('forward path', () => {
  it('runs Ordered through Closed for an insured case', async () => {
    const { ctx, audit } = context(NOW);
    let c = await bookedInsured(ctx, { clinicalReadinessItems: [clinicalItem('case-bunion-left-01')] });
    expect(c.billableAt).toBe(NOW);

    expect(await markReady(c, ctx)).toMatchObject({ ok: false, error: { code: 'readiness_incomplete' } });
    c = await completeAll(c, ctx);
    c = expectOk(await markReady(c, ctx));
    c = expectOk(await confirmCase(c, ctx));
    c = expectOk(await recordSurgeryDone(c, context('2026-12-07T16:00:00.000Z').ctx));
    expect(c.surgeryCompletedAt).toBe('2026-12-07T16:00:00.000Z');

    expect(await closeCase(c, context('2026-12-10T12:00:00.000Z').ctx)).toMatchObject({
      ok: false,
      error: { code: 'close_not_due' },
    });
    const closeCtx = context('2026-12-14T12:00:00.000Z').ctx;
    c = expectOk(await closeCase(c, closeCtx, { firstPostOpVisitAt: '2026-12-14T11:00:00.000Z' }));
    expect(c.state).toBe('closed');
    expect(c.firstPostOpVisitAt).toBe('2026-12-14T11:00:00.000Z');
    expect(c.phiDeletionDueAt).toBe('2027-03-14T12:00:00.000Z');
    expect(c.history.at(-1)?.reason).toBe('first_post_op_visit');
    expect(audit.events.length).toBeGreaterThan(5);
  });

  it('closes 30 days after surgery when no post-op visit happened', async () => {
    const input = firstCase(loadCaseFixture('urgent-foot-infection-office'));
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(input, ctx));
    c = expectOk(await recordSurgeryDone(c, ctx));
    const due = autoCloseAt(c);
    expect(due).toBe(addDays(NOW, AUTO_CLOSE_DAYS_AFTER_SURGERY));
    c = expectOk(await closeCase(c, context(due ?? '').ctx));
    expect(c.history.at(-1)?.reason).toBe('thirty_days_after_surgery');
    expect(autoCloseAt({})).toBeUndefined();
  });

  it('only lets an urgent add-on go from Booked straight to surgery', async () => {
    const { ctx } = context(NOW);
    const c = await bookedInsured(ctx);
    expect(await recordSurgeryDone(c, ctx)).toMatchObject({ ok: false, error: { code: 'not_urgent_add_on' } });
  });

  it('refuses to close a case that is not in Surgery done', async () => {
    const { ctx } = context(NOW);
    const c = await bookedInsured(ctx);
    expect(await closeCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
  });

  it('refuses Ready when an item expires before the surgery date', async () => {
    const { ctx } = context(NOW);
    let c = await bookedInsured(ctx, { clinicalReadinessItems: [clinicalItem('case-bunion-left-01')] });
    c = await completeAll(c, ctx);
    c = expectOk(
      await completeReadinessItem(c, readinessItemId(c.id, 'history_and_physical'), { validUntil: '2026-12-01' }, ctx),
    );
    expect(await markReady(c, ctx)).toMatchObject({ ok: false, error: { code: 'readiness_incomplete' } });
  });

  it('guards markReady and confirmCase by state', async () => {
    const { ctx } = context(NOW);
    const c = expectOk(await createCaseFromOrder(seriesFixture().input, ctx));
    expect(await markReady(c, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
    expect(await confirmCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
  });

  it('refuses to confirm when readiness lapsed, and recheckReadiness drops the case to Booked', async () => {
    const { ctx } = context(NOW);
    let c = await bookedInsured(ctx);
    c = await completeAll(c, ctx);
    c = expectOk(await markReady(c, ctx));
    const lapsed: Case = {
      ...c,
      readinessItems: c.readinessItems.map((i) => (i.kind === 'eligibility_check' ? { ...i, status: 'open' } : i)),
    };
    expect(await confirmCase(lapsed, ctx)).toMatchObject({ ok: false, error: { code: 'readiness_incomplete' } });
    expect(expectOk(await recheckReadiness(c, ctx))).toBe(c);
    const dropped = expectOk(await recheckReadiness(lapsed, ctx));
    expect(dropped.state).toBe('booked');
    expect(dropped.history.at(-1)?.reason).toBe('readiness_lapsed');
  });
});

describe('booking guards', () => {
  it('requires insured and mixed cases to pass Auth pending', async () => {
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(seriesFixture().input, ctx));
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'not_urgent_add_on' } });
    c = expectOk(await completeIntake(c, ctx));
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'authorization_required' } });
    c = expectOk(await requestAuthorization(c, ctx));
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'authorization_required' } });
  });

  it('refuses requestAuthorization for self-pay, which books straight from Intake done', async () => {
    const input = firstCase(loadCaseFixture('cancelled-then-reopened'));
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(input, ctx));
    c = expectOk(await completeIntake(c, ctx));
    expect(await requestAuthorization(c, ctx)).toMatchObject({
      ok: false,
      error: { code: 'not_applicable_for_case_type' },
    });
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'deposit_not_confirmed' } });
    const noDepositRule = { ...ctx, bookingPolicy: { depositRequiredBeforeBooking: { self_pay: false, mixed: false } } };
    expect(expectOk(await bookCase(c, noDepositRule)).state).toBe('booked');
  });

  it('requires a slot', async () => {
    const { input, auth } = seriesFixture();
    const { slot: _slot, ...noSlot } = input;
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(noSlot, ctx));
    c = expectOk(await completeIntake(c, ctx));
    c = expectOk(await requestAuthorization(c, ctx));
    c = expectOk(await linkAuthorization(c, auth, ctx));
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'slot_required' } });
  });

  it('gates a mixed case on both authorization and deposit', async () => {
    const fixture = loadCaseFixture('mixed-insured-cosmetic');
    const auth = firstAuthorization(fixture);
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(firstCase(fixture), ctx));
    expect(c.readinessItems.map((i) => i.kind)).toEqual([
      'eligibility_check',
      'prior_authorization',
      'self_pay_quote',
      'financial_consent',
      'deposit',
    ]);
    c = expectOk(await completeIntake(c, ctx));
    c = expectOk(await requestAuthorization(c, ctx));
    // The authorization only lists the insured code; the cosmetic code does not need it.
    c = expectOk(await linkAuthorization(c, auth, ctx));
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'deposit_not_confirmed' } });
    expect(await completeReadinessItem(c, readinessItemId(c.id, 'deposit'), {}, ctx)).toMatchObject({
      ok: false,
      error: { code: 'deposit_reference_required' },
    });
    c = expectOk(await completeReadinessItem(c, readinessItemId(c.id, 'deposit'), { reference: 'proc-1' }, ctx));
    expect(expectOk(await bookCase(c, ctx)).state).toBe('booked');
  });

  it('refuses bookCase from states with their own path', async () => {
    const { ctx } = context(NOW);
    const booked = await bookedInsured(ctx);
    expect(await bookCase(booked, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
    const resched = expectOk(await startRescheduling(booked, 'surgeon_unavailable', ctx));
    expect(await bookCase(resched, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
  });

  it('refuses unknown readiness items and non-covering authorizations', async () => {
    const { input, auth } = seriesFixture();
    const { ctx } = context(NOW);
    const c = expectOk(await createCaseFromOrder({ ...input, surgeryDate: '2027-06-01' }, ctx));
    expect(await completeReadinessItem(c, 'nope', {}, ctx)).toMatchObject({
      ok: false,
      error: { code: 'readiness_item_not_found' },
    });
    const result = await linkAuthorization(c, auth, ctx);
    expect(result).toMatchObject({ ok: false, error: { code: 'authorization_not_covering' } });
    expect(!result.ok && result.error.message).toContain('date_outside_window');
  });
});

describe('Blocked', () => {
  it('requires a reason and returns to the state it was blocked from', async () => {
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(seriesFixture().input, ctx));
    c = expectOk(await completeIntake(c, ctx));
    expect(await blockCase(c, '  ', ctx)).toMatchObject({ ok: false, error: { code: 'reason_required' } });
    c = expectOk(await blockCase(c, 'missing_insurance_card', ctx));
    expect(c).toMatchObject({ state: 'blocked', blockedFrom: 'intake_done', blockedReason: 'missing_insurance_card' });
    expect(await blockCase(c, 'again', ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
    c = expectOk(await unblockCase(c, ctx));
    expect(c.state).toBe('intake_done');
    expect(c.blockedFrom).toBeUndefined();
    expect(c.blockedReason).toBeUndefined();
    expect(await unblockCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
  });

  it('returns a case blocked from Ready to Booked when readiness lapsed', async () => {
    const { ctx } = context(NOW);
    let c = await completeAll(await bookedInsured(ctx), ctx);
    c = expectOk(await markReady(c, ctx));
    c = expectOk(await blockCase(c, 'facility_hold', ctx));
    c = { ...c, readinessItems: c.readinessItems.map((i) => ({ ...i, status: 'open' as const })) };
    c = expectOk(await unblockCase(c, ctx));
    expect(c.state).toBe('booked');
    expect(c.history.at(-1)?.reason).toBe('unblocked_readiness_lapsed');
  });

  it('cannot block after surgery', async () => {
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(firstCase(loadCaseFixture('urgent-foot-infection-office')), ctx));
    c = expectOk(await recordSurgeryDone(c, ctx));
    expect(await blockCase(c, 'x', ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
  });
});

describe('Rescheduling', () => {
  it('re-enters at Booked when the new date stays inside the authorization window', async () => {
    const { auth } = seriesFixture();
    const { ctx } = context(NOW);
    let c = await bookedInsured(ctx);
    expect(await startRescheduling(c, '', ctx)).toMatchObject({ ok: false, error: { code: 'reason_required' } });
    c = expectOk(await startRescheduling(c, 'surgeon_unavailable', ctx));
    c = expectOk(
      await completeRescheduling(
        c,
        { surgeryDate: '2026-12-14', slot: { start: '2026-12-14T14:00:00.000Z', end: '2026-12-14T15:30:00.000Z' } },
        [auth],
        ctx,
      ),
    );
    expect(c.state).toBe('booked');
    expect(c.surgeryDate).toBe('2026-12-14');
    expect(c.history.at(-1)).toMatchObject({ kind: 'rescheduled', reason: 'inside_authorization_window' });
  });

  it('re-enters at Auth pending when the new date or codes leave the window', async () => {
    const { auth } = seriesFixture();
    const { ctx } = context(NOW);
    let c = await bookedInsured(ctx);
    c = expectOk(await startRescheduling(c, 'patient_request', ctx));
    const late = expectOk(await completeRescheduling(c, { surgeryDate: '2027-04-05' }, [auth], ctx));
    expect(late.state).toBe('auth_pending');
    expect(late.readinessItems.find((i) => i.kind === 'prior_authorization')).toEqual({
      id: readinessItemId(c.id, 'prior_authorization'),
      kind: 'prior_authorization',
      category: 'insurance',
      phase: 'pre_op',
      required: true,
      status: 'open',
    });

    const newCode = expectOk(
      await completeRescheduling(
        c,
        { procedures: [{ cptCode: '28297', description: 'Lapidus bunionectomy', billing: 'insured' }] },
        [auth],
        ctx,
      ),
    );
    expect(newCode.state).toBe('auth_pending');

    // An authorization we cannot see is treated as not covering.
    expect(expectOk(await completeRescheduling(c, {}, [], ctx)).state).toBe('auth_pending');
  });

  it('refuses completeRescheduling outside Rescheduling, and startRescheduling from Cancelled', async () => {
    const { ctx } = context(NOW);
    const c = await bookedInsured(ctx);
    expect(await completeRescheduling(c, {}, [], ctx)).toMatchObject({
      ok: false,
      error: { code: 'transition_not_allowed' },
    });
    const cancelled = expectOk(await cancelCase(c, { approvedBy: scheduler, reason: 'patient_request' }, ctx));
    expect(await startRescheduling(cancelled, 'rebook', ctx)).toMatchObject({
      ok: false,
      error: { code: 'transition_not_allowed' },
    });
  });

  it('applies the deposit gate when a self-pay case is rebooked', async () => {
    const input = firstCase(loadCaseFixture('cancelled-then-reopened'));
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(input, ctx));
    c = expectOk(await completeIntake(c, ctx));
    c = expectOk(await cancelCase(c, { approvedBy: scheduler, reason: 'patient_request' }, ctx));
    c = expectOk(await reopenCancelledCase(c, ctx));
    expect(await completeRescheduling(c, {}, [], ctx)).toMatchObject({
      ok: false,
      error: { code: 'deposit_not_confirmed' },
    });
  });
});

describe('Cancelled', () => {
  it('requires a human approver and a reason', async () => {
    const { ctx, audit } = context(NOW, agent);
    const c = expectOk(await createCaseFromOrder(seriesFixture().input, ctx));
    expect(await cancelCase(c, { approvedBy: agent, reason: 'patient_request' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'human_approver_required' },
    });
    expect(await cancelCase(c, { approvedBy: scheduler, reason: '' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'reason_required' },
    });
    const cancelled = expectOk(await cancelCase(c, { approvedBy: scheduler, reason: 'patient_request' }, ctx));
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelledAt: NOW });
    expect(audit.events.at(-1)).toMatchObject({
      action: 'case.state_changed',
      actor: agent,
      toState: 'cancelled',
      details: { approvedBy: scheduler.kind === 'human' ? scheduler.userId : '' },
    });
  });

  it('cancels from Blocked and clears the block', async () => {
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(seriesFixture().input, ctx));
    c = expectOk(await blockCase(c, 'waiting_on_patient', ctx));
    c = expectOk(await cancelCase(c, { approvedBy: scheduler, reason: 'patient_request' }, ctx));
    expect(c.blockedFrom).toBeUndefined();
  });

  it('cannot cancel after surgery, and reopen needs a cancelled case', async () => {
    const { ctx } = context(NOW);
    let c = expectOk(await createCaseFromOrder(firstCase(loadCaseFixture('urgent-foot-infection-office')), ctx));
    expect(await reopenCancelledCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'transition_not_allowed' } });
    c = expectOk(await recordSurgeryDone(c, ctx));
    expect(await cancelCase(c, { approvedBy: scheduler, reason: 'x' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'transition_not_allowed' },
    });
  });
});

describe('changeCaseType', () => {
  it('keeps completed financial items that still apply, and drops Ready to Booked when new items are open', async () => {
    const { ctx } = context(NOW);
    let c = await completeAll(await bookedInsured(ctx), ctx);
    c = expectOk(await markReady(c, ctx));
    const procedures = [
      ...c.procedures,
      { cptCode: '28899', description: 'Cosmetic toe procedure (unlisted)', billing: 'self_pay' as const },
    ];
    c = expectOk(await changeCaseType(c, { to: 'mixed', reason: 'cosmetic_add_on', procedures }, ctx));
    expect(c.caseType).toBe('mixed');
    expect(c.state).toBe('booked');
    expect(c.readinessItems.find((i) => i.kind === 'prior_authorization')?.status).toBe('complete');
    expect(c.readinessItems.find((i) => i.kind === 'deposit')?.status).toBe('open');
    expect(c.history.slice(-2).map((e) => e.kind)).toEqual(['case_type_changed', 'state_changed']);
  });

  it('rejects invalid changes', async () => {
    const { ctx } = context(NOW);
    const c = expectOk(await createCaseFromOrder(seriesFixture().input, ctx));
    expect(await changeCaseType(c, { to: 'insured', reason: 'x' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_case_type_change' },
    });
    expect(await changeCaseType(c, { to: 'mixed', reason: 'x' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_case_type_change' },
    });
    expect(await changeCaseType(c, { to: 'self_pay', reason: '' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'reason_required' },
    });
    const urgent = expectOk(
      await recordSurgeryDone(
        expectOk(await createCaseFromOrder(firstCase(loadCaseFixture('urgent-foot-infection-office')), ctx)),
        ctx,
      ),
    );
    expect(await changeCaseType(urgent, { to: 'self_pay', reason: 'x' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'invalid_case_type_change' },
    });
  });

  it('turns a self-pay case insured and adds the insurance items', async () => {
    const { ctx } = context(NOW);
    const c = expectOk(await createCaseFromOrder(firstCase(loadCaseFixture('cancelled-then-reopened')), ctx));
    const insured = expectOk(await changeCaseType(c, { to: 'insured', reason: 'coverage_found' }, ctx));
    expect(insured.readinessItems.map((i) => i.kind)).toEqual(['eligibility_check', 'prior_authorization']);
    expect(insured.procedures.every((p) => p.billing === 'insured')).toBe(true);
    expect(insured.state).toBe('ordered');
  });
});
