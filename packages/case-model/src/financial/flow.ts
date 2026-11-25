import { isQuoteExpired, type Quote } from './quote.js';
import type { Cents } from './types.js';

export type FlowStatus =
  | 'quote_needed'
  | 'quote_sent'
  | 'consent_signed'
  | 'deposit_link_sent'
  | 'deposit_confirmed'
  | 'cancelled';

export interface DepositPayment {
  readonly processor: string;
  readonly processorEventId: string;
  readonly amountCents: Cents;
}

export interface FlowState {
  readonly practiceId: string;
  readonly caseId: string;
  readonly status: FlowStatus;
  readonly quote: Quote | null;
  readonly payments: readonly DepositPayment[];
}

export type QuoteTaskReason = 'denial_flipped_to_self_pay' | 'quote_expired';

/** Work for staff. The agent never prices, so a quote task always goes to a human. */
export interface QuoteTask {
  readonly kind: 'enter_quote';
  readonly practiceId: string;
  readonly caseId: string;
  readonly reason: QuoteTaskReason;
}

/** Staff refund in the practice's own processor; the agent only raises this flag. */
export interface RefundFlag {
  readonly kind: 'refund_flag';
  readonly practiceId: string;
  readonly caseId: string;
  readonly amountCents: Cents;
  readonly processor: string;
  readonly status: 'needs_staff_refund';
}

export type FlowEffect = QuoteTask | RefundFlag;

export type FlowEvent =
  | { readonly type: 'quote_entered'; readonly quote: Quote }
  | { readonly type: 'quote_sent' }
  | { readonly type: 'consent_signed'; readonly quoteId: string }
  | { readonly type: 'deposit_link_sent' }
  | { readonly type: 'deposit_paid'; readonly payment: DepositPayment }
  | { readonly type: 'check_expiry'; readonly now: Date }
  | { readonly type: 'denial_flipped_to_self_pay' }
  | { readonly type: 'case_cancelled' };

export interface FlowResult {
  readonly state: FlowState;
  readonly effects: readonly FlowEffect[];
}

export function initialFlowState(practiceId: string, caseId: string): FlowState {
  return { practiceId, caseId, status: 'quote_needed', quote: null, payments: [] };
}

export function paidCents(state: FlowState): Cents {
  return state.payments.reduce((s, p) => s + p.amountCents, 0);
}

export class FlowTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowTransitionError';
  }
}

const task = (s: FlowState, reason: QuoteTaskReason): QuoteTask => ({
  kind: 'enter_quote',
  practiceId: s.practiceId,
  caseId: s.caseId,
  reason,
});

const ok = (state: FlowState, effects: readonly FlowEffect[] = []): FlowResult => ({ state, effects });

const mustBe = (s: FlowState, event: string, ...allowed: FlowStatus[]) => {
  if (!allowed.includes(s.status)) throw new FlowTransitionError(`${event} is not allowed while ${s.status}`);
};

/** Pure transition function. Effects are returned for the caller to carry out. */
export function applyFlowEvent(s: FlowState, e: FlowEvent): FlowResult {
  switch (e.type) {
    case 'quote_entered':
      mustBe(s, e.type, 'quote_needed', 'quote_sent', 'consent_signed');
      if (e.quote.caseId !== s.caseId || e.quote.practiceId !== s.practiceId) {
        throw new FlowTransitionError('Quote belongs to a different case or practice');
      }
      // A replaced quote voids any earlier consent: the patient signed different numbers.
      return ok({ ...s, status: 'quote_needed', quote: e.quote });
    case 'quote_sent':
      mustBe(s, e.type, 'quote_needed');
      if (!s.quote) throw new FlowTransitionError('No quote has been entered');
      return ok({ ...s, status: 'quote_sent' });
    case 'consent_signed':
      mustBe(s, e.type, 'quote_sent');
      if (s.quote?.quoteId !== e.quoteId) throw new FlowTransitionError('Consent is for a different quote');
      return ok({ ...s, status: 'consent_signed' });
    case 'deposit_link_sent':
      mustBe(s, e.type, 'consent_signed', 'deposit_link_sent');
      return ok({ ...s, status: 'deposit_link_sent' });
    case 'deposit_paid': {
      mustBe(s, e.type, 'consent_signed', 'deposit_link_sent', 'deposit_confirmed');
      if (s.payments.some((p) => p.processorEventId === e.payment.processorEventId)) return ok(s);
      const next = { ...s, payments: [...s.payments, e.payment] };
      const enough = s.quote !== null && paidCents(next) >= s.quote.depositCents;
      return ok(enough ? { ...next, status: 'deposit_confirmed' } : next);
    }
    case 'check_expiry': {
      const active = s.status === 'quote_sent' || s.status === 'consent_signed' || s.status === 'deposit_link_sent';
      if (!active || !s.quote || !isQuoteExpired(s.quote, e.now)) return ok(s);
      // Reopen the quote item for staff; consent and link refer to the lapsed quote.
      return ok({ ...s, status: 'quote_needed' }, [task(s, 'quote_expired')]);
    }
    case 'denial_flipped_to_self_pay':
      if (s.status !== 'quote_needed' || s.quote !== null) return ok(s);
      return ok(s, [task(s, 'denial_flipped_to_self_pay')]);
    case 'case_cancelled': {
      if (s.status === 'cancelled') return ok(s);
      const paid = paidCents(s);
      const last = s.payments.at(-1);
      const effects: FlowEffect[] =
        paid > 0 && last
          ? [
              {
                kind: 'refund_flag',
                practiceId: s.practiceId,
                caseId: s.caseId,
                amountCents: paid,
                processor: last.processor,
                status: 'needs_staff_refund',
              },
            ]
          : [];
      return ok({ ...s, status: 'cancelled' }, effects);
    }
  }
}
