import type {
  HostedLink,
  HostedLinkRequest,
  LinkStatus,
  PaymentEvent,
  PaymentEventKind,
  PaymentProcessor,
  ProcessorCredentials,
  WebhookInput,
} from './adapter.js';
import { hmacSha256Hex, verifyHmacSha256 } from './hmac.js';
import type {
  CredentialProvider,
  PaymentLinkRecord,
  PaymentLinkStore,
  PaymentLogger,
  PaymentReminderPort,
  PracticeProcessorConfig,
  ProcessedEventStore,
  RefundRecordPort,
  SchedulerTaskPort,
} from './ports.js';

const FAKE_SIGNATURE_HEADER = 'x-fake-signature';
const EVENT_KINDS: readonly PaymentEventKind[] = ['paid', 'partially_paid', 'failed', 'expired', 'refunded'];

/**
 * In-memory processor for tests. Its webhook body is a simple JSON shape defined here for testing
 * only; it does not imitate any real vendor's wire format.
 */
export class FakePaymentProcessor implements PaymentProcessor {
  readonly links = new Map<string, { request: HostedLinkRequest; status: LinkStatus }>();
  private counter = 0;

  constructor(readonly processorId: string = 'fake') {}

  createHostedLink(_credentials: ProcessorCredentials, request: HostedLinkRequest): Promise<HostedLink> {
    const linkId = `${this.processorId}-link-${++this.counter}`;
    this.links.set(linkId, { request, status: 'open' });
    return Promise.resolve({ linkId, url: `https://pay.example.test/${linkId}`, expiresAt: request.expiresAt });
  }

  getLinkStatus(_credentials: ProcessorCredentials, linkId: string): Promise<LinkStatus> {
    const link = this.links.get(linkId);
    return link ? Promise.resolve(link.status) : Promise.reject(new Error('Unknown link'));
  }

  verifyWebhook(input: WebhookInput): boolean {
    return verifyHmacSha256(input.secret, input.rawBody, input.headers[FAKE_SIGNATURE_HEADER]);
  }

  parseWebhook(rawBody: string): PaymentEvent {
    const raw: unknown = JSON.parse(rawBody);
    if (typeof raw !== 'object' || raw === null) throw new Error('Malformed body');
    const o = raw as Record<string, unknown>;
    const kind = o['type'];
    if (
      typeof o['id'] !== 'string' ||
      typeof o['linkId'] !== 'string' ||
      typeof o['amountCents'] !== 'number' ||
      typeof o['occurredAt'] !== 'string' ||
      !EVENT_KINDS.includes(kind as PaymentEventKind)
    ) {
      throw new Error('Malformed body');
    }
    // Only the normalized fields are kept; anything else in the body is dropped here.
    return {
      eventId: o['id'],
      kind: kind as PaymentEventKind,
      linkId: o['linkId'],
      amountCents: o['amountCents'],
      occurredAt: new Date(o['occurredAt']),
    };
  }
}

/** Builds a signed fake-processor webhook for tests. */
export function signFakeWebhook(
  secret: string,
  body: Record<string, unknown>,
): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify(body);
  return { rawBody, headers: { [FAKE_SIGNATURE_HEADER]: hmacSha256Hex(secret, rawBody) } };
}

export class InMemoryCredentialProvider implements CredentialProvider {
  constructor(private readonly byPractice: Record<string, ProcessorCredentials>) {}
  getCredentials(practiceId: string): Promise<ProcessorCredentials> {
    const c = this.byPractice[practiceId];
    return c ? Promise.resolve(c) : Promise.reject(new Error('No credentials for practice'));
  }
}

export class InMemoryPracticeProcessorConfig implements PracticeProcessorConfig {
  constructor(private readonly byPractice: Record<string, string>) {}
  getProcessorId(practiceId: string): Promise<string | null> {
    return Promise.resolve(this.byPractice[practiceId] ?? null);
  }
}

export class InMemoryPaymentLinkStore implements PaymentLinkStore {
  private readonly rows = new Map<string, PaymentLinkRecord>();
  save(record: PaymentLinkRecord): Promise<void> {
    this.rows.set(`${record.practiceId}/${record.linkId}`, record);
    return Promise.resolve();
  }
  get(practiceId: string, linkId: string): Promise<PaymentLinkRecord | null> {
    return Promise.resolve(this.rows.get(`${practiceId}/${linkId}`) ?? null);
  }
}

export class InMemoryProcessedEventStore implements ProcessedEventStore {
  private readonly seen = new Set<string>();
  claim(practiceId: string, processorId: string, eventId: string): Promise<boolean> {
    const key = `${practiceId}/${processorId}/${eventId}`;
    if (this.seen.has(key)) return Promise.resolve(false);
    this.seen.add(key);
    return Promise.resolve(true);
  }
  release(practiceId: string, processorId: string, eventId: string): Promise<void> {
    this.seen.delete(`${practiceId}/${processorId}/${eventId}`);
    return Promise.resolve();
  }
}

export class FakePaymentSideEffects implements PaymentReminderPort, SchedulerTaskPort, RefundRecordPort, PaymentLogger {
  readonly reminders: string[] = [];
  readonly tasks: string[] = [];
  readonly refunds: { caseId: string; amountCents: number; processorEventId: string }[] = [];
  readonly logs: string[] = [];

  sendPaymentReminder(args: { caseId: string; reason: string }): Promise<void> {
    this.reminders.push(`${args.caseId}:${args.reason}`);
    return Promise.resolve();
  }
  createPaymentFollowUpTask(args: { caseId: string; reason: string }): Promise<void> {
    this.tasks.push(`${args.caseId}:${args.reason}`);
    return Promise.resolve();
  }
  recordProcessorRefund(args: { caseId: string; amountCents: number; processorEventId: string }): Promise<void> {
    this.refunds.push({ caseId: args.caseId, amountCents: args.amountCents, processorEventId: args.processorEventId });
    return Promise.resolve();
  }
  info(event: string, fields: Readonly<Record<string, string | number>>): void {
    this.logs.push(`${event} ${JSON.stringify(fields)}`);
  }
}
