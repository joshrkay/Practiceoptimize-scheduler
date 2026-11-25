import type { LinkPurpose, LinkStatus, PaymentProcessor, ProcessorCredentials } from './adapter.js';

/** RAH-11: per-practice credentials from the practice's vault path. */
export interface CredentialProvider {
  getCredentials(practiceId: string, processorId: string): Promise<ProcessorCredentials>;
}

/** Per-practice processor selection made at onboarding. */
export interface PracticeProcessorConfig {
  getProcessorId(practiceId: string): Promise<string | null>;
}

export interface PaymentLinkRecord {
  readonly practiceId: string;
  readonly caseId: string;
  readonly processorId: string;
  readonly linkId: string;
  readonly purpose: LinkPurpose;
  readonly amountCents: number;
  readonly status: LinkStatus;
  readonly expiresAt: Date;
  /** How many reminders have gone out for this link; the first failure reminds, the next escalates. */
  readonly remindersSent: number;
  readonly refundedCents: number;
}

export interface PaymentLinkStore {
  save(record: PaymentLinkRecord): Promise<void>;
  get(practiceId: string, linkId: string): Promise<PaymentLinkRecord | null>;
}

/** Idempotency by processor event ID, scoped by practice. `claim` returns false if already seen. */
export interface ProcessedEventStore {
  claim(practiceId: string, processorId: string, eventId: string): Promise<boolean>;
  /** Un-claims an event whose handling failed, so the processor's retry is processed. */
  release(practiceId: string, processorId: string, eventId: string): Promise<void>;
}

/** Patient reminder (messages and patient case page). Carries no card data. */
export interface PaymentReminderPort {
  sendPaymentReminder(args: {
    practiceId: string;
    caseId: string;
    linkId: string;
    reason: 'failed' | 'expired';
  }): Promise<void>;
}

/** Scheduler task for a human after a reminder did not resolve the payment. */
export interface SchedulerTaskPort {
  createPaymentFollowUpTask(args: {
    practiceId: string;
    caseId: string;
    linkId: string;
    reason: 'failed' | 'expired';
  }): Promise<void>;
}

/** Records a processor-reported refund on the case. Recording only; no money moves. */
export interface RefundRecordPort {
  recordProcessorRefund(args: {
    practiceId: string;
    caseId: string;
    processorId: string;
    processorEventId: string;
    amountCents: number;
  }): Promise<void>;
}

/** Log sink. Only ids and outcome codes are ever passed; never payloads, secrets or card data. */
export interface PaymentLogger {
  info(event: string, fields: Readonly<Record<string, string | number>>): void;
}

export type ProcessorRegistry = ReadonlyMap<string, PaymentProcessor>;
