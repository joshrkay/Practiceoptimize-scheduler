/**
 * Vendor-agnostic EHR domain types. Every value here is what our code sees; vendor wire formats
 * (Redox data model messages) are translated at the edge in `redox/`.
 */

/** The customer and isolation boundary. */
export type PracticeId = string;
/** A practice location (clinic, office procedure room, ASC) as known to the practice. */
export type LocationId = string;

/** Pilot EHRs reached through Redox. */
export const PILOT_EHR_SYSTEMS = ['athenahealth', 'eclinicalworks', 'nextgen'] as const;
export type EhrSystem = (typeof PILOT_EHR_SYSTEMS)[number];

/** Every connector call is scoped to one practice and one of its locations. */
export interface EhrRequestContext {
  readonly practiceId: PracticeId;
  readonly locationId: LocationId;
  /** Optional trace ID carried into logs and workspace tasks. */
  readonly correlationId?: string;
}

export interface CodedConcept {
  readonly code: string;
  /** e.g. CPT, ICD-10-CM, HCPCS. */
  readonly codeSystem: string;
  readonly description?: string;
}

export interface ProviderRef {
  readonly id: string;
  readonly name?: string;
  readonly npi?: string;
}

export type AdministrativeSex = 'female' | 'male' | 'other' | 'unknown';

export interface Patient {
  /** The patient's ID in the EHR at this location (e.g. MRN). */
  readonly id: string;
  readonly givenName: string;
  readonly familyName: string;
  /** ISO date, YYYY-MM-DD. */
  readonly birthDate: string;
  readonly sex: AdministrativeSex;
  readonly phone?: string;
}

export interface Coverage {
  readonly payerName: string;
  readonly payerId?: string;
  readonly planName?: string;
  readonly memberId: string;
  readonly groupNumber?: string;
  /** 1 = primary, 2 = secondary, ... */
  readonly rank: number;
}

export type OrderStatus = 'new' | 'updated' | 'cancelled';
export type OrderPriority = 'routine' | 'urgent' | 'unknown';

export interface SurgicalOrder {
  readonly externalId: string;
  readonly practiceId: PracticeId;
  readonly locationId: LocationId;
  readonly patientId: string;
  readonly status: OrderStatus;
  readonly priority: OrderPriority;
  /** ISO timestamp. */
  readonly orderedAt: string;
  readonly orderingProvider?: ProviderRef;
  readonly procedures: readonly CodedConcept[];
  readonly diagnoses: readonly CodedConcept[];
}

export interface ClinicalDocumentSummary {
  readonly id: string;
  readonly patientId: string;
  /** e.g. "Progress Note", "Imaging Report". */
  readonly documentType: string;
  readonly title: string;
  /** ISO timestamp. */
  readonly authoredAt: string;
}

export interface ClinicalDocument extends ClinicalDocumentSummary {
  readonly contentType: 'text/plain' | 'application/pdf';
  /** Plain text, or base64 for binary content types. */
  readonly content: string;
}

export type AppointmentStatus = 'booked' | 'cancelled' | 'completed' | 'no-show';

export interface Appointment {
  readonly id: string;
  readonly patientId: string;
  readonly providerId: string;
  readonly visitType: string;
  /** ISO timestamps. */
  readonly start: string;
  readonly end: string;
  readonly status: AppointmentStatus;
}

export interface ScheduleSlot {
  readonly id: string;
  readonly providerId: string;
  readonly visitType: string;
  readonly start: string;
  readonly end: string;
}

export interface TimeWindow {
  /** ISO timestamps; `from` inclusive, `to` exclusive. */
  readonly from: string;
  readonly to: string;
}

export interface OrderQuery {
  /** ISO timestamp; only orders received at or after it. */
  readonly since?: string;
}

export interface DocumentQuery {
  readonly patientId: string;
  readonly since?: string;
}

export interface AppointmentQuery extends TimeWindow {
  readonly patientId?: string;
  readonly providerId?: string;
}

export interface SlotQuery extends TimeWindow {
  readonly providerId?: string;
  readonly visitType?: string;
}

export interface BookAppointmentRequest {
  readonly patientId: string;
  readonly providerId: string;
  readonly visitType: string;
  readonly start: string;
  readonly end: string;
  /** Caller-chosen idempotency key; repeated calls with the same key book once. */
  readonly idempotencyKey: string;
}

/** A document or note written back to the patient's chart. */
export interface ChartDocumentWrite {
  readonly patientId: string;
  readonly documentType: string;
  readonly title: string;
  readonly contentType: 'text/plain' | 'application/pdf';
  readonly content: string;
  readonly authoredAt: string;
  readonly authorProviderId?: string;
  /** Caller-chosen idempotency key; becomes the document ID in the EHR where possible. */
  readonly idempotencyKey: string;
}

/** A message into a clinician's or staff pool's EHR in-basket. */
export interface InBasketMessage {
  readonly recipientId: string;
  readonly patientId?: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

/** What a successful write returns. */
export interface WriteReceipt {
  readonly externalId: string;
}
