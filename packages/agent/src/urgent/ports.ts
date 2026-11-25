/**
 * Ports for the urgent add-on fast path (RAH-92, ADR-0007).
 *
 * Every dependency of the fast path lives on another branch (order intake, EHR/PM schedule, ASC channel,
 * policy engine, case state machine, Today view, messaging, post-op booking, authorization routing, clock,
 * audit). Each is modeled here as the minimal interface this module needs, to be wired at integration.
 * In-memory fakes live in `fakes.ts`.
 */

export type PracticeId = string;

/** Laterality as written on the signed order. */
export type Side = 'left' | 'right' | 'bilateral' | 'not_applicable';

export interface ProcedureRef {
  /** CPT code. */
  readonly code: string;
  readonly description: string;
}

export type SiteOfService =
  | { readonly kind: 'office'; readonly locationId: string; readonly roomId: string; readonly timeZone: string }
  | { readonly kind: 'asc'; readonly facilityId: string; readonly timeZone: string };

/** Self-pay and mixed cases are not held by the deposit gate on the urgent path (ADR-0007). */
export type FinancialClass = 'insured' | 'self_pay' | 'mixed';

export interface PayerRef {
  readonly payerId: string;
  readonly name: string;
}

/** The surgeon's signed order, as delivered by order intake (RAH-22). */
export interface SignedUrgentOrder {
  readonly practiceId: PracticeId;
  readonly orderId: string;
  readonly caseId: string;
  readonly patientId: string;
  readonly surgeonId: string;
  readonly urgency: 'urgent' | 'routine';
  /** Null when the order has not been signed. */
  readonly signature: { readonly signedBy: string; readonly signedAt: string } | null;
  readonly procedure: ProcedureRef;
  readonly side: Side;
  /** Requested surgery date, local to the site of service (YYYY-MM-DD). */
  readonly date: string;
  readonly durationMinutes: number;
  readonly siteOfService: SiteOfService;
  readonly financialClass: FinancialClass;
  /** Null for self-pay. */
  readonly payer: PayerRef | null;
}

/** What the case record says will be booked (from intake: booking sheet, visit note, structured order). */
export interface CaseRequest {
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly orderId: string;
  readonly procedure: ProcedureRef;
  readonly side: Side;
  readonly date: string;
}

export interface OrderIntakePort {
  getSignedOrder(practiceId: PracticeId, orderId: string): Promise<SignedUrgentOrder | null>;
  getCaseRequest(practiceId: PracticeId, caseId: string): Promise<CaseRequest | null>;
}

/** An open slot in an office procedure room on the EHR or practice-management schedule. */
export interface RoomSlot {
  readonly slotId: string;
  readonly roomId: string;
  /** Local date of the slot (YYYY-MM-DD). */
  readonly date: string;
  /** ISO-8601 instants. */
  readonly start: string;
  readonly end: string;
}

export type BookSlotResult = { readonly ok: true; readonly appointmentId: string } | { readonly ok: false; readonly reason: 'slot_taken' };

/** Office procedure room schedule (EHR via Redox, or the PM system). Only open slots are ever booked. */
export interface OfficeSchedulePort {
  /** Open slots, earliest first, on or after `onOrAfter` and starting no earlier than `notBefore`. */
  findOpenSlots(query: {
    readonly practiceId: PracticeId;
    readonly locationId: string;
    readonly roomId: string;
    readonly onOrAfter: string;
    readonly notBefore: Date;
    readonly durationMinutes: number;
    readonly limit: number;
  }): Promise<readonly RoomSlot[]>;
  /** Books an open slot. Never displaces an existing appointment: a taken slot returns `slot_taken`. */
  bookSlot(request: {
    readonly practiceId: PracticeId;
    readonly slotId: string;
    readonly caseId: string;
    readonly patientId: string;
    readonly surgeonId: string;
    readonly procedureCode: string;
  }): Promise<BookSlotResult>;
}

export interface AscFacility {
  readonly facilityId: string;
  readonly name: string;
  readonly phoneNumber: string;
  readonly hasElectronicChannel: boolean;
}

export interface AscDirectoryPort {
  getFacility(practiceId: PracticeId, facilityId: string): Promise<AscFacility | null>;
}

export type AscSubmissionStatus =
  | { readonly status: 'pending' }
  | { readonly status: 'confirmed'; readonly start: string; readonly confirmationNumber: string }
  | { readonly status: 'rejected'; readonly reason: string };

/** The ASC's electronic add-on channel (RAH-77). */
export interface AscChannelPort {
  submitAddOn(request: {
    readonly practiceId: PracticeId;
    readonly facilityId: string;
    readonly caseId: string;
    readonly patientId: string;
    readonly surgeonId: string;
    readonly procedure: ProcedureRef;
    readonly side: Side;
    readonly date: string;
    readonly durationMinutes: number;
  }): Promise<{ readonly submissionId: string }>;
  getStatus(practiceId: PracticeId, submissionId: string): Promise<AscSubmissionStatus>;
}

export type PolicyDecision = { readonly outcome: 'allow' } | { readonly outcome: 'block'; readonly reason: string };

/** Policy engine (RAH-17). The approval for this action is the signed urgent order itself. */
export interface PolicyEnginePort {
  evaluate(request: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly action: 'book_urgent_add_on';
    readonly approval: { readonly kind: 'signed_urgent_order'; readonly orderId: string; readonly signedBy: string };
  }): Promise<PolicyDecision>;
}

export type CaseState = 'ordered' | 'booked' | (string & {});

/** Case record and state machine (RAH-15). */
export interface CaseStatePort {
  getState(practiceId: PracticeId, caseId: string): Promise<CaseState | null>;
  /** Ordered to Booked directly; the readiness gate is bypassed for urgent add-ons. */
  transition(request: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly from: 'ordered';
    readonly to: 'booked';
    readonly readinessGate: 'bypassed_urgent_add_on';
    readonly reason: string;
  }): Promise<void>;
  setBillable(request: { readonly practiceId: PracticeId; readonly caseId: string; readonly reason: string }): Promise<void>;
}

export type TodayItemKind =
  | 'urgent_order_blocked'
  | 'urgent_room_full'
  | 'urgent_asc_call'
  | 'post_op_visit_needed';

export interface TodayItem {
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly kind: TodayItemKind;
  readonly priority: 'urgent' | 'normal';
  /** Urgent items are pinned at the top of the Today view. */
  readonly pinned: boolean;
  readonly assigneeRole: 'scheduler';
  readonly title: string;
  readonly detail: string;
  readonly phoneNumber?: string;
  readonly offeredSlots?: readonly RoomSlot[];
}

export interface TodayTasksPort {
  createItem(item: TodayItem): Promise<{ readonly itemId: string }>;
}

/** Informational notice to the scheduler; never a request for approval. */
export interface SchedulerNotificationPort {
  notify(notice: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly kind: 'urgent_add_on_booked';
    readonly responseRequired: false;
    readonly message: string;
  }): Promise<void>;
}

export interface JourneyRecipient {
  readonly recipientId: string;
  readonly relationship: 'patient' | 'authorized_contact';
}

export interface PatientMessagingPort {
  /** The patient and the contacts the patient has authorized. */
  getAuthorizedRecipients(practiceId: PracticeId, patientId: string): Promise<readonly JourneyRecipient[]>;
  sendJourney(request: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly recipientId: string;
    readonly journey: 'urgent_compressed';
    readonly surgeryStart: string;
  }): Promise<void>;
}

export interface PostOpBookingPort {
  bookPostOpVisit(request: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly patientId: string;
    readonly surgeonId: string;
    readonly surgeryStart: string;
  }): Promise<{ readonly appointmentId: string; readonly start: string } | null>;
}

/** Authorization routing (RAH-53). */
export interface AuthorizationRoutingPort {
  /** The payer's retro-notification deadline, or null when the payer's rule is unknown. */
  getRetroNotificationDeadline(request: {
    readonly practiceId: PracticeId;
    readonly payerId: string;
    readonly procedureCode: string;
    readonly performedAt: Date;
  }): Promise<Date | null>;
  openRetroAuthorization(request: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly payerId: string;
    readonly procedureCode: string;
    readonly performedAt: Date;
    readonly dueBy: Date | null;
    readonly approvalMode: 'approve_first';
    readonly assigneeRole: 'auth_specialist';
  }): Promise<{ readonly itemId: string }>;
}

export interface ClockPort {
  now(): Date;
}

export type AuditDetail = Readonly<Record<string, string | number | boolean | null>>;

/** Audit log. Details carry IDs and codes only, never PHI. */
export interface AuditPort {
  record(event: {
    readonly practiceId: PracticeId;
    readonly caseId: string;
    readonly action: string;
    readonly at: Date;
    readonly detail: AuditDetail;
  }): Promise<void>;
}

export type UrgentAddOnStatus =
  | 'blocked'
  | 'room_full'
  | 'awaiting_asc_confirmation'
  | 'asc_call_task'
  | 'booked';

/** Durable record of one urgent add-on, keyed by practice and case. */
export interface UrgentAddOnRecord {
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly orderId: string;
  readonly order: SignedUrgentOrder;
  readonly status: UrgentAddOnStatus;
  readonly submissionId?: string;
  /** ISO instant by which the ASC must confirm. */
  readonly confirmBy?: string;
  readonly booking?: UrgentBooking;
  readonly todayItemIds: readonly string[];
  readonly retroAuthorization?: { readonly status: 'opened'; readonly itemId: string } | { readonly status: 'not_required' };
}

export interface UrgentBooking {
  readonly start: string;
  readonly reference: string;
  readonly where: 'office_room' | 'asc';
  readonly postOpAppointmentId: string | null;
}

export interface UrgentAddOnStorePort {
  get(practiceId: PracticeId, caseId: string): Promise<UrgentAddOnRecord | null>;
  save(record: UrgentAddOnRecord): Promise<void>;
}

export interface UrgentAddOnDeps {
  readonly intake: OrderIntakePort;
  readonly officeSchedule: OfficeSchedulePort;
  readonly ascDirectory: AscDirectoryPort;
  readonly ascChannel: AscChannelPort;
  readonly policy: PolicyEnginePort;
  readonly caseState: CaseStatePort;
  readonly today: TodayTasksPort;
  readonly scheduler: SchedulerNotificationPort;
  readonly messaging: PatientMessagingPort;
  readonly postOp: PostOpBookingPort;
  readonly authorization: AuthorizationRoutingPort;
  readonly store: UrgentAddOnStorePort;
  readonly clock: ClockPort;
  readonly audit: AuditPort;
}
