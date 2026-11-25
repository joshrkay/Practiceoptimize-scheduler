import {
  InClinicOnlyFormError,
  InvalidWebhookSignatureError,
  type CreateEnvelopeRequest,
  type CreatedEnvelope,
  type ESignProvider,
  type EnvelopeStatus,
  type ProviderEvent,
} from './types.js';
import { signPayload, verifySignature } from './webhook.js';

const STATUSES: readonly string[] = ['sent', 'viewed', 'signed', 'declined', 'expired'];

export class InMemoryESignProvider implements ESignProvider {
  readonly created: CreateEnvelopeRequest[] = [];
  private readonly envelopes = new Map<string, EnvelopeStatus>();
  private readonly byKey = new Map<string, CreatedEnvelope>();

  constructor(private readonly webhookSecret: string) {}

  createEnvelope(request: CreateEnvelopeRequest): Promise<CreatedEnvelope> {
    // Runtime guard in addition to the RemoteForm type, for callers that cast.
    if ((request.form.delivery as string) !== 'remote') {
      return Promise.reject(new InClinicOnlyFormError(request.form.formId));
    }
    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) return Promise.resolve(existing);
    const envelopeId = `env-${this.created.length + 1}`;
    const envelope = { envelopeId, signingUrl: `https://sign.fake.invalid/${envelopeId}` };
    this.created.push(request);
    this.envelopes.set(envelopeId, 'sent');
    this.byKey.set(request.idempotencyKey, envelope);
    return Promise.resolve(envelope);
  }

  getStatus(envelopeId: string): Promise<EnvelopeStatus> {
    const status = this.envelopes.get(envelopeId);
    return status ? Promise.resolve(status) : Promise.reject(new Error('unknown envelope'));
  }

  downloadSignedDocument(envelopeId: string): Promise<Uint8Array> {
    if (this.envelopes.get(envelopeId) !== 'signed') {
      return Promise.reject(new Error('envelope is not signed'));
    }
    return Promise.resolve(new TextEncoder().encode(`%PDF-1.7 synthetic signed ${envelopeId}`));
  }

  verifyWebhook(rawBody: string, signature: string): ProviderEvent {
    if (!verifySignature(this.webhookSecret, rawBody, signature)) {
      throw new InvalidWebhookSignatureError();
    }
    const parsed = JSON.parse(rawBody) as Partial<ProviderEvent>;
    if (
      typeof parsed.eventId !== 'string' ||
      typeof parsed.envelopeId !== 'string' ||
      typeof parsed.occurredAt !== 'string' ||
      typeof parsed.type !== 'string' ||
      !STATUSES.includes(parsed.type)
    ) {
      throw new Error('Malformed e-signature webhook payload');
    }
    return parsed as ProviderEvent;
  }

  /** Test helper: move the envelope and produce a signed webhook delivery for it. */
  emit(event: ProviderEvent): { rawBody: string; signature: string } {
    this.envelopes.set(event.envelopeId, event.type);
    return this.deliver(event);
  }

  /** Test helper: a signed delivery without changing envelope state (replays). */
  deliver(event: ProviderEvent): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(event);
    return { rawBody, signature: signPayload(this.webhookSecret, rawBody) };
  }
}
