import { randomUUID } from 'node:crypto';
import {
  composeEmail,
  composePortal,
  composeSms,
  composeVoice,
  hasAutomatedDisclosure,
  type ComposedMessage,
} from './channels.js';
import {
  evaluateConsent,
  handleInboundText,
  type ConsentStore,
  type InboundResult,
} from './consent.js';
import { findClinicalTerms, type ContentViolation } from './content-guard.js';
import type { LocationDirectory, MessagingProvider } from './ports.js';
import {
  DEFAULT_QUIET_HOURS,
  isQuietHours,
  nextWindowOpen,
  type QuietHoursWindow,
} from './quiet-hours.js';
import { canSendSms, type TenDlcRegistry } from './ten-dlc.js';
import type {
  Channel,
  Clock,
  MessageType,
  PracticeId,
  Recipient,
  RecipientAddresses,
  SenderIdentity,
} from './types.js';
import { recipientKey, systemClock } from './types.js';

export interface MessageRequest {
  practiceId: PracticeId;
  caseId: string;
  /** Sender identity comes from this location. */
  locationId: string;
  recipient: Recipient;
  addresses: RecipientAddresses;
  /** The patient's time zone (IANA), also used for authorized contacts. */
  patientTimeZone: string;
  messageType: MessageType;
  subject: string;
  /** Neutral text used for SMS and voice. No diagnosis or procedure names. */
  body: string;
  /** Richer text for email and portal. Defaults to `body`. */
  detailBody?: string;
  /** The case's own diagnosis and procedure names, rejected in SMS and voice text. */
  caseClinicalTerms?: readonly string[];
  /** Patient prefers calls or does not reply to texts: voice goes first. */
  preferVoice?: boolean;
}

export type MessageState =
  | 'held'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'blocked'
  | 'rejected'
  | 'disabled';

export type SkipReason =
  | 'no_address'
  | 'no_sender_identity'
  | 'no_consent'
  | 'opted_out'
  | 'message_type_not_consented'
  | 'sms_not_registered';

export interface DeliveryAttempt {
  channel: Channel;
  status: 'sent' | 'delivered' | 'failed';
  providerMessageId: string;
  at: Date;
  errorCode?: string;
}

export interface MessageRecord {
  id: string;
  request: MessageRequest;
  state: MessageState;
  createdAt: Date;
  releaseAt?: Date;
  attempts: DeliveryAttempt[];
  skipped: { channel: Channel; reason: SkipReason }[];
  blockedReason?: SkipReason | 'unknown_location' | 'opted_out';
  violations?: ContentViolation[];
}

export interface MessageStore {
  save(record: MessageRecord): Promise<void>;
  get(id: string): Promise<MessageRecord | null>;
  findByProviderMessageId(providerMessageId: string): Promise<MessageRecord | null>;
  listHeld(): Promise<MessageRecord[]>;
}

export class InMemoryMessageStore implements MessageStore {
  private readonly records = new Map<string, MessageRecord>();

  save(record: MessageRecord): Promise<void> {
    this.records.set(record.id, record);
    return Promise.resolve();
  }

  get(id: string): Promise<MessageRecord | null> {
    return Promise.resolve(this.records.get(id) ?? null);
  }

  findByProviderMessageId(providerMessageId: string): Promise<MessageRecord | null> {
    for (const r of this.records.values()) {
      if (r.attempts.some((a) => a.providerMessageId === providerMessageId)) {
        return Promise.resolve(r);
      }
    }
    return Promise.resolve(null);
  }

  listHeld(): Promise<MessageRecord[]> {
    return Promise.resolve([...this.records.values()].filter((r) => r.state === 'held'));
  }
}

/** Channel order: SMS, then email, then portal. Voice goes first only on request. */
export function channelOrder(preferVoice: boolean | undefined): readonly Channel[] {
  return preferVoice ? ['voice', 'sms', 'email', 'portal'] : ['sms', 'email', 'portal'];
}

export interface MessengerDeps {
  provider: MessagingProvider;
  locations: LocationDirectory;
  consent: ConsentStore;
  store: MessageStore;
  tenDlc: TenDlcRegistry;
  clock?: Clock;
  quietHours?: QuietHoursWindow;
  /** `FEATURE_PATIENT_OUTREACH`. Defaults to disabled. */
  enabled?: boolean;
}

export class PatientMessenger {
  private readonly clock: Clock;
  private readonly quietHours: QuietHoursWindow;

  constructor(private readonly deps: MessengerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.quietHours = deps.quietHours ?? DEFAULT_QUIET_HOURS;
  }

  async send(request: MessageRequest): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: randomUUID(),
      request,
      state: 'held',
      createdAt: this.clock.now(),
      attempts: [],
      skipped: [],
    };
    if (!this.deps.enabled) return this.finish(record, 'disabled');

    // SMS and voice text is the strictest surface, and is also the fallback text, so check it first.
    const violations = findClinicalTerms(request.body, request.caseClinicalTerms);
    if (violations.length > 0) {
      record.violations = violations;
      return this.finish(record, 'rejected');
    }
    return this.proceed(record);
  }

  /** Sends held messages whose quiet hours have ended. Run periodically. */
  async releaseDue(): Promise<MessageRecord[]> {
    const now = this.clock.now();
    const released: MessageRecord[] = [];
    for (const record of await this.deps.store.listHeld()) {
      if (record.releaseAt && record.releaseAt <= now) {
        released.push(await this.proceed(record));
      }
    }
    return released;
  }

  /** Records a provider delivery receipt; a failure falls back to the next channel. */
  async recordDeliveryReceipt(
    providerMessageId: string,
    status: 'delivered' | 'failed',
    errorCode?: string,
  ): Promise<MessageRecord | null> {
    const record = await this.deps.store.findByProviderMessageId(providerMessageId);
    const attempt = record?.attempts.find((a) => a.providerMessageId === providerMessageId);
    if (!record || !attempt) return null;
    attempt.status = status;
    if (errorCode) attempt.errorCode = errorCode;
    if (status === 'delivered') return this.finish(record, 'delivered');
    return this.proceed(record);
  }

  /**
   * Inbound text on any channel. STOP is recorded before returning, so the very next send check
   * (including release of held messages) honors it; held messages are cancelled immediately.
   */
  async handleInbound(input: {
    practiceId: PracticeId;
    recipient: Recipient;
    channel: Channel;
    text: string;
    practiceName: string;
  }): Promise<InboundResult> {
    const at = this.clock.now();
    const result = await handleInboundText(this.deps.consent, { ...input, at });
    if (result.keyword === 'stop') {
      for (const held of await this.deps.store.listHeld()) {
        if (
          held.request.practiceId === input.practiceId &&
          recipientKey(held.request.recipient) === recipientKey(input.recipient)
        ) {
          held.blockedReason = 'opted_out';
          await this.finish(held, 'blocked');
        }
      }
    }
    return result;
  }

  private async finish(record: MessageRecord, state: MessageState): Promise<MessageRecord> {
    record.state = state;
    if (state !== 'held') delete record.releaseAt;
    await this.deps.store.save(record);
    return record;
  }

  private async proceed(record: MessageRecord): Promise<MessageRecord> {
    const now = this.clock.now();
    const { patientTimeZone } = record.request;
    if (isQuietHours(now, patientTimeZone, this.quietHours)) {
      record.releaseAt = nextWindowOpen(now, patientTimeZone, this.quietHours);
      return this.finish(record, 'held');
    }
    return this.dispatch(record);
  }

  private async dispatch(record: MessageRecord): Promise<MessageRecord> {
    const { request } = record;
    const identity = await this.deps.locations.getSenderIdentity(
      request.practiceId,
      request.locationId,
    );
    if (!identity) {
      record.blockedReason = 'unknown_location';
      return this.finish(record, 'blocked');
    }
    const tried = new Set(record.attempts.map((a) => a.channel));
    record.skipped = [];
    for (const channel of channelOrder(request.preferVoice)) {
      if (tried.has(channel)) continue;
      const reason = await this.ineligibleReason(request, identity, channel);
      if (reason) {
        record.skipped.push({ channel, reason });
        continue;
      }
      const composed = this.compose(request, identity, channel);
      if (!hasAutomatedDisclosure(composed.body)) {
        throw new Error(`Refusing to send ${channel} message without automated-assistant notice`);
      }
      const result = await this.deps.provider.send({
        practiceId: request.practiceId,
        channel,
        to: this.address(request, channel),
        from: composed.from,
        ...(composed.subject ? { subject: composed.subject } : {}),
        body: composed.body,
        idempotencyKey: `${record.id}:${channel}`,
      });
      const attempt: DeliveryAttempt = {
        channel,
        status: result.status === 'accepted' ? 'sent' : 'failed',
        providerMessageId: result.providerMessageId,
        at: this.clock.now(),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      };
      record.attempts.push(attempt);
      if (attempt.status === 'sent') return this.finish(record, 'sent');
    }
    if (record.attempts.length === 0) {
      record.blockedReason = record.skipped[0]?.reason ?? 'no_consent';
      return this.finish(record, 'blocked');
    }
    return this.finish(record, 'failed');
  }

  private async ineligibleReason(
    request: MessageRequest,
    identity: SenderIdentity,
    channel: Channel,
  ): Promise<SkipReason | null> {
    if (!this.address(request, channel, true)) return 'no_address';
    if (!this.senderFor(identity, channel)) return 'no_sender_identity';
    const [records, optOut] = await Promise.all([
      this.deps.consent.listConsents(request.practiceId, request.recipient),
      this.deps.consent.latestOptOut(request.practiceId, request.recipient),
    ]);
    const decision = evaluateConsent(
      records,
      optOut,
      channel,
      request.messageType,
      this.clock.now(),
    );
    if (!decision.allowed) return decision.reason;
    if (channel === 'sms' && !canSendSms(await this.deps.tenDlc.get(request.practiceId))) {
      return 'sms_not_registered';
    }
    return null;
  }

  private address(request: MessageRequest, channel: Channel, soft = false): string {
    const a = request.addresses;
    const value =
      channel === 'sms' || channel === 'voice'
        ? a.phone
        : channel === 'email'
          ? a.email
          : a.portalUserId;
    if (!value && !soft) throw new Error(`No ${channel} address`);
    return value ?? '';
  }

  private senderFor(identity: SenderIdentity, channel: Channel): string | undefined {
    switch (channel) {
      case 'sms':
        return identity.smsNumber;
      case 'voice':
        return identity.voiceNumber;
      case 'email':
        return identity.email;
      case 'portal':
        return identity.displayName;
    }
  }

  private compose(
    request: MessageRequest,
    identity: SenderIdentity,
    channel: Channel,
  ): ComposedMessage {
    const detail = request.detailBody ?? request.body;
    switch (channel) {
      case 'sms':
        return composeSms(identity, request.body);
      case 'voice':
        return composeVoice(identity, request.body);
      case 'email':
        return composeEmail(identity, request.subject, detail);
      case 'portal':
        return composePortal(identity, request.subject, detail);
    }
  }
}
