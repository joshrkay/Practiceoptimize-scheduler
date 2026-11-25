import type {
  LocationDirectory,
  MessagingProvider,
  ProviderMessage,
  ProviderSendResult,
} from './ports.js';
import type { Channel, SenderIdentity } from './types.js';

/** In-memory provider for tests. Never touches the network. */
export class FakeMessagingProvider implements MessagingProvider {
  readonly name = 'fake';
  readonly sent: ProviderMessage[] = [];
  readonly failingChannels = new Set<Channel>();
  private counter = 0;

  send(message: ProviderMessage): Promise<ProviderSendResult> {
    this.counter += 1;
    const providerMessageId = `fake-${this.counter}`;
    if (this.failingChannels.has(message.channel)) {
      return Promise.resolve({ providerMessageId, status: 'failed', errorCode: 'fake_failure' });
    }
    this.sent.push(message);
    return Promise.resolve({ providerMessageId, status: 'accepted' });
  }
}

export class FakeLocationDirectory implements LocationDirectory {
  private readonly identities = new Map<string, SenderIdentity>();

  set(practiceId: string, identity: SenderIdentity): void {
    this.identities.set(`${practiceId}:${identity.locationId}`, identity);
  }

  getSenderIdentity(practiceId: string, locationId: string): Promise<SenderIdentity | null> {
    return Promise.resolve(this.identities.get(`${practiceId}:${locationId}`) ?? null);
  }
}
