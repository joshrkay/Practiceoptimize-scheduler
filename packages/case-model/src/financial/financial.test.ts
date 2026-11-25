import { describe, expect, it } from 'vitest';
import {
  FakeFinancialPorts,
  FlowTransitionError,
  InMemoryFlowStore,
  QuoteError,
  SelfPayFlowService,
  applyFlowEvent,
  createQuote,
  depositReadinessItem,
  evaluateDepositGate,
  initialFlowState,
  isQuoteExpired,
  paidCents,
  resolveDepositTiming,
  splitCaseByCoverage,
  type CaseProcedure,
  type CreateQuoteInput,
  type FlowState,
} from './index.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const LATER = new Date('2026-03-15T12:00:00Z');
const STAFF = { kind: 'staff', userId: 'user-staff-1' } as const;
const P = 'practice-podiatry-1';
const C = 'case-1';

const cosmetic: CaseProcedure = { procedureId: 'proc-cosmetic-toe', description: 'Cosmetic toe shortening', coverage: 'self_pay' };
const bunion: CaseProcedure = { procedureId: 'proc-bunionectomy', description: 'Bunionectomy', coverage: 'insured' };

const quoteInput = (over: Partial<CreateQuoteInput> = {}): CreateQuoteInput => ({
  quoteId: 'q1',
  practiceId: P,
  caseId: C,
  actor: STAFF,
  procedures: [cosmetic],
  lines: [{ procedureId: cosmetic.procedureId, description: cosmetic.description, amountCents: 400000 }],
  depositCents: 100000,
  expiresAt: LATER,
  now: NOW,
  ...over,
});

function setup(now = () => NOW) {
  const ports = new FakeFinancialPorts();
  const store = new InMemoryFlowStore();
  const svc = new SelfPayFlowService({
    store,
    consent: ports,
    patientPage: ports,
    messages: ports,
    depositLinks: ports,
    staffWork: ports,
    now,
  });
  return { ports, svc };
}

describe('quote', () => {
  it('derives the total from lines and keeps the human deposit', () => {
    const q = createQuote(quoteInput());
    expect(q.totalCents).toBe(400000);
    expect(q.depositCents).toBe(100000);
    expect(q.enteredBy).toEqual(STAFF);
    expect(isQuoteExpired(q, NOW)).toBe(false);
    expect(isQuoteExpired(q, LATER)).toBe(true);
  });

  it('accepts the surgeon as an actor', () => {
    expect(createQuote(quoteInput({ actor: { kind: 'surgeon', userId: 'u2' } })).enteredBy.kind).toBe('surgeon');
  });

  it('makes agent pricing impossible by type and rejects it at runtime', () => {
    // @ts-expect-error an agent actor is not a HumanActor
    const attempt = () => createQuote(quoteInput({ actor: { kind: 'agent', agentId: 'agent-1' } }));
    expect(attempt).toThrow(QuoteError);
  });

  it('rejects invalid quotes', () => {
    expect(() => createQuote(quoteInput({ lines: [] }))).toThrow(/at least one line/);
    expect(() => createQuote(quoteInput({ depositCents: 400001 }))).toThrow(/Deposit/);
    expect(() => createQuote(quoteInput({ depositCents: -1 }))).toThrow(/Deposit/);
    expect(() => createQuote(quoteInput({ expiresAt: NOW }))).toThrow(/expiry/);
    const line = { procedureId: cosmetic.procedureId, description: 'x', amountCents: 100 };
    expect(() => createQuote(quoteInput({ lines: [{ ...line, amountCents: 1.5 }] }))).toThrow(/invalid amount/);
    expect(() => createQuote(quoteInput({ lines: [line, line] }))).toThrow(/Duplicate/);
  });
});

describe('mixed case', () => {
  it('splits authorization to insured procedures and the quote to self-pay procedures', () => {
    const split = splitCaseByCoverage([bunion, cosmetic]);
    expect(split.authorizationProcedureIds).toEqual(['proc-bunionectomy']);
    expect(split.quoteProcedureIds).toEqual(['proc-cosmetic-toe']);
    expect(split.isMixed).toBe(true);
    expect(split.isSelfPayOnly).toBe(false);
    expect(splitCaseByCoverage([cosmetic]).isSelfPayOnly).toBe(true);
  });

  it('refuses a quote line for the insured procedure', () => {
    const lines = [
      { procedureId: cosmetic.procedureId, description: 'c', amountCents: 300000 },
      { procedureId: bunion.procedureId, description: 'b', amountCents: 500000 },
    ];
    expect(() => createQuote(quoteInput({ procedures: [bunion, cosmetic], lines }))).toThrow(/not a self-pay/);
    const q = createQuote(quoteInput({ procedures: [bunion, cosmetic], lines: lines.slice(0, 1), depositCents: 50000 }));
    expect(q.lines.map((l) => l.procedureId)).toEqual(['proc-cosmetic-toe']);
  });
});

describe('deposit timing and gate', () => {
  it('defaults to deposit before Booked', () => {
    expect(resolveDepositTiming(undefined)).toBe('before_booked');
    expect(resolveDepositTiming({})).toBe('before_booked');
    expect(resolveDepositTiming({ depositTiming: 'readiness_item' })).toBe('readiness_item');
  });

  it('holds Booked until the deposit is confirmed, then releases', async () => {
    const { svc } = setup();
    const q = createQuote(quoteInput());
    await svc.recordQuote(q);
    await svc.sendQuote(P, C);
    await svc.onConsentSigned(P, C, 'q1');
    const unpaid = await svc.getState(P, C);
    expect(unpaid.status).toBe('deposit_link_sent');
    expect(evaluateDepositGate({ timing: 'before_booked', flow: unpaid })).toEqual({
      canBook: false,
      reason: 'deposit_not_confirmed',
    });
    const r = await svc.recordDepositPayment({
      practiceId: P,
      caseId: C,
      processor: 'fake-processor',
      processorEventId: 'evt-1',
      amountCents: 100000,
    });
    expect(r.depositConfirmed).toBe(true);
    const paid = await svc.getState(P, C);
    expect(evaluateDepositGate({ timing: 'before_booked', flow: paid })).toEqual({
      canBook: true,
      reason: 'deposit_confirmed',
    });
  });

  it('never holds back an urgent add-on (ADR-0007)', () => {
    const flow = initialFlowState(P, C);
    expect(evaluateDepositGate({ timing: 'before_booked', flow, urgentAddOn: true })).toEqual({
      canBook: true,
      reason: 'urgent_add_on_not_held',
    });
  });

  it('readiness_item timing does not hold booking and exposes a readiness item', () => {
    const flow = initialFlowState(P, C);
    expect(evaluateDepositGate({ timing: 'readiness_item', flow }).canBook).toBe(true);
    expect(depositReadinessItem('readiness_item', flow)).toEqual({ key: 'deposit', dueBefore: 'surgery', satisfied: false });
    expect(depositReadinessItem('before_booked', flow)).toBeNull();
  });
});

describe('flow service', () => {
  it('sends quote, consent request, then the human-entered deposit link', async () => {
    const { ports, svc } = setup();
    await svc.recordQuote(createQuote(quoteInput()));
    expect((await svc.sendQuote(P, C)).status).toBe('quote_sent');
    expect((await svc.onConsentSigned(P, C, 'q1')).status).toBe('deposit_link_sent');
    expect(ports.calls).toEqual([
      'page:quote',
      'consent',
      'message:quote_ready',
      'link:100000',
      'page:deposit_link',
      'message:deposit_link',
    ]);
  });

  it('keeps partial payments pending and ignores duplicate event ids', async () => {
    const { svc } = setup();
    await svc.recordQuote(createQuote(quoteInput()));
    await svc.sendQuote(P, C);
    await svc.onConsentSigned(P, C, 'q1');
    const pay = (id: string, amountCents: number) =>
      svc.recordDepositPayment({ practiceId: P, caseId: C, processor: 'proc', processorEventId: id, amountCents });
    expect((await pay('e1', 40000)).depositConfirmed).toBe(false);
    expect((await pay('e1', 40000)).depositConfirmed).toBe(false);
    expect(paidCents(await svc.getState(P, C))).toBe(40000);
    expect((await pay('e2', 60000)).depositConfirmed).toBe(true);
  });

  it('reopens an expired quote for staff', async () => {
    let clock = NOW;
    const { ports, svc } = setup(() => clock);
    await svc.recordQuote(createQuote(quoteInput()));
    await svc.sendQuote(P, C);
    expect((await svc.checkExpiry(P, C)).status).toBe('quote_sent');
    clock = LATER;
    const s = await svc.checkExpiry(P, C);
    expect(s.status).toBe('quote_needed');
    expect(ports.quoteTasks).toEqual([{ kind: 'enter_quote', practiceId: P, caseId: C, reason: 'quote_expired' }]);
    await svc.checkExpiry(P, C);
    expect(ports.quoteTasks).toHaveLength(1);
  });

  it('creates a quote task when a denial flips the case to self-pay', async () => {
    const { ports, svc } = setup();
    await svc.onDenialFlippedToSelfPay(P, C);
    expect(ports.quoteTasks).toEqual([
      { kind: 'enter_quote', practiceId: P, caseId: C, reason: 'denial_flipped_to_self_pay' },
    ]);
  });

  it('flags a refund for staff when a case with a paid deposit is cancelled, and moves no money', async () => {
    const { ports, svc } = setup();
    await svc.recordQuote(createQuote(quoteInput()));
    await svc.sendQuote(P, C);
    await svc.onConsentSigned(P, C, 'q1');
    await svc.recordDepositPayment({ practiceId: P, caseId: C, processor: 'stripe', processorEventId: 'e1', amountCents: 100000 });
    const s = await svc.onCaseCancelled(P, C);
    expect(s.status).toBe('cancelled');
    expect(ports.refundFlags).toEqual([
      { kind: 'refund_flag', practiceId: P, caseId: C, amountCents: 100000, processor: 'stripe', status: 'needs_staff_refund' },
    ]);
    await svc.onCaseCancelled(P, C);
    expect(ports.refundFlags).toHaveLength(1);
    // No port exposes a way to refund or move money.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(ports)).concat(
      Object.getOwnPropertyNames(SelfPayFlowService.prototype),
    );
    expect(surface.filter((n) => /refund(?!Flag)|charge|capture/i.test(n))).toEqual([]);
  });

  it('raises no refund flag when nothing was paid', async () => {
    const { ports, svc } = setup();
    await svc.onCaseCancelled(P, C);
    expect(ports.refundFlags).toEqual([]);
  });
});

describe('flow transitions', () => {
  const quote = createQuote(quoteInput());
  const base: FlowState = initialFlowState(P, C);

  it('rejects out-of-order events', () => {
    expect(() => applyFlowEvent(base, { type: 'quote_sent' })).toThrow(FlowTransitionError);
    expect(() => applyFlowEvent(base, { type: 'consent_signed', quoteId: 'q1' })).toThrow(/not allowed/);
    const withQuote = applyFlowEvent(base, { type: 'quote_entered', quote }).state;
    const sent = applyFlowEvent(withQuote, { type: 'quote_sent' }).state;
    expect(() => applyFlowEvent(sent, { type: 'consent_signed', quoteId: 'other' })).toThrow(/different quote/);
    expect(() => applyFlowEvent(sent, { type: 'deposit_paid', payment: { processor: 'p', processorEventId: 'e', amountCents: 1 } })).toThrow(
      /not allowed/,
    );
  });

  it('rejects a quote for another case or practice', () => {
    const other = createQuote(quoteInput({ caseId: 'case-2' }));
    expect(() => applyFlowEvent(base, { type: 'quote_entered', quote: other })).toThrow(/different case/);
  });

  it('a replaced quote voids earlier consent', () => {
    let s = applyFlowEvent(base, { type: 'quote_entered', quote }).state;
    s = applyFlowEvent(s, { type: 'quote_sent' }).state;
    s = applyFlowEvent(s, { type: 'consent_signed', quoteId: 'q1' }).state;
    s = applyFlowEvent(s, { type: 'quote_entered', quote: createQuote(quoteInput({ quoteId: 'q2' })) }).state;
    expect(s.status).toBe('quote_needed');
  });

  it('does not create a denial task when a quote already exists', () => {
    const s = applyFlowEvent(base, { type: 'quote_entered', quote }).state;
    expect(applyFlowEvent(s, { type: 'denial_flipped_to_self_pay' }).effects).toEqual([]);
  });

  it('quote_sent requires an entered quote', () => {
    expect(() => applyFlowEvent({ ...base, status: 'quote_needed' }, { type: 'quote_sent' })).toThrow(/No quote/);
  });
});
