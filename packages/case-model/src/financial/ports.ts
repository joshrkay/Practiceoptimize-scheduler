import type { FlowState, QuoteTask, RefundFlag } from './flow.js';
import type { Quote } from './quote.js';
import type { Cents } from './types.js';

/** E-signature (RAH-54). Requests the financial consent for a quote. */
export interface FinancialConsentPort {
  requestFinancialConsent(args: { practiceId: string; caseId: string; quote: Quote }): Promise<void>;
}

/** Secure patient case page (RAH-30). */
export interface PatientPagePort {
  publishQuote(args: { practiceId: string; caseId: string; quote: Quote }): Promise<void>;
  publishDepositLink(args: { practiceId: string; caseId: string; url: string }): Promise<void>;
}

/** Patient messaging. Message bodies carry no card data and no clinical detail. */
export interface PatientMessagePort {
  notify(args: { practiceId: string; caseId: string; template: 'quote_ready' | 'deposit_link' }): Promise<void>;
}

/** Hosted deposit link from the practice's processor (RAH-91). The amount is always the human-entered deposit. */
export interface DepositLinkPort {
  createDepositLink(args: {
    practiceId: string;
    caseId: string;
    quoteId: string;
    amountCents: Cents;
  }): Promise<{ url: string }>;
}

/** Staff work queue. There is deliberately no refund method anywhere in these ports. */
export interface StaffWorkPort {
  createQuoteTask(task: QuoteTask): Promise<void>;
  createRefundFlag(flag: RefundFlag): Promise<void>;
}

export interface FlowStore {
  get(practiceId: string, caseId: string): Promise<FlowState | null>;
  save(state: FlowState): Promise<void>;
}

/** Implemented here by SelfPayFlowService; RAH-91 calls it when a processor confirms a deposit. */
export interface DepositConfirmationPort {
  recordDepositPayment(args: {
    practiceId: string;
    caseId: string;
    processor: string;
    processorEventId: string;
    amountCents: Cents;
  }): Promise<{ depositConfirmed: boolean }>;
}
