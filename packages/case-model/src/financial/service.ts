import { applyFlowEvent, initialFlowState, type FlowEffect, type FlowEvent, type FlowState } from './flow.js';
import type {
  DepositConfirmationPort,
  DepositLinkPort,
  FinancialConsentPort,
  FlowStore,
  PatientMessagePort,
  PatientPagePort,
  StaffWorkPort,
} from './ports.js';
import type { Quote } from './quote.js';

export interface SelfPayFlowDeps {
  readonly store: FlowStore;
  readonly consent: FinancialConsentPort;
  readonly patientPage: PatientPagePort;
  readonly messages: PatientMessagePort;
  readonly depositLinks: DepositLinkPort;
  readonly staffWork: StaffWorkPort;
  readonly now: () => Date;
}

/**
 * Orchestrates the self-pay flow. It sends what a human priced and never prices: there is no
 * method here that accepts a total or deposit amount, and no method that moves money.
 */
export class SelfPayFlowService implements DepositConfirmationPort {
  constructor(private readonly deps: SelfPayFlowDeps) {}

  async getState(practiceId: string, caseId: string): Promise<FlowState> {
    return (await this.deps.store.get(practiceId, caseId)) ?? initialFlowState(practiceId, caseId);
  }

  private async run(practiceId: string, caseId: string, event: FlowEvent): Promise<FlowState> {
    const { state, effects } = applyFlowEvent(await this.getState(practiceId, caseId), event);
    await this.deps.store.save(state);
    await this.dispatch(effects);
    return state;
  }

  private async dispatch(effects: readonly FlowEffect[]): Promise<void> {
    for (const e of effects) {
      if (e.kind === 'enter_quote') await this.deps.staffWork.createQuoteTask(e);
      else await this.deps.staffWork.createRefundFlag(e);
    }
  }

  /** Staff or the surgeon enter a quote (built with createQuote); the agent then sends it. */
  recordQuote(quote: Quote): Promise<FlowState> {
    return this.run(quote.practiceId, quote.caseId, { type: 'quote_entered', quote });
  }

  async sendQuote(practiceId: string, caseId: string): Promise<FlowState> {
    const state = await this.run(practiceId, caseId, { type: 'quote_sent' });
    const quote = state.quote;
    if (quote) {
      await this.deps.patientPage.publishQuote({ practiceId, caseId, quote });
      await this.deps.consent.requestFinancialConsent({ practiceId, caseId, quote });
      await this.deps.messages.notify({ practiceId, caseId, template: 'quote_ready' });
    }
    return state;
  }

  /** Called when the e-signature port reports the financial consent signed; then the deposit link goes out. */
  async onConsentSigned(practiceId: string, caseId: string, quoteId: string): Promise<FlowState> {
    await this.run(practiceId, caseId, { type: 'consent_signed', quoteId });
    return this.sendDepositLink(practiceId, caseId);
  }

  async sendDepositLink(practiceId: string, caseId: string): Promise<FlowState> {
    const current = await this.getState(practiceId, caseId);
    if (!current.quote) return current;
    const { url } = await this.deps.depositLinks.createDepositLink({
      practiceId,
      caseId,
      quoteId: current.quote.quoteId,
      amountCents: current.quote.depositCents,
    });
    const state = await this.run(practiceId, caseId, { type: 'deposit_link_sent' });
    await this.deps.patientPage.publishDepositLink({ practiceId, caseId, url });
    await this.deps.messages.notify({ practiceId, caseId, template: 'deposit_link' });
    return state;
  }

  async recordDepositPayment(args: {
    practiceId: string;
    caseId: string;
    processor: string;
    processorEventId: string;
    amountCents: number;
  }): Promise<{ depositConfirmed: boolean }> {
    const state = await this.run(args.practiceId, args.caseId, {
      type: 'deposit_paid',
      payment: {
        processor: args.processor,
        processorEventId: args.processorEventId,
        amountCents: args.amountCents,
      },
    });
    return { depositConfirmed: state.status === 'deposit_confirmed' };
  }

  /** Periodic sweep: reopens the quote item for staff when a quote has expired unpaid. */
  checkExpiry(practiceId: string, caseId: string): Promise<FlowState> {
    return this.run(practiceId, caseId, { type: 'check_expiry', now: this.deps.now() });
  }

  /** A denial flipped the case to self-pay: staff get a quote task. */
  onDenialFlippedToSelfPay(practiceId: string, caseId: string): Promise<FlowState> {
    return this.run(practiceId, caseId, { type: 'denial_flipped_to_self_pay' });
  }

  /** A cancelled case with a paid deposit raises a refund flag; staff refund in their own processor. */
  onCaseCancelled(practiceId: string, caseId: string): Promise<FlowState> {
    return this.run(practiceId, caseId, { type: 'case_cancelled' });
  }
}
