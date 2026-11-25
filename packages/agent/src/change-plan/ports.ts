/**
 * Ports for the reschedule cascade (RAH-57).
 *
 * Every dependency below is being built on another branch (slot finder RAH-56, authorization RAH-46/RAH-51,
 * readiness and case state RAH-15, coordination RAH-36, patient outreach RAH-31, review queue RAH-19, EHR via
 * Redox, practice management, waitlist RAH-68). This module only depends on these minimal interfaces; they
 * are wired to the real tools at integration. In-memory fakes live in `fakes.ts`.
 *
 * Every write takes an `idempotencyKey` (`<planId>:<stepId>`) so a resumed plan never double-applies a step.
 */
import type {
  CaseAuthorization,
  CaseChangeSummary,
  CaseId,
  CaseSnapshot,
  CaseStatus,
  FacilityId,
  IsoDateTime,
  PracticeId,
  ReadinessItemRef,
  SiteOfService,
  Slot,
  SurgeonId,
} from './model.js';

export interface WriteContext {
  readonly practiceId: PracticeId;
  readonly caseId: CaseId;
  readonly idempotencyKey: string;
}

/** Reads the case records a plan is built from. */
export interface CaseRepositoryPort {
  getCase(practiceId: PracticeId, caseId: CaseId): Promise<CaseSnapshot | undefined>;
  /** All cases in a series, in series order. */
  listSeries(practiceId: PracticeId, seriesId: string): Promise<readonly CaseSnapshot[]>;
  /** Active (not cancelled) cases for a surgeon on one UTC calendar day (YYYY-MM-DD). */
  listCasesForSurgeonOnDate(practiceId: PracticeId, surgeonId: SurgeonId, date: string): Promise<readonly CaseSnapshot[]>;
}

export interface SlotQuery {
  readonly practiceId: PracticeId;
  readonly caseId: CaseId;
  readonly surgeonId: SurgeonId;
  readonly facilityId?: FacilityId;
  readonly siteOfService?: SiteOfService;
  readonly durationMinutes: number;
  readonly earliestStart: IsoDateTime;
  readonly preferredStart: IsoDateTime;
  /** Slots to leave out (for example the day the surgeon is out). */
  readonly excludeDates?: readonly string[];
}

/** RAH-56: ranked slots, best first. */
export interface SlotFinderPort {
  findSlots(query: SlotQuery): Promise<readonly Slot[]>;
}

export interface AuthWindowQuery {
  readonly practiceId: PracticeId;
  readonly caseId: CaseId;
  readonly authorization: CaseAuthorization | undefined;
  readonly scheduledStart: IsoDateTime;
  readonly cptCodes: readonly string[];
  readonly facilityId: FacilityId;
  readonly surgeonId: SurgeonId;
}

/** RAH-46 / RAH-51: authorization window check and re-submission. */
export interface AuthorizationPort {
  checkWindow(query: AuthWindowQuery): Promise<{ readonly covered: boolean; readonly reason: string }>;
  resubmit(
    ctx: WriteContext,
    request: {
      readonly cptCodes: readonly string[];
      readonly scheduledStart: IsoDateTime;
      readonly facilityId: FacilityId;
      readonly surgeonId: SurgeonId;
      readonly reason: string;
    },
  ): Promise<{ readonly submissionId: string }>;
}

/** RAH-15 readiness model: which completed items lapse before the new date, and reopening them. */
export interface ReadinessPort {
  findExpiring(
    practiceId: PracticeId,
    caseId: CaseId,
    items: readonly ReadinessItemRef[],
    newStart: IsoDateTime,
  ): Promise<readonly ReadinessItemRef[]>;
  reopen(ctx: WriteContext, itemId: string, reason: string): Promise<void>;
}

/** Facility (ASC or office procedure room) posting. */
export interface FacilityPostingPort {
  post(ctx: WriteContext, slot: Slot): Promise<{ readonly postingId: string }>;
  update(ctx: WriteContext, slot: Slot): Promise<{ readonly postingId: string }>;
  cancel(ctx: WriteContext, facilityId: FacilityId, slotId: string): Promise<void>;
}

/** RAH-36: vendor and care-team coordination requests. */
export interface CoordinationPort {
  updateRequest(
    ctx: WriteContext,
    requestId: string,
    change: {
      readonly scheduledStart: IsoDateTime;
      readonly facilityId: FacilityId;
      readonly surgeonId: SurgeonId;
      readonly cptCodes: readonly string[];
    },
  ): Promise<void>;
  cancelRequest(ctx: WriteContext, requestId: string): Promise<void>;
}

/** Post-op visit in the practice's appointment book. */
export interface PostOpVisitPort {
  move(ctx: WriteContext, appointmentId: string, newStart: IsoDateTime): Promise<{ readonly appointmentId: string }>;
  cancel(ctx: WriteContext, appointmentId: string): Promise<void>;
}

/** RAH-31: patient outreach. */
export interface PatientMessagingPort {
  send(
    ctx: WriteContext,
    message: {
      readonly template: 'case_rescheduled' | 'case_details_changed' | 'case_cancelled';
      readonly scheduledStart?: IsoDateTime;
      readonly facilityId?: FacilityId;
    },
  ): Promise<{ readonly messageId: string }>;
}

/** EHR (through Redox, behind our connector). */
export interface EhrPort {
  updateCase(ctx: WriteContext, change: CaseChangeSummary): Promise<void>;
}

/** Practice-management system. */
export interface PracticeManagementPort {
  updateCase(ctx: WriteContext, change: CaseChangeSummary): Promise<void>;
}

/** RAH-68: freed slots go to the waitlist. */
export interface WaitlistPort {
  releaseSlot(ctx: WriteContext, slot: { readonly slotId: string; readonly facilityId: FacilityId; readonly start: IsoDateTime }): Promise<void>;
}

/** RAH-15 state machine. */
export interface CaseStatePort {
  transition(ctx: WriteContext, to: CaseStatus, reason: string): Promise<void>;
}

/** RAH-19 review queue: a task a scheduler works when a plan pauses or stops. */
export interface ReviewQueuePort {
  createTask(task: {
    readonly practiceId: PracticeId;
    readonly planId: string;
    readonly title: string;
    readonly reason: string;
    readonly remainingSteps: readonly { readonly stepId: string; readonly caseId: CaseId; readonly description: string }[];
    readonly requiresTakeOver: boolean;
  }): Promise<{ readonly taskId: string }>;
}

export interface Clock {
  now(): IsoDateTime;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/** Ports the plan builder reads from. It never writes. */
export interface PlanningPorts {
  readonly cases: CaseRepositoryPort;
  readonly slots: SlotFinderPort;
  readonly authorization: Pick<AuthorizationPort, 'checkWindow'>;
  readonly readiness: Pick<ReadinessPort, 'findExpiring'>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** Ports the executor writes through. */
export interface ExecutionPorts {
  readonly caseState: CaseStatePort;
  readonly authorization: Pick<AuthorizationPort, 'resubmit'>;
  readonly readiness: Pick<ReadinessPort, 'reopen'>;
  readonly facility: FacilityPostingPort;
  readonly coordination: CoordinationPort;
  readonly postOp: PostOpVisitPort;
  readonly messaging: PatientMessagingPort;
  readonly ehr: EhrPort;
  readonly practiceManagement: PracticeManagementPort;
  readonly waitlist: WaitlistPort;
  readonly reviewQueue: ReviewQueuePort;
  readonly clock: Clock;
}
