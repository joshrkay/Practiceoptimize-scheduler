import type { Channel } from './model';

export type DeliveryStatus = 'queued' | 'delivered' | 'failed';

export interface OutboundMessage {
  /** Address as held in the verified directory. */
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly referenceCode: string;
}

export interface ProviderResult {
  readonly providerMessageId: string;
  readonly status: DeliveryStatus;
}

export interface EmailProvider {
  send(message: OutboundMessage): Promise<ProviderResult>;
}

/** Implemented by the EHR connector (built elsewhere); wired at integration. */
export interface InBasketProvider {
  send(message: OutboundMessage): Promise<ProviderResult>;
}

export interface SendAuditEvent {
  readonly practiceId: string;
  readonly partyId: string;
  readonly requestType: string;
  readonly channel: Channel;
  /** Hash of the address; the address itself is never audited. */
  readonly addressHash: string | null;
  readonly outcome: 'sent' | 'needs_verification' | 'failed';
  readonly deliveryStatus: DeliveryStatus | null;
  readonly referenceCode: string;
  readonly at: string;
  /** Names of the PHI fields sent, never values. */
  readonly fieldsSent: readonly string[];
}

export interface AuditSink {
  record(event: SendAuditEvent): Promise<void>;
}

export interface SchedulerTask {
  readonly practiceId: string;
  readonly kind: 'verify_contact';
  readonly partyId: string;
  readonly channel: Channel;
  readonly reason: string;
  readonly referenceCode: string;
}

export interface SchedulerTaskPort {
  createTask(task: SchedulerTask): Promise<{ taskId: string }>;
}
