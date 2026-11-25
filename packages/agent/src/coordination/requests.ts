/**
 * CoordinationRequest: one ask the agent sends to one care team party for one case
 * (a clearance, a facility posting, a vendor rep, ...), and its lifecycle.
 *
 * Status lifecycle:
 *   open -> answered | overdue | cancelled
 *   overdue -> answered | cancelled
 *   answered, cancelled: terminal
 *
 * Requests are idempotent per practice, case, party and type: at most one active (open or overdue)
 * request exists for that combination at a time.
 */

export type CoordinationRequestStatus = 'open' | 'answered' | 'overdue' | 'cancelled';

export const ACTIVE_STATUSES: readonly CoordinationRequestStatus[] = ['open', 'overdue'];

export type CoordinationRequestType =
  | 'clearance'
  | 'pre_op_test'
  | 'facility_posting'
  | 'anesthesia_packet'
  | 'vendor_rep'
  | 'peer_to_peer'
  | 'post_op_service';

/** Party roles a coordination request can go to. */
export type PartyRole =
  | 'facility_or_desk'
  | 'vendor_rep'
  | 'primary_care'
  | 'cardiology'
  | 'anesthesia'
  | 'surgeon'
  | 'post_op_service';

export type OutboundChannel = 'fax' | 'email' | 'in_basket';

/**
 * Whether a scheduler must approve the request before it is sent.
 * - not_required: sent on creation.
 * - pending: held until a scheduler approves it in the review queue; no reminders run.
 * - approved: approved in the review queue (`ref` is the review item) or by an approved change plan.
 */
export type ApprovalState =
  | { status: 'not_required' }
  | { status: 'pending'; reviewItemId: string | null }
  | { status: 'approved'; via: 'review_queue' | 'change_plan'; ref: string; approvedAt: string };

export interface RequestHistoryEntry {
  at: string;
  event:
    | 'created'
    | 'sent'
    | 'approved'
    | 'reminder_sent'
    | 'phone_task_created'
    | 'overdue'
    | 'answered'
    | 'cancelled'
    | 'cancellation_notice_sent';
  detail?: string;
}

export interface CoordinationRequest {
  id: string;
  practiceId: string;
  caseId: string;
  partyId: string;
  partyRole: PartyRole;
  type: CoordinationRequestType;
  /** Journey step that produced the request. */
  stepId: string;
  /** Case stage at which the request was opened. */
  stage: string;
  channel: OutboundChannel;
  status: CoordinationRequestStatus;
  approval: ApprovalState;
  /** Surgery date (YYYY-MM-DD) the request was written for. */
  surgeryDate: string;
  /** ISO timestamp the request is due back. */
  dueAt: string;
  createdAt: string;
  /** Set when the request actually went out; the reminder ladder counts from here. */
  sentAt: string | null;
  answeredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** 0, 1 or 2 reminders sent through the request's channel. */
  remindersSent: number;
  phoneTaskId: string | null;
  /** The request this one replaces after an approved change. */
  supersedesId: string | null;
  blocksReadiness: boolean;
  history: RequestHistoryEntry[];
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly requestId: string,
    readonly from: CoordinationRequestStatus,
    readonly to: CoordinationRequestStatus,
  ) {
    super(`Coordination request ${requestId} cannot move from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

const TRANSITIONS: Record<CoordinationRequestStatus, readonly CoordinationRequestStatus[]> = {
  open: ['answered', 'overdue', 'cancelled'],
  overdue: ['answered', 'cancelled'],
  answered: [],
  cancelled: [],
};

export function canTransition(from: CoordinationRequestStatus, to: CoordinationRequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isActive(request: Pick<CoordinationRequest, 'status'>): boolean {
  return ACTIVE_STATUSES.includes(request.status);
}

/** Idempotency key: practice, case, party and type. */
export function idempotencyKey(
  request: Pick<CoordinationRequest, 'practiceId' | 'caseId' | 'partyId' | 'type'>,
): string {
  return [request.practiceId, request.caseId, request.partyId, request.type].join('|');
}

function transition(
  request: CoordinationRequest,
  to: Exclude<CoordinationRequestStatus, 'open'>,
  at: Date,
  patch: Partial<CoordinationRequest>,
  detail?: string,
): CoordinationRequest {
  if (!canTransition(request.status, to)) {
    throw new InvalidTransitionError(request.id, request.status, to);
  }
  const entry: RequestHistoryEntry = { at: at.toISOString(), event: to };
  if (detail !== undefined) entry.detail = detail;
  return { ...request, ...patch, status: to, history: [...request.history, entry] };
}

export function markAnswered(request: CoordinationRequest, at: Date, detail?: string): CoordinationRequest {
  return transition(request, 'answered', at, { answeredAt: at.toISOString() }, detail);
}

export function markOverdue(request: CoordinationRequest, at: Date): CoordinationRequest {
  return transition(request, 'overdue', at, {});
}

export function markCancelled(request: CoordinationRequest, at: Date, reason: string): CoordinationRequest {
  return transition(request, 'cancelled', at, { cancelledAt: at.toISOString(), cancelReason: reason }, reason);
}

export function appendHistory(
  request: CoordinationRequest,
  event: RequestHistoryEntry['event'],
  at: Date,
  detail?: string,
): CoordinationRequest {
  const entry: RequestHistoryEntry = { at: at.toISOString(), event };
  if (detail !== undefined) entry.detail = detail;
  return { ...request, history: [...request.history, entry] };
}
