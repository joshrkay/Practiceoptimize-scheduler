export type PracticeId = string;
export type CaseId = string;

/** A form in the practice's approved library. Content lives in the library, never here. */
export interface ApprovedForm {
  readonly formId: string;
  readonly version: string;
  readonly title: string;
  /** In-clinic only forms (e.g. surgical consents the surgeon discusses in person) are never sent. */
  readonly delivery: 'remote' | 'in-clinic-only';
}

/** The only form shape the provider accepts: in-clinic-only forms do not type-check here. */
export type RemoteForm = ApprovedForm & { readonly delivery: 'remote' };

export type EnvelopeStatus = 'sent' | 'viewed' | 'signed' | 'declined' | 'expired';

export interface CreateEnvelopeRequest {
  readonly practiceId: PracticeId;
  readonly caseId: CaseId;
  readonly form: RemoteForm;
  /** Opaque patient reference; the provider never receives free-text form content. */
  readonly patientRef: string;
  readonly idempotencyKey: string;
}

export interface CreatedEnvelope {
  readonly envelopeId: string;
  readonly signingUrl: string;
}

export interface ProviderEvent {
  readonly eventId: string;
  readonly envelopeId: string;
  readonly type: EnvelopeStatus;
  readonly occurredAt: string;
}

export interface ESignProvider {
  createEnvelope(request: CreateEnvelopeRequest): Promise<CreatedEnvelope>;
  getStatus(envelopeId: string): Promise<EnvelopeStatus>;
  downloadSignedDocument(envelopeId: string): Promise<Uint8Array>;
  /** Verifies the signature over the raw body and returns the parsed event; throws if invalid. */
  verifyWebhook(rawBody: string, signature: string): ProviderEvent;
}

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super('Invalid e-signature webhook signature');
    this.name = 'InvalidWebhookSignatureError';
  }
}

export class InClinicOnlyFormError extends Error {
  constructor(formId: string) {
    super(`Form ${formId} is in-clinic only and is never sent for e-signature`);
    this.name = 'InClinicOnlyFormError';
  }
}
