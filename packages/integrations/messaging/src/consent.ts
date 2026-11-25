import type { Channel, MessageType, PracticeId, Recipient } from './types.js';
import { recipientKey } from './types.js';

export type ConsentSource =
  | 'intake_form'
  | 'portal'
  | 'verbal_recorded'
  | 'text_keyword'
  | 'in_person_signed'
  | 'authorized_contact_form';

export interface ConsentRecord {
  practiceId: PracticeId;
  recipient: Recipient;
  channel: Channel;
  source: ConsentSource;
  grantedAt: Date;
  /** Contacts are limited to these types. Omitted means all types (patients). */
  messageTypes?: readonly MessageType[];
}

export interface OptOutRecord {
  practiceId: PracticeId;
  recipient: Recipient;
  at: Date;
  /** Channel the opt-out was received on. */
  receivedOn: Channel;
  keyword: string;
}

export interface ConsentStore {
  addConsent(record: ConsentRecord): Promise<void>;
  listConsents(practiceId: PracticeId, recipient: Recipient): Promise<ConsentRecord[]>;
  addOptOut(record: OptOutRecord): Promise<void>;
  latestOptOut(practiceId: PracticeId, recipient: Recipient): Promise<OptOutRecord | null>;
}

export class InMemoryConsentStore implements ConsentStore {
  private readonly consents = new Map<string, ConsentRecord[]>();
  private readonly optOuts = new Map<string, OptOutRecord[]>();

  private key(practiceId: PracticeId, recipient: Recipient): string {
    return `${practiceId}|${recipientKey(recipient)}`;
  }

  addConsent(record: ConsentRecord): Promise<void> {
    const k = this.key(record.practiceId, record.recipient);
    this.consents.set(k, [...(this.consents.get(k) ?? []), record]);
    return Promise.resolve();
  }

  listConsents(practiceId: PracticeId, recipient: Recipient): Promise<ConsentRecord[]> {
    return Promise.resolve([...(this.consents.get(this.key(practiceId, recipient)) ?? [])]);
  }

  addOptOut(record: OptOutRecord): Promise<void> {
    const k = this.key(record.practiceId, record.recipient);
    this.optOuts.set(k, [...(this.optOuts.get(k) ?? []), record]);
    return Promise.resolve();
  }

  latestOptOut(practiceId: PracticeId, recipient: Recipient): Promise<OptOutRecord | null> {
    const list = this.optOuts.get(this.key(practiceId, recipient)) ?? [];
    return Promise.resolve(
      list.reduce<OptOutRecord | null>((a, b) => (!a || b.at > a.at ? b : a), null),
    );
  }
}

export const AUTOMATED_CHANNELS: readonly Channel[] = ['sms', 'email', 'portal', 'voice'];

/**
 * POLICY (decision to confirm): STOP received on any channel opts the recipient out of ALL
 * automated channels. This is the stricter reading, matching the PRD's "honor opt-outs across all
 * channels". The alternative reading (STOP opts out of SMS only) would return ['sms'].
 * This is the single place that decides STOP scope.
 */
export function channelsOptedOutByStop(_receivedOn: Channel): readonly Channel[] {
  return AUTOMATED_CHANNELS;
}

export type ConsentDecision =
  | { allowed: true; consent: ConsentRecord }
  | { allowed: false; reason: 'no_consent' | 'opted_out' | 'message_type_not_consented' };

/**
 * A send needs a consent record for the channel, granted before now, covering the message type,
 * and granted after any opt-out that covers the channel (a re-opt-in is a new consent record).
 */
export function evaluateConsent(
  records: readonly ConsentRecord[],
  optOut: OptOutRecord | null,
  channel: Channel,
  messageType: MessageType,
  now: Date,
): ConsentDecision {
  const forChannel = records.filter((r) => r.channel === channel && r.grantedAt <= now);
  if (forChannel.length === 0) return { allowed: false, reason: 'no_consent' };
  const optOutApplies = optOut !== null && channelsOptedOutByStop(optOut.receivedOn).includes(channel);
  const live = optOutApplies ? forChannel.filter((r) => r.grantedAt > optOut.at) : forChannel;
  if (live.length === 0) return { allowed: false, reason: 'opted_out' };
  const match = live.find((r) => !r.messageTypes || r.messageTypes.includes(messageType));
  if (!match) return { allowed: false, reason: 'message_type_not_consented' };
  return { allowed: true, consent: match };
}

const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_KEYWORDS = new Set(['START', 'UNSTOP']);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

export type InboundKeyword = 'stop' | 'start' | 'help' | 'none';

export function classifyInboundKeyword(text: string): InboundKeyword {
  const word = text.trim().toUpperCase().replace(/[.!]+$/, '');
  if (STOP_KEYWORDS.has(word)) return 'stop';
  if (START_KEYWORDS.has(word)) return 'start';
  if (HELP_KEYWORDS.has(word)) return 'help';
  return 'none';
}

export interface InboundResult {
  keyword: InboundKeyword;
  /** Auto-reply the caller may send. Opt-out confirmations are always allowed. */
  reply?: string;
}

/**
 * Handles an inbound text (any channel). STOP is recorded synchronously so the next send check
 * sees it. START re-grants consent only for the channel it was received on, using the message
 * types of the most recent consent on that channel.
 */
export async function handleInboundText(
  store: ConsentStore,
  input: {
    practiceId: PracticeId;
    recipient: Recipient;
    channel: Channel;
    text: string;
    at: Date;
    practiceName: string;
  },
): Promise<InboundResult> {
  const keyword = classifyInboundKeyword(input.text);
  if (keyword === 'stop') {
    await store.addOptOut({
      practiceId: input.practiceId,
      recipient: input.recipient,
      at: input.at,
      receivedOn: input.channel,
      keyword: input.text.trim().toUpperCase(),
    });
    return {
      keyword,
      reply: `${input.practiceName} automated assistant: you are opted out and will receive no more automated messages. Reply START to opt back in.`,
    };
  }
  if (keyword === 'start') {
    const previous = (await store.listConsents(input.practiceId, input.recipient)).filter(
      (r) => r.channel === input.channel,
    );
    const last = previous[previous.length - 1];
    await store.addConsent({
      practiceId: input.practiceId,
      recipient: input.recipient,
      channel: input.channel,
      source: 'text_keyword',
      grantedAt: new Date(input.at.getTime() + 1),
      ...(last?.messageTypes ? { messageTypes: last.messageTypes } : {}),
    });
    return { keyword, reply: `${input.practiceName} automated assistant: you are opted back in.` };
  }
  if (keyword === 'help') {
    return {
      keyword,
      reply: `${input.practiceName} automated assistant. Reply STOP to opt out. Call the office for help.`,
    };
  }
  return { keyword };
}
