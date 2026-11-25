/**
 * The case state machine. Every change is an explicit function with guards. A successful change
 * returns a new `Case` (inputs are never mutated), appends a `ChangeEvent` to its history and
 * records a matching audit event through the `AuditSink` port. If the audit write fails the
 * change fails with it. A guard failure returns `{ ok: false }` and records nothing.
 */
import type {
  Actor,
  Authorization,
  Case,
  CaseId,
  CaseSeriesId,
  CaseState,
  CaseType,
  ChangeEvent,
  ChangeEventKind,
  HumanActor,
  IsoDate,
  IsoDateTime,
  Party,
  PracticeId,
  Procedure,
  ReadinessItem,
  ReadinessItemId,
  SiteOfService,
  Slot,
  SurgicalOrder,
  Team,
} from './case.js';
import type { AuditSink, CaseAuditEvent } from './ports.js';
import {
  authorizationCoverageGaps,
  isItemSatisfied,
  isReadyForSurgery,
  rebuildFinancialReadiness,
  unmetReadinessItems,
} from './readiness.js';

/**
 * Every allowed transition, `from -> to -> guard`. A transition not listed here is never allowed.
 * The guard text documents the condition each function enforces on top of the table.
 */
export const CASE_TRANSITIONS = {
  ordered: {
    intake_done: 'intake complete',
    booked: 'urgent add-on with a signed urgent order and a slot (ADR-0007); no readiness or deposit gate',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  intake_done: {
    auth_pending: 'case type is insured or mixed',
    booked: 'self-pay only; slot set; deposit confirmed when the practice requires it',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  auth_pending: {
    booked: 'slot set; prior authorization complete and valid unless self-pay; deposit confirmed when required for self-pay or mixed',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  booked: {
    ready: 'every required pre-op readiness item complete and valid through the surgery date',
    surgery_done: 'urgent add-on only',
    rescheduling: 'reason given',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  ready: {
    confirmed: 'readiness still satisfied',
    booked: 'readiness no longer satisfied (item lapsed or case type changed)',
    rescheduling: 'reason given',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  confirmed: {
    surgery_done: 'surgery performed',
    booked: 'readiness no longer satisfied (item lapsed or case type changed)',
    rescheduling: 'reason given',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  surgery_done: {
    closed: 'first post-op visit done, or 30 days after surgery, whichever comes first',
  },
  closed: {},
  blocked: {
    ordered: 'returns only to the state it was blocked from',
    intake_done: 'returns only to the state it was blocked from',
    auth_pending: 'returns only to the state it was blocked from',
    booked: 'returns to the state it was blocked from, or to Booked when blocked from Ready/Confirmed and readiness lapsed',
    ready: 'returns only to the state it was blocked from, readiness still satisfied',
    confirmed: 'returns only to the state it was blocked from, readiness still satisfied',
    rescheduling: 'returns only to the state it was blocked from',
    cancelled: 'human approver and reason',
  },
  rescheduling: {
    auth_pending: 'new dates or codes leave the authorization window (insured or mixed)',
    booked: 'new dates and codes inside the authorization window, or self-pay; slot set; deposit gate',
    blocked: 'reason given',
    cancelled: 'human approver and reason',
  },
  cancelled: {
    rescheduling: 'reopened within 90 days of cancellation; not billed again',
  },
} as const satisfies Record<CaseState, Partial<Record<CaseState, string>>>;

export function allowedTransitions(from: CaseState): CaseState[] {
  return Object.keys(CASE_TRANSITIONS[from]) as CaseState[];
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return Object.hasOwn(CASE_TRANSITIONS[from], to);
}

/** States in which a case is finished with surgery or no longer active. */
const POST_SURGERY_OR_INACTIVE: readonly CaseState[] = ['surgery_done', 'closed', 'cancelled'];

export const REOPEN_WINDOW_DAYS = 90;
export const AUTO_CLOSE_DAYS_AFTER_SURGERY = 30;
export const PHI_DELETION_DAYS_AFTER_CLOSE = 90;

/** Practice setting: whether a confirmed deposit is required before a case of this type can be booked. */
export interface BookingPolicy {
  depositRequiredBeforeBooking: { self_pay: boolean; mixed: boolean };
}

export const DEFAULT_BOOKING_POLICY: BookingPolicy = {
  depositRequiredBeforeBooking: { self_pay: true, mixed: true },
};

export interface TransitionContext {
  now: IsoDateTime;
  actor: Actor;
  audit: AuditSink;
  bookingPolicy?: BookingPolicy;
}

export type TransitionErrorCode =
  | 'transition_not_allowed'
  | 'order_not_signed'
  | 'practice_mismatch'
  | 'slot_required'
  | 'not_urgent_add_on'
  | 'not_applicable_for_case_type'
  | 'authorization_required'
  | 'authorization_not_covering'
  | 'deposit_not_confirmed'
  | 'deposit_reference_required'
  | 'readiness_incomplete'
  | 'human_approver_required'
  | 'reason_required'
  | 'reopen_window_expired'
  | 'close_not_due'
  | 'invalid_case_type_change'
  | 'readiness_item_not_found';

export interface TransitionError {
  code: TransitionErrorCode;
  message: string;
}

export type TransitionResult = { ok: true; case: Case } | { ok: false; error: TransitionError };

const fail = (code: TransitionErrorCode, message: string): TransitionResult => ({
  ok: false,
  error: { code, message },
});

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(at: IsoDateTime, days: number): IsoDateTime {
  return new Date(Date.parse(at) + days * DAY_MS).toISOString();
}

function without<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const key of keys) delete copy[key];
  return copy;
}

interface EventSpec {
  kind: ChangeEventKind;
  fromState?: CaseState;
  toState?: CaseState;
  fromCaseType?: CaseType;
  toCaseType?: CaseType;
  reason?: string;
  details?: Record<string, string | number | boolean>;
}

/** Append a change event, write the audit event, return the new case. */
async function commit(next: Case, spec: EventSpec, ctx: TransitionContext): Promise<Case> {
  const event: ChangeEvent = {
    id: `${next.id}:${next.history.length}`,
    caseId: next.id,
    at: ctx.now,
    actor: ctx.actor,
    ...spec,
  };
  const audit: CaseAuditEvent = {
    practiceId: next.practiceId,
    caseId: next.id,
    changeEventId: event.id,
    action: `case.${spec.kind}`,
    actor: ctx.actor,
    occurredAt: ctx.now,
    ...without(spec, 'kind'),
  };
  await ctx.audit.record(audit);
  return { ...next, history: [...next.history, event] };
}

interface TransitionOptions {
  reason?: string;
  details?: Record<string, string | number | boolean>;
  kind?: ChangeEventKind;
}

/** Move `next` (already patched) from `c.state` to `to`, checking the table. */
async function transition(
  c: Case,
  next: Case,
  to: CaseState,
  ctx: TransitionContext,
  opts: TransitionOptions = {},
): Promise<TransitionResult> {
  if (!canTransition(c.state, to)) {
    return fail('transition_not_allowed', `A case cannot move from ${c.state} to ${to}.`);
  }
  let moved: Case = { ...next, state: to };
  if (to === 'booked' && moved.billableAt === undefined) moved = { ...moved, billableAt: ctx.now };
  const spec: EventSpec = {
    kind: opts.kind ?? 'state_changed',
    fromState: c.state,
    toState: to,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.details !== undefined ? { details: opts.details } : {}),
  };
  return { ok: true, case: await commit(moved, spec, ctx) };
}

function requireReason(reason: string): TransitionResult | undefined {
  return reason.trim() === '' ? fail('reason_required', 'A reason is required.') : undefined;
}

function findItem(c: Case, kind: ReadinessItem['kind']): ReadinessItem | undefined {
  return c.readinessItems.find((item) => item.kind === kind);
}

/** Guards for reaching Booked, shared by every path into Booked. */
function bookingBlocker(c: Case, ctx: TransitionContext): TransitionResult | undefined {
  if (c.slot === undefined) return fail('slot_required', 'A case needs a slot before it can be booked.');
  // ADR-0007: an urgent add-on is never held back, by readiness, authorization or deposit.
  if (c.urgentAddOn) return undefined;
  if (c.caseType !== 'self_pay') {
    const auth = findItem(c, 'prior_authorization');
    if (auth?.required && !isItemSatisfied(auth, c.surgeryDate)) {
      return fail('authorization_required', 'Prior authorization must be complete before booking.');
    }
  }
  if (c.caseType !== 'insured') {
    const policy = ctx.bookingPolicy ?? DEFAULT_BOOKING_POLICY;
    const deposit = findItem(c, 'deposit');
    if (policy.depositRequiredBeforeBooking[c.caseType] && deposit?.status !== 'complete') {
      return fail('deposit_not_confirmed', 'The practice requires a confirmed deposit before booking.');
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------------

export interface NewCaseInput {
  id: CaseId;
  practiceId: PracticeId;
  order: SurgicalOrder;
  caseType: CaseType;
  seriesId?: CaseSeriesId;
  site: SiteOfService;
  surgeryDate: IsoDate;
  procedures: Procedure[];
  team: Team;
  slot?: Slot;
  parties?: Party[];
  /** Clinical items from the readiness rules (RAH-60). Financial items are added here. */
  clinicalReadinessItems?: ReadinessItem[];
}

/**
 * Create a case from a signed surgical order, in Ordered. An urgent add-on (signed urgent order)
 * moves straight on to Booked with no readiness gate.
 */
export async function createCaseFromOrder(input: NewCaseInput, ctx: TransitionContext): Promise<TransitionResult> {
  const { order } = input;
  if (order.signature === undefined) {
    return fail('order_not_signed', 'A case can only be created from a signed surgical order.');
  }
  if (order.practiceId !== input.practiceId) {
    return fail('practice_mismatch', 'The order belongs to a different practice.');
  }
  if (order.urgent && input.slot === undefined) {
    return fail('slot_required', 'An urgent add-on needs a slot so it can be booked on creation.');
  }
  const clinical = (input.clinicalReadinessItems ?? []).map((item) => ({ ...item, category: 'clinical' as const }));
  const base: Case = {
    id: input.id,
    practiceId: input.practiceId,
    order,
    caseType: input.caseType,
    ...(input.seriesId !== undefined ? { seriesId: input.seriesId } : {}),
    urgentAddOn: order.urgent,
    state: 'ordered',
    site: input.site,
    surgeryDate: input.surgeryDate,
    procedures: input.procedures,
    team: input.team,
    ...(input.slot !== undefined ? { slot: input.slot } : {}),
    authorizationIds: [],
    readinessItems: rebuildFinancialReadiness(input.id, clinical, input.caseType, order.urgent),
    parties: input.parties ?? [],
    communications: [],
    history: [],
  };
  const created = await commit(
    base,
    { kind: 'created', toState: 'ordered', toCaseType: input.caseType, details: { orderId: order.id } },
    ctx,
  );
  if (!order.urgent) return { ok: true, case: created };
  return transition(created, created, 'booked', ctx, { reason: 'urgent_add_on_signed_order' });
}

// ---------------------------------------------------------------------------------------------
// Forward path
// ---------------------------------------------------------------------------------------------

export async function completeIntake(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  return transition(c, c, 'intake_done', ctx);
}

/** Intake done -> Auth pending. Self-pay cases have nothing to authorize and book directly. */
export async function requestAuthorization(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.caseType === 'self_pay') {
    return fail('not_applicable_for_case_type', 'Self-pay cases do not need payer authorization.');
  }
  return transition(c, c, 'auth_pending', ctx);
}

/**
 * Attach an authorization that covers this case (for example one shared across a series).
 * Marks the existing prior-authorization item complete; never creates a new item.
 */
export async function linkAuthorization(
  c: Case,
  auth: Authorization,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  const gaps = authorizationCoverageGaps(auth, c);
  if (gaps.length > 0) {
    return fail('authorization_not_covering', `Authorization does not cover this case: ${gaps.join(', ')}.`);
  }
  const readinessItems = c.readinessItems.map((item) =>
    item.kind === 'prior_authorization'
      ? {
          ...item,
          status: 'complete' as const,
          completedAt: ctx.now,
          authorizationId: auth.id,
          validUntil: auth.validTo,
        }
      : item,
  );
  const authorizationIds = c.authorizationIds.includes(auth.id)
    ? c.authorizationIds
    : [...c.authorizationIds, auth.id];
  const next = await commit(
    { ...c, readinessItems, authorizationIds },
    { kind: 'authorization_linked', details: { authorizationId: auth.id } },
    ctx,
  );
  return { ok: true, case: next };
}

export interface ItemCompletion {
  validUntil?: IsoDate;
  /** External reference. Required for a deposit: the processor's confirmation ID. */
  reference?: string;
}

export async function completeReadinessItem(
  c: Case,
  itemId: ReadinessItemId,
  completion: ItemCompletion,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  const item = c.readinessItems.find((i) => i.id === itemId);
  if (item === undefined) return fail('readiness_item_not_found', `No readiness item ${itemId}.`);
  if (item.kind === 'deposit' && (completion.reference ?? '').trim() === '') {
    return fail('deposit_reference_required', "A deposit is complete only on the processor's confirmation.");
  }
  const updated: ReadinessItem = { ...item, status: 'complete', completedAt: ctx.now, ...completion };
  const next = await commit(
    { ...c, readinessItems: c.readinessItems.map((i) => (i.id === itemId ? updated : i)) },
    { kind: 'readiness_item_completed', details: { itemId, itemKind: item.kind } },
    ctx,
  );
  return { ok: true, case: next };
}

/** Intake done (self-pay), Auth pending, or Ordered (urgent add-on) -> Booked. */
export async function bookCase(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.state === 'ordered' && !c.urgentAddOn) {
    return fail('not_urgent_add_on', 'Only an urgent add-on can be booked straight from Ordered.');
  }
  if (c.state === 'intake_done' && c.caseType !== 'self_pay' && !c.urgentAddOn) {
    return fail('authorization_required', 'Insured and mixed cases go through Auth pending before booking.');
  }
  if (!canTransition(c.state, 'booked') || c.state === 'rescheduling' || c.state === 'blocked') {
    return fail('transition_not_allowed', `Use the dedicated transition to book from ${c.state}.`);
  }
  const blocker = bookingBlocker(c, ctx);
  if (blocker) return blocker;
  return transition(c, c, 'booked', ctx);
}

export async function markReady(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.state !== 'booked') return fail('transition_not_allowed', `A case cannot move from ${c.state} to ready.`);
  const unmet = unmetReadinessItems(c);
  if (unmet.length > 0) {
    return fail('readiness_incomplete', `Readiness items not complete: ${unmet.map((i) => i.kind).join(', ')}.`);
  }
  return transition(c, c, 'ready', ctx);
}

export async function confirmCase(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.state !== 'ready') return fail('transition_not_allowed', `A case cannot move from ${c.state} to confirmed.`);
  if (!isReadyForSurgery(c)) return fail('readiness_incomplete', 'Readiness is no longer satisfied.');
  return transition(c, c, 'confirmed', ctx);
}

/** Ready or Confirmed -> Booked when readiness has lapsed. Returns the case unchanged otherwise. */
export async function recheckReadiness(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if ((c.state !== 'ready' && c.state !== 'confirmed') || isReadyForSurgery(c)) return { ok: true, case: c };
  return transition(c, c, 'booked', ctx, { reason: 'readiness_lapsed' });
}

export async function recordSurgeryDone(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.state === 'booked' && !c.urgentAddOn) {
    return fail('not_urgent_add_on', 'Only an urgent add-on goes from Booked straight to surgery.');
  }
  return transition(c, { ...c, surgeryCompletedAt: ctx.now }, 'surgery_done', ctx);
}

/** The time the case closes on its own if no post-op visit happens first. */
export function autoCloseAt(c: Pick<Case, 'surgeryCompletedAt'>): IsoDateTime | undefined {
  return c.surgeryCompletedAt === undefined ? undefined : addDays(c.surgeryCompletedAt, AUTO_CLOSE_DAYS_AFTER_SURGERY);
}

/**
 * Surgery done -> Closed when the first post-op visit is done or 30 days have passed since surgery,
 * whichever comes first. Closing starts the 90-day PHI deletion clock (ADR-0005).
 */
export async function closeCase(
  c: Case,
  ctx: TransitionContext,
  opts: { firstPostOpVisitAt?: IsoDateTime } = {},
): Promise<TransitionResult> {
  if (c.state !== 'surgery_done') return fail('transition_not_allowed', `A case cannot move from ${c.state} to closed.`);
  const visitAt = opts.firstPostOpVisitAt ?? c.firstPostOpVisitAt;
  const dueAt = autoCloseAt(c);
  const due = visitAt !== undefined || (dueAt !== undefined && Date.parse(ctx.now) >= Date.parse(dueAt));
  if (!due) return fail('close_not_due', 'Close after the first post-op visit or 30 days after surgery.');
  const next: Case = {
    ...c,
    ...(visitAt !== undefined ? { firstPostOpVisitAt: visitAt } : {}),
    closedAt: ctx.now,
    phiDeletionDueAt: addDays(ctx.now, PHI_DELETION_DAYS_AFTER_CLOSE),
  };
  return transition(c, next, 'closed', ctx, {
    reason: visitAt !== undefined ? 'first_post_op_visit' : 'thirty_days_after_surgery',
  });
}

// ---------------------------------------------------------------------------------------------
// Blocked, Rescheduling, Cancelled
// ---------------------------------------------------------------------------------------------

export async function blockCase(c: Case, reason: string, ctx: TransitionContext): Promise<TransitionResult> {
  const missing = requireReason(reason);
  if (missing) return missing;
  return transition(c, { ...c, blockedFrom: c.state, blockedReason: reason }, 'blocked', ctx, { reason });
}

/**
 * Blocked -> the state it was blocked from. If that was Ready or Confirmed and readiness has
 * lapsed meanwhile, the case returns to Booked instead.
 */
export async function unblockCase(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.state !== 'blocked' || c.blockedFrom === undefined) {
    return fail('transition_not_allowed', `A case in ${c.state} is not blocked.`);
  }
  let to = c.blockedFrom;
  if ((to === 'ready' || to === 'confirmed') && !isReadyForSurgery(c)) to = 'booked';
  return transition(c, without(c, 'blockedFrom', 'blockedReason'), to, ctx, {
    reason: to === c.blockedFrom ? 'unblocked' : 'unblocked_readiness_lapsed',
  });
}

export async function startRescheduling(c: Case, reason: string, ctx: TransitionContext): Promise<TransitionResult> {
  const missing = requireReason(reason);
  if (missing) return missing;
  if (c.state === 'cancelled') {
    return fail('transition_not_allowed', 'Use reopenCancelledCase to reschedule a cancelled case.');
  }
  return transition(c, c, 'rescheduling', ctx, { reason });
}

export interface RescheduleChange {
  surgeryDate?: IsoDate;
  slot?: Slot;
  procedures?: Procedure[];
}

/**
 * Rescheduling -> Auth pending when the new dates or codes leave the linked authorization's window
 * (or the case was never authorized); otherwise -> Booked through the normal booking guards.
 */
export async function completeRescheduling(
  c: Case,
  change: RescheduleChange,
  authorizations: readonly Authorization[],
  ctx: TransitionContext,
): Promise<TransitionResult> {
  if (c.state !== 'rescheduling') {
    return fail('transition_not_allowed', `A case in ${c.state} is not being rescheduled.`);
  }
  const updated: Case = {
    ...c,
    ...(change.surgeryDate !== undefined ? { surgeryDate: change.surgeryDate } : {}),
    ...(change.slot !== undefined ? { slot: change.slot } : {}),
    ...(change.procedures !== undefined ? { procedures: change.procedures } : {}),
  };
  const details = { surgeryDate: updated.surgeryDate };
  const authItem = findItem(updated, 'prior_authorization');
  if (updated.caseType !== 'self_pay' && authItem !== undefined) {
    const linked = authorizations.find((a) => a.id === authItem.authorizationId);
    const covered =
      authItem.status === 'complete' && linked !== undefined && authorizationCoverageGaps(linked, updated).length === 0;
    if (!covered) {
      const reopened: ReadinessItem = {
        ...without(authItem, 'completedAt', 'authorizationId', 'validUntil'),
        status: 'open',
      };
      const next: Case = {
        ...updated,
        readinessItems: updated.readinessItems.map((i) => (i.id === authItem.id ? reopened : i)),
      };
      return transition(c, next, 'auth_pending', ctx, {
        kind: 'rescheduled',
        reason: 'outside_authorization_window',
        details,
      });
    }
  }
  const blocker = bookingBlocker(updated, ctx);
  if (blocker) return blocker;
  return transition(c, updated, 'booked', ctx, { kind: 'rescheduled', reason: 'inside_authorization_window', details });
}

export interface CancelRequest {
  approvedBy: Actor;
  reason: string;
}

/** Any pre-surgery state -> Cancelled. Requires a human approver. */
export async function cancelCase(c: Case, request: CancelRequest, ctx: TransitionContext): Promise<TransitionResult> {
  if (request.approvedBy.kind !== 'human') {
    return fail('human_approver_required', 'Cancelling a case requires a human approver.');
  }
  const missing = requireReason(request.reason);
  if (missing) return missing;
  const approver: HumanActor = request.approvedBy;
  return transition(c, { ...without(c, 'blockedFrom', 'blockedReason'), cancelledAt: ctx.now }, 'cancelled', ctx, {
    reason: request.reason,
    details: { approvedBy: approver.userId },
  });
}

/** Cancelled -> Rescheduling within 90 days. History is kept and the case is not billed again. */
export async function reopenCancelledCase(c: Case, ctx: TransitionContext): Promise<TransitionResult> {
  if (c.state !== 'cancelled' || c.cancelledAt === undefined) {
    return fail('transition_not_allowed', `A case in ${c.state} is not cancelled.`);
  }
  if (Date.parse(ctx.now) > Date.parse(addDays(c.cancelledAt, REOPEN_WINDOW_DAYS))) {
    return fail('reopen_window_expired', 'A cancelled case can only be reopened within 90 days.');
  }
  return transition(c, without(c, 'cancelledAt'), 'rescheduling', ctx, {
    reason: 'reopened',
    details: { cancelledAt: c.cancelledAt },
  });
}

// ---------------------------------------------------------------------------------------------
// Case type
// ---------------------------------------------------------------------------------------------

export interface CaseTypeChange {
  to: CaseType;
  reason: string;
  /** For a change to mixed: the procedures with their billing. Ignored otherwise. */
  procedures?: Procedure[];
}

/**
 * Change the case type in place (for example insured -> self-pay after a denial). Rebuilds the
 * financial readiness items and records a change event. A case in Ready or Confirmed whose
 * readiness is no longer satisfied drops back to Booked.
 */
export async function changeCaseType(
  c: Case,
  change: CaseTypeChange,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  if (POST_SURGERY_OR_INACTIVE.includes(c.state)) {
    return fail('invalid_case_type_change', `The case type cannot change in ${c.state}.`);
  }
  if (change.to === c.caseType) return fail('invalid_case_type_change', `The case is already ${c.caseType}.`);
  const missing = requireReason(change.reason);
  if (missing) return missing;
  let procedures: Procedure[];
  if (change.to === 'mixed') {
    procedures = change.procedures ?? c.procedures;
    const kinds = new Set(procedures.map((p) => p.billing));
    if (!kinds.has('insured') || !kinds.has('self_pay')) {
      return fail('invalid_case_type_change', 'A mixed case needs at least one insured and one self-pay procedure.');
    }
  } else {
    const billing = change.to;
    procedures = c.procedures.map((p) => ({ ...p, billing }));
  }
  const next: Case = {
    ...c,
    caseType: change.to,
    procedures,
    readinessItems: rebuildFinancialReadiness(c.id, c.readinessItems, change.to, c.urgentAddOn),
  };
  const changed = await commit(
    next,
    { kind: 'case_type_changed', fromCaseType: c.caseType, toCaseType: change.to, reason: change.reason },
    ctx,
  );
  return recheckReadiness(changed, ctx);
}
