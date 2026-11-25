/**
 * Change plan model (RAH-57).
 *
 * A change plan is the single, approve-first proposal the agent shows a scheduler when a case moves or is
 * cancelled. It lists every downstream step (slot, authorization, readiness, facility posting, vendor and
 * team requests, post-op visit, patient message, EHR and practice-management updates, freed slot) for every
 * affected case. Nothing in a plan runs until the plan carries exactly one scheduler approval.
 */

export type PracticeId = string;
export type CaseId = string;
export type SurgeonId = string;
export type FacilityId = string;
export type IsoDateTime = string;

export type SiteOfService = 'office_procedure_room' | 'asc';

/** Case states this module reads or writes. The full state machine belongs to the case model (RAH-15). */
export type CaseStatus =
  | 'Auth pending'
  | 'Booked'
  | 'Confirmed'
  | 'Ready'
  | 'Rescheduling'
  | 'Cancelled';

/** The status a case re-enters the workflow at once its plan has run. */
export type ReentryStatus = 'Auth pending' | 'Booked' | 'Cancelled';

export interface Procedure {
  readonly cptCodes: readonly string[];
  readonly description: string;
  readonly durationMinutes: number;
}

export interface CaseAuthorization {
  readonly authorizationId: string;
  readonly cptCodes: readonly string[];
  readonly validFrom: IsoDateTime;
  readonly validThrough: IsoDateTime;
  readonly facilityId?: FacilityId;
}

export interface ReadinessItemRef {
  readonly itemId: string;
  readonly kind: 'lab' | 'clearance' | 'imaging' | 'consent' | 'other';
  readonly label: string;
  readonly completedOn: IsoDateTime;
  readonly validForDays: number;
}

export interface CoordinationRequestRef {
  readonly requestId: string;
  readonly party: 'vendor' | 'team';
  /** e.g. "Implant rep (synthetic vendor)" or "Anesthesia". */
  readonly label: string;
}

export interface PostOpVisitRef {
  readonly appointmentId: string;
  readonly start: IsoDateTime;
}

export interface SeriesRef {
  readonly seriesId: string;
  /** Zero-based position of this case in its series. */
  readonly position: number;
}

/** The slice of a case record a change plan needs. */
export interface CaseSnapshot {
  readonly caseId: CaseId;
  readonly practiceId: PracticeId;
  /** Synthetic reference only; never a name or MRN. */
  readonly patientRef: string;
  readonly status: CaseStatus;
  readonly surgeonId: SurgeonId;
  readonly facilityId: FacilityId;
  readonly siteOfService: SiteOfService;
  readonly slotId: string;
  readonly scheduledStart: IsoDateTime;
  readonly procedure: Procedure;
  readonly authorization?: CaseAuthorization;
  readonly readinessItems: readonly ReadinessItemRef[];
  readonly coordinationRequests: readonly CoordinationRequestRef[];
  readonly postOpVisit?: PostOpVisitRef;
  readonly series?: SeriesRef;
}

export interface Slot {
  readonly slotId: string;
  readonly facilityId: FacilityId;
  readonly siteOfService: SiteOfService;
  readonly surgeonId: SurgeonId;
  readonly start: IsoDateTime;
  readonly end: IsoDateTime;
}

/** What the scheduler (or an inbound event) says changed. */
export type ChangeRequest =
  | { readonly type: 'date'; readonly caseId: CaseId; readonly preferredStart: IsoDateTime }
  | {
      readonly type: 'site';
      readonly caseId: CaseId;
      readonly facilityId: FacilityId;
      readonly siteOfService: SiteOfService;
    }
  | { readonly type: 'procedure'; readonly caseId: CaseId; readonly procedure: Procedure }
  | { readonly type: 'surgeon'; readonly caseId: CaseId; readonly surgeonId: SurgeonId }
  | { readonly type: 'cancellation'; readonly caseId: CaseId; readonly reason: string }
  | {
      readonly type: 'surgeon_calendar';
      readonly surgeonId: SurgeonId;
      /** Calendar day (YYYY-MM-DD, UTC) the surgeon is unavailable. */
      readonly date: string;
      readonly reason: string;
    };

export type ChangeType = ChangeRequest['type'];

/** One action a step performs. Each maps to exactly one port call in `execute.ts`. */
export type StepAction =
  | { readonly kind: 'enter_rescheduling' }
  | { readonly kind: 'post_facility_slot'; readonly slot: Slot }
  | { readonly kind: 'update_facility_posting'; readonly slot: Slot }
  | { readonly kind: 'cancel_facility_posting'; readonly facilityId: FacilityId; readonly slotId: string }
  | {
      readonly kind: 'resubmit_authorization';
      readonly cptCodes: readonly string[];
      readonly scheduledStart: IsoDateTime;
      readonly facilityId: FacilityId;
      readonly surgeonId: SurgeonId;
      readonly reason: string;
    }
  | { readonly kind: 'reopen_readiness_item'; readonly itemId: string; readonly label: string }
  | {
      readonly kind: 'update_coordination_request';
      readonly requestId: string;
      readonly party: 'vendor' | 'team';
      readonly scheduledStart: IsoDateTime;
      readonly facilityId: FacilityId;
      readonly surgeonId: SurgeonId;
      readonly cptCodes: readonly string[];
    }
  | { readonly kind: 'cancel_coordination_request'; readonly requestId: string; readonly party: 'vendor' | 'team' }
  | { readonly kind: 'move_post_op_visit'; readonly appointmentId: string; readonly newStart: IsoDateTime }
  | { readonly kind: 'cancel_post_op_visit'; readonly appointmentId: string }
  | {
      readonly kind: 'notify_patient';
      readonly template: 'case_rescheduled' | 'case_details_changed' | 'case_cancelled';
      readonly scheduledStart?: IsoDateTime;
      readonly facilityId?: FacilityId;
    }
  | { readonly kind: 'update_ehr'; readonly change: CaseChangeSummary }
  | { readonly kind: 'update_practice_management'; readonly change: CaseChangeSummary }
  | { readonly kind: 'release_slot_to_waitlist'; readonly slotId: string; readonly facilityId: FacilityId; readonly start: IsoDateTime }
  | { readonly kind: 'reenter_workflow'; readonly status: ReentryStatus };

export type StepKind = StepAction['kind'];

/** Steps that call a system outside this product. They follow the two-attempt rule. */
export const EXTERNAL_STEP_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'post_facility_slot',
  'update_facility_posting',
  'cancel_facility_posting',
  'resubmit_authorization',
  'update_coordination_request',
  'cancel_coordination_request',
  'move_post_op_visit',
  'cancel_post_op_visit',
  'notify_patient',
  'update_ehr',
  'update_practice_management',
]);

/** After this many failed attempts at an external step the plan stops and a human takes over. */
export const MAX_EXTERNAL_ATTEMPTS = 2;

export interface CaseChangeSummary {
  readonly cancelled: boolean;
  readonly scheduledStart?: IsoDateTime;
  readonly facilityId?: FacilityId;
  readonly surgeonId?: SurgeonId;
  readonly cptCodes?: readonly string[];
}

export type StepStatus = 'pending' | 'succeeded' | 'failed';

export interface StepResult {
  readonly attempt: number;
  readonly at: IsoDateTime;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ChangeStep {
  readonly stepId: string;
  readonly caseId: CaseId;
  readonly description: string;
  readonly external: boolean;
  readonly action: StepAction;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly results: readonly StepResult[];
}

/** Everything the plan proposes for one case. */
export interface CaseEffect {
  readonly caseId: CaseId;
  readonly patientRef: string;
  readonly fromStatus: CaseStatus;
  readonly reentryStatus: ReentryStatus;
  /** Why this case is in the plan: the case that changed, a later case in its series, or a surgeon's day. */
  readonly reason: 'requested' | 'series_spacing' | 'surgeon_calendar';
  readonly oldSlot: Slot;
  readonly newSlot?: Slot;
  readonly authorizationResubmission: boolean;
  readonly expiringReadinessItemIds: readonly string[];
  readonly notes: readonly string[];
}

export type PlanStatus = 'proposed' | 'approved' | 'rejected' | 'paused' | 'stopped' | 'completed';

export type Approver =
  | { readonly type: 'human'; readonly userId: string; readonly role: 'scheduler' | 'admin' }
  /** A practice policy that pre-approves a class of plans. Never accepted for cancellations. */
  | { readonly type: 'delegated_policy'; readonly policyId: string };

export interface PlanApproval {
  readonly approver: Approver;
  readonly at: IsoDateTime;
}

export interface PlanTaskRef {
  readonly taskId: string;
  readonly reason: string;
  readonly remainingStepIds: readonly string[];
}

export interface ChangePlan {
  readonly planId: string;
  readonly practiceId: PracticeId;
  readonly change: ChangeRequest;
  readonly createdAt: IsoDateTime;
  readonly status: PlanStatus;
  /** True for any plan that cancels a case; only a human may approve it. */
  readonly requiresHumanApprover: boolean;
  readonly cases: readonly CaseEffect[];
  readonly steps: readonly ChangeStep[];
  /** Reasons the plan cannot be approved as is (for example no slot found). */
  readonly blockers: readonly string[];
  readonly approval?: PlanApproval;
  readonly rejection?: { readonly by: string; readonly at: IsoDateTime; readonly reason: string };
  readonly tasks: readonly PlanTaskRef[];
}
