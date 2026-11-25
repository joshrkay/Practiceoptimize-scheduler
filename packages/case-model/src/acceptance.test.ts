/** RAH-15 acceptance scenarios, driven by the synthetic podiatry fixtures. */
import { describe, expect, it } from 'vitest';
import type { Case } from './case.js';
import { readinessItemId } from './readiness.js';
import {
  bookCase,
  cancelCase,
  changeCaseType,
  completeIntake,
  completeReadinessItem,
  completeRescheduling,
  createCaseFromOrder,
  findCoveringAuthorization,
  linkAuthorization,
  reopenCancelledCase,
  requestAuthorization,
} from './index.js';
import {
  context,
  expectOk,
  firstAuthorization,
  firstCase,
  loadCaseFixture,
  scheduler,
} from './test-support.js';

describe('Scenario 1: staged series shares one authorization', () => {
  it('shows the shared authorization on the second case and creates no new auth item', async () => {
    const fixture = loadCaseFixture('bunionectomy-staged-series');
    const auth = firstAuthorization(fixture);
    const { ctx, audit } = context('2026-11-20T15:00:00.000Z');

    let left = expectOk(await createCaseFromOrder(firstCase(fixture, 0), ctx));
    left = expectOk(await linkAuthorization(left, auth, ctx));

    let right = expectOk(await createCaseFromOrder(firstCase(fixture, 1), ctx));
    right = expectOk(await completeIntake(right, ctx));
    right = expectOk(await requestAuthorization(right, ctx));
    const authItemsBefore = right.readinessItems.filter((i) => i.kind === 'prior_authorization');

    // When the second case is checked for authorization
    const covering = findCoveringAuthorization(right, fixture.authorizations);
    expect(covering?.id).toBe(auth.id);
    right = expectOk(await linkAuthorization(right, auth, ctx));

    // Then it shows the shared authorization and no new auth item is created
    const authItems = right.readinessItems.filter((i) => i.kind === 'prior_authorization');
    expect(authItems).toHaveLength(1);
    expect(authItems).toHaveLength(authItemsBefore.length);
    expect(authItems[0]).toMatchObject({ status: 'complete', authorizationId: auth.id });
    expect(right.authorizationIds).toEqual([auth.id]);
    expect(left.authorizationIds).toEqual([auth.id]);
    expect(right.readinessItems).toHaveLength(authItemsBefore.length + 1); // eligibility + auth, nothing added
    expect(audit.events.filter((e) => e.action === 'case.authorization_linked')).toHaveLength(2);

    // And the shared authorization lets the second case book.
    right = expectOk(await bookCase(right, ctx));
    expect(right.state).toBe('booked');
  });
});

describe('Scenario 2: urgent add-on skips readiness', () => {
  it('moves straight to Booked and creates a post-surgery payer notification item', async () => {
    const fixture = loadCaseFixture('urgent-foot-infection-office');
    const { ctx, audit } = context('2026-11-25T13:15:00.000Z');

    const c = expectOk(await createCaseFromOrder(firstCase(fixture), ctx));

    expect(c.state).toBe('booked');
    expect(c.urgentAddOn).toBe(true);
    expect(c.billableAt).toBe(ctx.now);
    expect(c.readinessItems.some((i) => i.kind === 'prior_authorization')).toBe(false);
    const notification = c.readinessItems.find((i) => i.kind === 'payer_notification_post_surgery');
    expect(notification).toMatchObject({ phase: 'post_op', status: 'open', required: true });
    expect(c.readinessItems.find((i) => i.kind === 'retro_authorization')).toMatchObject({ phase: 'post_op' });
    expect(c.history.map((e) => [e.kind, e.toState])).toEqual([
      ['created', 'ordered'],
      ['state_changed', 'booked'],
    ]);
    expect(audit.events.map((e) => e.action)).toEqual(['case.created', 'case.state_changed']);
    expect(audit.events[1]).toMatchObject({ fromState: 'ordered', toState: 'booked', reason: 'urgent_add_on_signed_order' });
  });
});

describe('Scenario 3: denied to self-pay', () => {
  it('drops insurance items, adds quote and deposit items, and records a change event', async () => {
    const fixture = loadCaseFixture('bunion-denied-to-self-pay');
    const denied = firstAuthorization(fixture);
    const { ctx, audit } = context('2026-11-20T15:00:00.000Z');

    let c = expectOk(await createCaseFromOrder(firstCase(fixture), ctx));
    c = expectOk(await completeIntake(c, ctx));
    c = expectOk(await requestAuthorization(c, ctx));
    const link = await linkAuthorization(c, denied, ctx);
    expect(link.ok).toBe(false);

    c = expectOk(await changeCaseType(c, { to: 'self_pay', reason: 'authorization_denied' }, ctx));

    const kinds = c.readinessItems.map((i) => i.kind);
    expect(kinds).not.toContain('eligibility_check');
    expect(kinds).not.toContain('prior_authorization');
    expect(kinds).toEqual(expect.arrayContaining(['self_pay_quote', 'financial_consent', 'deposit']));
    expect(kinds).toContain('history_and_physical'); // clinical items are kept
    expect(c.caseType).toBe('self_pay');
    expect(c.procedures.every((p) => p.billing === 'self_pay')).toBe(true);
    const event = c.history.at(-1);
    expect(event).toMatchObject({
      kind: 'case_type_changed',
      fromCaseType: 'insured',
      toCaseType: 'self_pay',
      reason: 'authorization_denied',
    });
    expect(audit.events.at(-1)).toMatchObject({ action: 'case.case_type_changed', changeEventId: event?.id });

    // The deposit gate now applies: no booking until the processor confirms the deposit.
    expect(await bookCase(c, ctx)).toMatchObject({ ok: false, error: { code: 'deposit_not_confirmed' } });
    c = expectOk(
      await completeReadinessItem(c, readinessItemId(c.id, 'deposit'), { reference: 'proc-confirm-synthetic-01' }, ctx),
    );
    c = expectOk(await bookCase(c, ctx));
    expect(c.state).toBe('booked');
  });
});

describe('Scenario 4: reopen a cancelled case', () => {
  async function bookedThenCancelled(): Promise<Case> {
    const fixture = loadCaseFixture('cancelled-then-reopened');
    const { ctx } = context('2026-10-05T15:00:00.000Z');
    let c = expectOk(await createCaseFromOrder(firstCase(fixture), ctx));
    c = expectOk(await completeIntake(c, ctx));
    c = expectOk(
      await completeReadinessItem(c, readinessItemId(c.id, 'deposit'), { reference: 'proc-confirm-synthetic-02' }, ctx),
    );
    c = expectOk(await bookCase(c, ctx));
    const cancelCtx = context('2026-10-20T15:00:00.000Z').ctx;
    return expectOk(await cancelCase(c, { approvedBy: scheduler, reason: 'patient_request' }, cancelCtx));
  }

  it('reopens to Rescheduling with history intact and is not billed again', async () => {
    const cancelled = await bookedThenCancelled();
    const billedAt = cancelled.billableAt;
    expect(billedAt).toBe('2026-10-05T15:00:00.000Z');

    // Given a case cancelled 20 days ago, when the patient rebooks
    const { ctx, audit } = context('2026-11-09T15:00:00.000Z');
    let c = expectOk(await reopenCancelledCase(cancelled, ctx));

    expect(c.state).toBe('rescheduling');
    expect(c.history.slice(0, cancelled.history.length)).toEqual(cancelled.history);
    expect(c.history.at(-1)).toMatchObject({ fromState: 'cancelled', toState: 'rescheduling', reason: 'reopened' });
    expect(audit.events).toHaveLength(1);

    c = expectOk(
      await completeRescheduling(
        c,
        { surgeryDate: '2026-12-01', slot: { start: '2026-12-01T15:00:00.000Z', end: '2026-12-01T16:00:00.000Z' } },
        [],
        ctx,
      ),
    );
    expect(c.state).toBe('booked');
    expect(c.billableAt).toBe(billedAt);
  });

  it('refuses to reopen after 90 days', async () => {
    const cancelled = await bookedThenCancelled();
    const { ctx } = context('2027-01-19T15:00:01.000Z');
    expect(await reopenCancelledCase(cancelled, ctx)).toMatchObject({
      ok: false,
      error: { code: 'reopen_window_expired' },
    });
  });
});
