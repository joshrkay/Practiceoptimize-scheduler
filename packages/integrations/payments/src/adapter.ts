/**
 * The one interface every processor implements (healthcare processor, EHR payments, Stripe, Square).
 *
 * Card data never appears here: the patient pays on the processor's hosted page, and the only things
 * that cross this boundary are ids, amounts, statuses and timestamps. There is deliberately no refund
 * method; refunds are made by staff in the practice's own processor and only reported to us.
 */

export type LinkPurpose = 'deposit' | 'balance';

export type LinkStatus = 'open' | 'partially_paid' | 'paid' | 'failed' | 'expired';

/** Per-practice secrets, fetched at call time from the practice's vault path. Never logged or stored. */
export interface ProcessorCredentials {
  readonly apiCredential: string;
  readonly webhookSecret: string;
}

export interface HostedLinkRequest {
  readonly practiceId: string;
  readonly caseId: string;
  readonly purpose: LinkPurpose;
  /** Always a human-entered amount (quote deposit or staff-estimated balance); never generated here. */
  readonly amountCents: number;
  readonly expiresAt: Date;
  /** Opaque reference echoed back in webhooks; contains no patient identifiers. */
  readonly reference: string;
}

export interface HostedLink {
  readonly linkId: string;
  readonly url: string;
  readonly expiresAt: Date;
}

export type PaymentEventKind = 'paid' | 'partially_paid' | 'failed' | 'expired' | 'refunded';

/**
 * Normalized webhook event. The exact key set is the contract: no card number, expiry, CVV or
 * cardholder fields exist on this type, so none can be carried through the service.
 */
export interface PaymentEvent {
  readonly eventId: string;
  readonly kind: PaymentEventKind;
  readonly linkId: string;
  readonly amountCents: number;
  readonly occurredAt: Date;
}

export interface WebhookInput {
  readonly secret: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: string;
}

export interface PaymentProcessor {
  /** Stable processor identifier stored with the practice's selection, e.g. 'stripe'. */
  readonly processorId: string;
  createHostedLink(credentials: ProcessorCredentials, request: HostedLinkRequest): Promise<HostedLink>;
  getLinkStatus(credentials: ProcessorCredentials, linkId: string): Promise<LinkStatus>;
  /** Verify the signature over the raw body with the practice's webhook secret (constant-time). */
  verifyWebhook(input: WebhookInput): boolean;
  /** Parse a body that has already passed verifyWebhook. Throws on a malformed body. */
  parseWebhook(rawBody: string): PaymentEvent;
}
