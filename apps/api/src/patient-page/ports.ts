/**
 * Ports for everything the patient page needs from other parts of the system.
 * Each is wired to the real implementation at integration; in-memory fakes live in `fakes.ts`.
 */

export type PracticeId = string;
export type CaseId = string;

export type Locale = 'en' | 'es';

export type PaymentClass = 'insured' | 'self_pay' | 'mixed';

export type MessageType =
  | 'appointment_reminders'
  | 'prep_instructions'
  | 'forms_and_consents'
  | 'billing'
  | 'post_op_instructions';

export const MESSAGE_TYPES: readonly MessageType[] = [
  'appointment_reminders',
  'prep_instructions',
  'forms_and_consents',
  'billing',
  'post_op_instructions',
];

/** Link record. Only the hash of the secret is ever stored. */
export interface PatientLinkRecord {
  id: string;
  practiceId: PracticeId;
  caseId: CaseId;
  secretHash: string;
  createdAt: Date;
  expiresAt: Date;
  /** Set when the link was exchanged for a session (or revoked). */
  usedAt: Date | null;
  failedAttempts: number;
  lockedAt: Date | null;
}

export interface PatientLinkStore {
  insert(link: PatientLinkRecord): Promise<void>;
  findById(id: string): Promise<PatientLinkRecord | null>;
  latestForCase(practiceId: PracticeId, caseId: CaseId): Promise<PatientLinkRecord | null>;
  /** Atomic: increments and returns the new failed-attempt count. */
  recordFailedAttempt(id: string): Promise<number>;
  lock(id: string, at: Date): Promise<void>;
  /** Atomic compare-and-set on usedAt. Returns true only for the caller that won. */
  consume(id: string, at: Date): Promise<boolean>;
}

/** Page session. Separate from staff authentication: different store, token and cookie. */
export interface PatientSessionRecord {
  id: string;
  practiceId: PracticeId;
  caseId: CaseId;
  linkId: string;
  secretHash: string;
  expiresAt: Date;
}

export interface PatientSessionStore {
  insert(session: PatientSessionRecord): Promise<void>;
  findById(id: string): Promise<PatientSessionRecord | null>;
}

export interface PatientIdentityPort {
  /** Date of birth as YYYY-MM-DD, or null if unknown. */
  getDateOfBirth(practiceId: PracticeId, caseId: CaseId): Promise<string | null>;
}

export interface ReadinessItemSource {
  id: string;
  /** Plain-language label the patient sees. */
  patientLabel: { en: string; es?: string };
  status: 'complete' | 'pending' | 'blocked' | 'waived';
  owner: 'patient' | 'practice' | 'facility' | 'payer';
  patientVisible: boolean;
  [extra: string]: unknown;
}

/**
 * Case data as the case model returns it. It carries much more than the patient may see;
 * the view-model mapper is the only code that reads it.
 */
export interface CaseSource {
  caseId: CaseId;
  practiceId: PracticeId;
  paymentClass: PaymentClass;
  preferredLocale: Locale;
  procedureDate: string;
  arrivalTime: string;
  facility: { name: string; address: string; parking: string; [extra: string]: unknown };
  surgeon: { displayName: string; [extra: string]: unknown };
  location: { phone: string; [extra: string]: unknown };
  readinessItems: ReadinessItemSource[];
  [extra: string]: unknown;
}

export interface CaseReadPort {
  getCase(practiceId: PracticeId, caseId: CaseId): Promise<CaseSource | null>;
}

export interface AuthorizedContact {
  id: string;
  displayName: string;
  relationship: string;
  enabledMessageTypes: MessageType[];
}

export interface ContactPreferencesPort {
  list(practiceId: PracticeId, caseId: CaseId): Promise<AuthorizedContact[]>;
  /** Returns false if the contact is not authorized on this case. */
  setMessageTypes(
    practiceId: PracticeId,
    caseId: CaseId,
    contactId: string,
    types: MessageType[],
  ): Promise<boolean>;
}

export interface ProposedSlot {
  id: string;
  /** ISO date-time the agent proposes. */
  startsAt: string;
  /** IANA time zone of the facility, for display. */
  timeZone: string;
  facilityName: string;
}

export interface SlotProposalPort {
  /** Slots from the slot finder, already filtered for the case. May return more than three. */
  propose(practiceId: PracticeId, caseId: CaseId): Promise<ProposedSlot[]>;
}

export interface ChangePlanPort {
  /** Creates a change plan that waits for scheduler approval. Never books anything itself. */
  createRescheduleChangePlan(input: {
    practiceId: PracticeId;
    caseId: CaseId;
    slot: ProposedSlot;
    requestedBy: 'patient';
  }): Promise<{ changePlanId: string; status: 'pending_scheduler_approval' }>;
}

export interface FinancialLinks {
  quoteUrl: string | null;
  financialConsentUrl: string | null;
  depositUrl: string | null;
}

/** Quote and e-signature live elsewhere, deposits at the practice's own processor: links out only. */
export interface FinancialLinksPort {
  getLinks(practiceId: PracticeId, caseId: CaseId): Promise<FinancialLinks>;
}

export interface AuditEventInput {
  practiceId: PracticeId;
  caseId: CaseId | null;
  action: string;
  outcome: 'success' | 'failure';
  at: Date;
  actor: { kind: 'patient_link'; linkId: string | null };
  /** Never contains PHI (no date of birth, no names). */
  detail?: Record<string, string | number | boolean>;
}

export interface AuditPort {
  record(event: AuditEventInput): Promise<void>;
}

export interface SchedulerNotificationPort {
  notify(input: {
    practiceId: PracticeId;
    caseId: CaseId;
    kind: 'patient_link_locked' | 'patient_link_reissue_requested';
  }): Promise<void>;
}

export interface LinkDeliveryPort {
  /** Sends the new link to the patient's contact on file. The page never shows it. */
  send(input: { practiceId: PracticeId; caseId: CaseId; url: string; expiresAt: Date }): Promise<void>;
}

export interface Clock {
  now(): Date;
}
