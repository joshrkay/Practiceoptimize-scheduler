/**
 * Ports for post-op visit booking. The real implementations live on other branches
 * (EHR connector over Redox per ADR-0002, case model, tenancy settings, Today view, audit log)
 * and are wired at integration. Everything here is a minimal local interface.
 */

export type PracticeId = string;

/** An open slot reported by the EHR connector. `startsAt` is ISO 8601 with the location's local date. */
export interface OpenSlot {
  slotId: string;
  providerId: string;
  locationId: string;
  startsAt: string;
}

export interface SlotSearch {
  practiceId: PracticeId;
  /** The surgeon and, when set, their assistant. */
  providerIds: string[];
  locationId: string;
  /** Inclusive local dates, YYYY-MM-DD. */
  fromDate: string;
  toDate: string;
}

export type SlotSearchResult =
  | { kind: 'slots'; slots: OpenSlot[] }
  | { kind: 'unsupported'; ehr: string };

export interface BookRequest {
  practiceId: PracticeId;
  slot: OpenSlot;
  caseId: string;
  /** Stable per case so a connector retry cannot create a second appointment. */
  idempotencyKey: string;
}

export type BookResult =
  | { kind: 'booked'; appointmentId: string }
  | { kind: 'slot_taken' }
  | { kind: 'unsupported'; ehr: string };

export type ChangeResult = { kind: 'ok' } | { kind: 'not_found' } | { kind: 'unsupported'; ehr: string };

/** Schedule access through the connector interface; never a vendor scheduling API directly. */
export interface ScheduleConnector {
  findOpenSlots(search: SlotSearch): Promise<SlotSearchResult>;
  bookAppointment(request: BookRequest): Promise<BookResult>;
  moveAppointment(args: {
    practiceId: PracticeId;
    appointmentId: string;
    slot: OpenSlot;
  }): Promise<BookResult | ChangeResult>;
  cancelAppointment(args: { practiceId: PracticeId; appointmentId: string }): Promise<ChangeResult>;
}

/** Resolved settings (tenancy inheritance already applied). */
export interface SettingsPort {
  postOpWindow(args: {
    practiceId: PracticeId;
    surgeonId: string;
  }): Promise<{ minDays: number; maxDays: number } | undefined>;
}

export const DEFAULT_POST_OP_WINDOW = { minDays: 10, maxDays: 14 } as const;

export type PolicyDecision = 'autonomous' | 'approve_first';

export interface PolicyPort {
  decide(args: { practiceId: PracticeId; action: 'book_post_op_visit'; caseId: string }): Promise<PolicyDecision>;
}

export type TaskTarget = 'scheduler' | 'workspace';
export type TaskKind =
  | 'post_op_no_slot'
  | 'post_op_appointments_unsupported'
  | 'post_op_approval'
  | 'post_op_move_failed';

export interface TaskInput {
  practiceId: PracticeId;
  caseId: string;
  target: TaskTarget;
  kind: TaskKind;
  /** Plain-language reason shown in the Today view; ids only, no patient details. */
  reason: string;
  proposedSlot?: OpenSlot;
}

export interface TaskPort {
  createTask(task: TaskInput): Promise<void>;
}

export interface AuditPort {
  record(event: { practiceId: PracticeId; caseId: string; action: string }): Promise<void>;
}

export interface PostOpVisit {
  practiceId: PracticeId;
  caseId: string;
  appointmentId: string;
  locationId: string;
  providerId: string;
  startsAt: string;
  surgeryDate: string;
  /** Days from surgery to visit, kept so a reschedule can move by the same offset. */
  offsetDays: number;
  status: 'booked' | 'cancelled';
}

/** One visit record per case: the idempotency anchor. */
export interface VisitStore {
  get(practiceId: PracticeId, caseId: string): Promise<PostOpVisit | undefined>;
  save(visit: PostOpVisit): Promise<void>;
}

export interface PostOpDeps {
  /** FEATURE_POST_OP_BOOKING, resolved by the caller. */
  enabled: boolean;
  connector: ScheduleConnector;
  settings: SettingsPort;
  policy: PolicyPort;
  tasks: TaskPort;
  audit: AuditPort;
  visits: VisitStore;
}
