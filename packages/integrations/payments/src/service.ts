import type { DepositConfirmationPort, DepositLinkPort } from '@scheduler/case-model';
import type {
  HostedLink,
  LinkPurpose,
  PaymentEvent,
  PaymentProcessor,
  ProcessorCredentials,
} from './adapter.js';
import { containsCardData } from './card-data-guard.js';
import type {
  CredentialProvider,
  PaymentLinkRecord,
  PaymentLinkStore,
  PaymentLogger,
  PaymentReminderPort,
  PracticeProcessorConfig,
  ProcessedEventStore,
  ProcessorRegistry,
  RefundRecordPort,
  SchedulerTaskPort,
} from './ports.js';

export type WebhookRejection = 'no_processor' | 'card_data' | 'bad_signature' | 'malformed' | 'wrong_processor';

export class WebhookRejectedError extends Error {
  constructor(readonly code: WebhookRejection) {
    super(`Payment webhook rejected: ${code}`);
    this.name = 'WebhookRejectedError';
  }
}

export class PaymentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigError';
  }
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'unknown_link';

export interface PaymentServiceDeps {
  readonly processors: ProcessorRegistry;
  readonly practiceConfig: PracticeProcessorConfig;
  readonly credentials: CredentialProvider;
  readonly links: PaymentLinkStore;
  readonly events: ProcessedEventStore;
  readonly deposits: DepositConfirmationPort;
  readonly reminders: PaymentReminderPort;
  readonly tasks: SchedulerTaskPort;
  readonly refunds: RefundRecordPort;
  readonly logger: PaymentLogger;
  readonly newReference: () => string;
  readonly now: () => Date;
  readonly linkTtlMs: number;
}

/**
 * Generic payment service around a PaymentProcessor adapter. It creates links for amounts a human
 * entered, records what the processor reports, and never initiates a refund or touches card data.
 */
export class PaymentService implements DepositLinkPort {
  constructor(private readonly deps: PaymentServiceDeps) {}

  private async resolve(
    practiceId: string,
  ): Promise<{ processor: PaymentProcessor; credentials: ProcessorCredentials }> {
    const processorId = await this.deps.practiceConfig.getProcessorId(practiceId);
    if (processorId === null) throw new PaymentConfigError('Practice has no payment processor selected');
    const processor = this.deps.processors.get(processorId);
    if (!processor) throw new PaymentConfigError(`No adapter registered for processor ${processorId}`);
    return { processor, credentials: await this.deps.credentials.getCredentials(practiceId, processorId) };
  }

  /** Implements the RAH-90 DepositLinkPort: a deposit link for the human-entered deposit amount. */
  async createDepositLink(args: {
    practiceId: string;
    caseId: string;
    quoteId: string;
    amountCents: number;
  }): Promise<{ url: string }> {
    const link = await this.createLink(args.practiceId, args.caseId, 'deposit', args.amountCents);
    return { url: link.url };
  }

  /** Link for the staff-estimated patient balance on an insured case. */
  createBalanceLink(practiceId: string, caseId: string, amountCents: number): Promise<HostedLink> {
    return this.createLink(practiceId, caseId, 'balance', amountCents);
  }

  private async createLink(
    practiceId: string,
    caseId: string,
    purpose: LinkPurpose,
    amountCents: number,
  ): Promise<HostedLink> {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new PaymentConfigError('Payment amount must be a positive whole number of cents');
    }
    const { processor, credentials } = await this.resolve(practiceId);
    const expiresAt = new Date(this.deps.now().getTime() + this.deps.linkTtlMs);
    const link = await processor.createHostedLink(credentials, {
      practiceId,
      caseId,
      purpose,
      amountCents,
      expiresAt,
      reference: this.deps.newReference(),
    });
    await this.deps.links.save({
      practiceId,
      caseId,
      processorId: processor.processorId,
      linkId: link.linkId,
      purpose,
      amountCents,
      status: 'open',
      expiresAt: link.expiresAt,
      remindersSent: 0,
      refundedCents: 0,
    });
    this.deps.logger.info('payment_link_created', { practiceId, caseId, purpose });
    return link;
  }

  /**
   * Entry point for a practice's signed webhook. Order matters: refuse card data, verify the
   * practice's signature, only then parse, then dedupe by processor event ID.
   */
  async handleWebhook(args: {
    practiceId: string;
    headers: Readonly<Record<string, string | undefined>>;
    rawBody: string;
  }): Promise<WebhookOutcome> {
    const { practiceId, rawBody } = args;
    const processorId = await this.deps.practiceConfig.getProcessorId(practiceId);
    const processor = processorId === null ? undefined : this.deps.processors.get(processorId);
    if (!processor) throw this.reject(practiceId, 'no_processor');
    if (containsCardData(rawBody)) throw this.reject(practiceId, 'card_data');
    const { webhookSecret } = await this.deps.credentials.getCredentials(practiceId, processor.processorId);
    if (!processor.verifyWebhook({ secret: webhookSecret, headers: args.headers, rawBody })) {
      throw this.reject(practiceId, 'bad_signature');
    }
    let event: PaymentEvent;
    try {
      event = processor.parseWebhook(rawBody);
    } catch {
      throw this.reject(practiceId, 'malformed');
    }

    const link = await this.deps.links.get(practiceId, event.linkId);
    if (!link) return 'unknown_link';
    if (link.processorId !== processor.processorId) throw this.reject(practiceId, 'wrong_processor');
    if (!(await this.deps.events.claim(practiceId, processor.processorId, event.eventId))) return 'duplicate';
    try {
      await this.apply(link, event);
    } catch (error) {
      await this.deps.events.release(practiceId, processor.processorId, event.eventId);
      throw error;
    }
    this.deps.logger.info('payment_event_processed', { practiceId, kind: event.kind });
    return 'processed';
  }

  private reject(practiceId: string, code: WebhookRejection): WebhookRejectedError {
    this.deps.logger.info('payment_webhook_rejected', { practiceId, code });
    return new WebhookRejectedError(code);
  }

  private async apply(link: PaymentLinkRecord, event: PaymentEvent): Promise<void> {
    const { practiceId, caseId } = link;
    switch (event.kind) {
      case 'paid':
      case 'partially_paid': {
        await this.deps.links.save({ ...link, status: event.kind === 'paid' ? 'paid' : 'partially_paid' });
        if (link.purpose === 'deposit') {
          // A confirmed deposit satisfies the RAH-90 gate or readiness item through this port.
          await this.deps.deposits.recordDepositPayment({
            practiceId,
            caseId,
            processor: link.processorId,
            processorEventId: event.eventId,
            amountCents: event.amountCents,
          });
        }
        return;
      }
      case 'failed':
      case 'expired': {
        // A late failure or expiry on a link that was already paid changes nothing.
        if (link.status === 'paid') return;
        const reason = event.kind;
        if (link.remindersSent === 0) {
          await this.deps.links.save({ ...link, status: reason, remindersSent: 1 });
          await this.deps.reminders.sendPaymentReminder({ practiceId, caseId, linkId: link.linkId, reason });
        } else {
          await this.deps.links.save({ ...link, status: reason });
          await this.deps.tasks.createPaymentFollowUpTask({ practiceId, caseId, linkId: link.linkId, reason });
        }
        return;
      }
      case 'refunded': {
        await this.deps.links.save({ ...link, refundedCents: link.refundedCents + event.amountCents });
        await this.deps.refunds.recordProcessorRefund({
          practiceId,
          caseId,
          processorId: link.processorId,
          processorEventId: event.eventId,
          amountCents: event.amountCents,
        });
        return;
      }
    }
  }
}
