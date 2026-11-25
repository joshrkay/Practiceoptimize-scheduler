import type { Channel, PracticeId, SenderIdentity } from './types.js';

export interface ProviderMessage {
  practiceId: PracticeId;
  channel: Channel;
  to: string;
  from: string;
  subject?: string;
  body: string;
  idempotencyKey: string;
}

export interface ProviderSendResult {
  providerMessageId: string;
  status: 'accepted' | 'failed';
  errorCode?: string;
}

/** Port for a BAA-covered messaging vendor. No vendor is chosen yet. */
export interface MessagingProvider {
  readonly name: string;
  send(message: ProviderMessage): Promise<ProviderSendResult>;
}

/** Resolves the sender identity (name, number, email) from the case's location. */
export interface LocationDirectory {
  getSenderIdentity(practiceId: PracticeId, locationId: string): Promise<SenderIdentity | null>;
}
