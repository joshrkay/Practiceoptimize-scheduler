/** Care team directory model. Parties are practice-owned, or shared facility entries (practiceId null). */

export type Channel = 'fax' | 'email' | 'in_basket';

export type PartyKind =
  | 'pcp'
  | 'cardiology'
  | 'vascular'
  | 'lab'
  | 'asc_scheduling'
  | 'pre_admission_testing'
  | 'vendor_rep';

export type Verification =
  | { readonly status: 'unverified' }
  | { readonly status: 'verified'; readonly verifiedBy: string; readonly verifiedAt: string };

export interface Endpoint {
  readonly address: string;
  readonly verification: Verification;
}

export interface Hours {
  readonly timezone: string;
  readonly windows: readonly { readonly days: readonly string[]; readonly open: string; readonly close: string }[];
}

export interface Party {
  readonly id: string;
  /** Owning practice, or null for a shared facility entry visible to every practice. */
  readonly practiceId: string | null;
  readonly name: string;
  readonly kind: PartyKind;
  readonly role: string;
  readonly preferredChannel: Channel;
  readonly endpoints: Readonly<Partial<Record<Channel, Endpoint>>>;
  readonly hours?: Hours;
}

export function isVerified(endpoint: Endpoint | undefined): endpoint is Endpoint & { verification: { status: "verified" } } {
  return endpoint?.verification.status === 'verified';
}
