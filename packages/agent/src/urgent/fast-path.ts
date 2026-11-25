/**
 * Urgent add-on fast path (RAH-92, ADR-0007).
 *
 * The surgeon's signed urgent order is the approval. Once the date, side and procedure checks pass, the agent
 * books immediately (office procedure room or ASC electronic channel), moves the case Ordered to Booked with no
 * readiness gate, marks it billable, notifies (does not ask) the scheduler, sends the compressed urgent journey,
 * and books the post-op visit. After surgery it opens a retro-authorization item. There is no after-hours
 * paging: every fallback is a pinned urgent Today item. The deposit gate is not consulted on this path.
 */
import { checkAscAddOn, submitAscAddOn, type AscCallReason, type AscCallTask } from './asc-add-on.js';
import type { UrgentAddOnConfig } from './config.js';
import { bookOfficeRoom } from './office-room.js';
import type {
  AuditDetail,
  PracticeId,
  RoomSlot,
  SignedUrgentOrder,
  TodayItem,
  UrgentAddOnDeps,
  UrgentAddOnRecord,
  UrgentBooking,
} from './ports.js';
import { verifyUrgentOrder, type VerificationIssue } from './verify-order.js';

export interface UrgentAddOnInput {
  readonly practiceId: PracticeId;
  readonly caseId: string;
  readonly orderId: string;
}

export type UrgentAddOnResult =
  | { readonly status: 'feature_disabled' }
  | { readonly status: 'already_handled'; readonly record: UrgentAddOnRecord }
  | { readonly status: 'blocked'; readonly issues: readonly VerificationIssue[]; readonly escalationItemId: string }
  | { readonly status: 'booked'; readonly record: UrgentAddOnRecord }
  | { readonly status: 'room_full'; readonly offeredSlots: readonly RoomSlot[]; readonly todayItemId: string }
  | { readonly status: 'awaiting_asc_confirmation'; readonly submissionId: string; readonly confirmBy: string }
  | {
      readonly status: 'asc_call_task';
      readonly todayItemId: string;
      readonly phoneNumber: string | null;
      readonly reason: AscCallReason;
    };

export type AscConfirmationResult =
  | { readonly status: 'not_pending'; readonly record: UrgentAddOnRecord | null }
  | Extract<UrgentAddOnResult, { status: 'booked' | 'awaiting_asc_confirmation' | 'asc_call_task' }>;

export type RetroAuthorizationResult =
  | { readonly status: 'not_booked'; readonly record: UrgentAddOnRecord | null }
  | { readonly status: 'opened'; readonly itemId: string; readonly dueBy: string | null }
  | { readonly status: 'not_required' }
  | { readonly status: 'already_opened'; readonly record: UrgentAddOnRecord };

async function audit(deps: UrgentAddOnDeps, practiceId: PracticeId, caseId: string, action: string, detail: AuditDetail): Promise<void> {
  await deps.audit.record({ practiceId, caseId, action, at: deps.clock.now(), detail });
}

async function pinUrgent(deps: UrgentAddOnDeps, item: Omit<TodayItem, 'priority' | 'pinned' | 'assigneeRole'>): Promise<string> {
  const { itemId } = await deps.today.createItem({ ...item, priority: 'urgent', pinned: true, assigneeRole: 'scheduler' });
  return itemId;
}

async function block(
  deps: UrgentAddOnDeps,
  input: UrgentAddOnInput,
  issues: readonly VerificationIssue[],
  order: SignedUrgentOrder | null,
): Promise<UrgentAddOnResult> {
  const escalationItemId = await pinUrgent(deps, {
    practiceId: input.practiceId,
    caseId: input.caseId,
    kind: 'urgent_order_blocked',
    title: 'Urgent add-on not booked: signed order needs review',
    detail: issues.map((i) => i.message).join(' '),
  });
  if (order !== null) {
    await deps.store.save({
      practiceId: input.practiceId,
      caseId: input.caseId,
      orderId: input.orderId,
      order,
      status: 'blocked',
      todayItemIds: [escalationItemId],
    });
  }
  await audit(deps, input.practiceId, input.caseId, 'urgent_add_on.blocked', {
    orderId: input.orderId,
    issues: issues.map((i) => i.code).join(','),
    escalationItemId,
  });
  return { status: 'blocked', issues, escalationItemId };
}

async function completeBooking(
  deps: UrgentAddOnDeps,
  record: Omit<UrgentAddOnRecord, 'status' | 'booking'>,
  booked: Omit<UrgentBooking, 'postOpAppointmentId'>,
): Promise<UrgentAddOnRecord> {
  const { order } = record;
  const { practiceId, caseId } = order;
  await deps.caseState.transition({
    practiceId,
    caseId,
    from: 'ordered',
    to: 'booked',
    readinessGate: 'bypassed_urgent_add_on',
    reason: `Urgent add-on approved by signed order ${order.orderId}`,
  });
  await deps.caseState.setBillable({ practiceId, caseId, reason: 'Urgent add-on booked' });
  await deps.scheduler.notify({
    practiceId,
    caseId,
    kind: 'urgent_add_on_booked',
    responseRequired: false,
    message:
      `Urgent add-on booked on the surgeon's signed order: ${order.procedure.description} (${order.side}) ` +
      `at ${booked.start}, ${booked.where === 'asc' ? 'ASC' : 'office procedure room'} reference ${booked.reference}. No action needed.`,
  });
  const recipients = await deps.messaging.getAuthorizedRecipients(practiceId, order.patientId);
  for (const recipient of recipients) {
    await deps.messaging.sendJourney({
      practiceId,
      caseId,
      recipientId: recipient.recipientId,
      journey: 'urgent_compressed',
      surgeryStart: booked.start,
    });
  }
  const postOp = await deps.postOp.bookPostOpVisit({
    practiceId,
    caseId,
    patientId: order.patientId,
    surgeonId: order.surgeonId,
    surgeryStart: booked.start,
  });
  const todayItemIds = [...record.todayItemIds];
  if (postOp === null) {
    const { itemId } = await deps.today.createItem({
      practiceId,
      caseId,
      kind: 'post_op_visit_needed',
      priority: 'normal',
      pinned: false,
      assigneeRole: 'scheduler',
      title: 'Book the post-op visit for an urgent add-on',
      detail: `No post-op visit slot was available after the urgent add-on at ${booked.start}.`,
    });
    todayItemIds.push(itemId);
  }
  const saved: UrgentAddOnRecord = {
    ...record,
    status: 'booked',
    booking: { ...booked, postOpAppointmentId: postOp?.appointmentId ?? null },
    todayItemIds,
  };
  await deps.store.save(saved);
  await audit(deps, practiceId, caseId, 'urgent_add_on.booked', {
    orderId: order.orderId,
    where: booked.where,
    reference: booked.reference,
    start: booked.start,
    journeyRecipients: recipients.length,
    postOpAppointmentId: postOp?.appointmentId ?? null,
  });
  return saved;
}

async function createAscCallTask(
  deps: UrgentAddOnDeps,
  record: Omit<UrgentAddOnRecord, 'status'>,
  call: AscCallTask,
): Promise<Extract<UrgentAddOnResult, { status: 'asc_call_task' }>> {
  const { practiceId, caseId } = record;
  const todayItemId = await pinUrgent(deps, {
    practiceId,
    caseId,
    kind: 'urgent_asc_call',
    title: `Call ${call.facilityName ?? 'the ASC'} to book an urgent add-on`,
    detail: call.detail,
    ...(call.phoneNumber === null ? {} : { phoneNumber: call.phoneNumber }),
  });
  await deps.store.save({ ...record, status: 'asc_call_task', todayItemIds: [...record.todayItemIds, todayItemId] });
  await audit(deps, practiceId, caseId, 'urgent_add_on.asc_call_task', { orderId: record.orderId, reason: call.reason, todayItemId });
  return { status: 'asc_call_task', todayItemId, phoneNumber: call.phoneNumber, reason: call.reason };
}

/** Handles a signed urgent order as it arrives. Safe to call again for the same case: it never books twice. */
export async function bookUrgentAddOn(
  deps: UrgentAddOnDeps,
  config: UrgentAddOnConfig,
  input: UrgentAddOnInput,
): Promise<UrgentAddOnResult> {
  if (!config.enabled) return { status: 'feature_disabled' };

  const existing = await deps.store.get(input.practiceId, input.caseId);
  if (existing !== null) return { status: 'already_handled', record: existing };

  const order = await deps.intake.getSignedOrder(input.practiceId, input.orderId);
  if (order === null) {
    return block(deps, input, [{ code: 'order_not_found', message: `Signed order ${input.orderId} was not found.` }], null);
  }
  const request = await deps.intake.getCaseRequest(input.practiceId, input.caseId);
  if (request === null) {
    return block(deps, input, [{ code: 'case_request_not_found', message: `Case ${input.caseId} was not found.` }], order);
  }

  const now = deps.clock.now();
  const issues = [...verifyUrgentOrder(order, request, now)];
  const state = await deps.caseState.getState(input.practiceId, input.caseId);
  if (state !== 'ordered') {
    issues.push({ code: 'case_not_ordered', message: `Case is in state ${state ?? 'unknown'}, not Ordered.` });
  }
  if (issues.length > 0) return block(deps, input, issues, order);

  const decision = await deps.policy.evaluate({
    practiceId: input.practiceId,
    caseId: input.caseId,
    action: 'book_urgent_add_on',
    // verifyUrgentOrder guarantees the signature is present here.
    approval: { kind: 'signed_urgent_order', orderId: order.orderId, signedBy: order.signature?.signedBy ?? '' },
  });
  if (decision.outcome === 'block') {
    return block(deps, input, [{ code: 'policy_block', message: `Policy blocked the urgent add-on: ${decision.reason}` }], order);
  }

  const base = { practiceId: input.practiceId, caseId: input.caseId, orderId: input.orderId, order, todayItemIds: [] as string[] };

  if (order.siteOfService.kind === 'office') {
    const outcome = await bookOfficeRoom(deps.officeSchedule, order, now, config.offeredSlotCount);
    if (outcome.kind === 'booked') {
      const record = await completeBooking(deps, base, {
        start: outcome.slot.start,
        reference: outcome.appointmentId,
        where: 'office_room',
      });
      return { status: 'booked', record };
    }
    const offered = outcome.offeredSlots;
    const todayItemId = await pinUrgent(deps, {
      practiceId: input.practiceId,
      caseId: input.caseId,
      kind: 'urgent_room_full',
      title: 'Urgent add-on: procedure room is full on the ordered date',
      detail:
        offered.length > 0
          ? `No open slot on ${order.date}. Next open slots: ${offered.map((s) => s.start).join(', ')}. No scheduled case was moved.`
          : `No open slot on ${order.date} and none found after it. No scheduled case was moved.`,
      offeredSlots: offered,
    });
    await deps.store.save({ ...base, status: 'room_full', todayItemIds: [todayItemId] });
    await audit(deps, input.practiceId, input.caseId, 'urgent_add_on.room_full', {
      orderId: order.orderId,
      offeredSlots: offered.length,
      todayItemId,
    });
    return { status: 'room_full', offeredSlots: offered, todayItemId };
  }

  const submitted = await submitAscAddOn(deps.ascDirectory, deps.ascChannel, order, now, config.confirmTimeoutMinutes);
  if (submitted.kind === 'call_task') return createAscCallTask(deps, base, submitted);
  const confirmBy = submitted.confirmBy.toISOString();
  await deps.store.save({ ...base, status: 'awaiting_asc_confirmation', submissionId: submitted.submissionId, confirmBy });
  await audit(deps, input.practiceId, input.caseId, 'urgent_add_on.asc_submitted', {
    orderId: order.orderId,
    submissionId: submitted.submissionId,
    confirmBy,
  });
  return { status: 'awaiting_asc_confirmation', submissionId: submitted.submissionId, confirmBy };
}

/**
 * Checks an ASC submission: called on a confirmation event and by the worker's poll. Books on confirmation;
 * after the confirm-by time with no confirmation, creates one urgent call task. A confirmation that arrives
 * after the call task was created still completes the booking.
 */
export async function checkAscConfirmation(
  deps: UrgentAddOnDeps,
  input: { readonly practiceId: PracticeId; readonly caseId: string },
): Promise<AscConfirmationResult> {
  const record = await deps.store.get(input.practiceId, input.caseId);
  if (
    record === null ||
    record.submissionId === undefined ||
    record.confirmBy === undefined ||
    (record.status !== 'awaiting_asc_confirmation' && record.status !== 'asc_call_task')
  ) {
    return { status: 'not_pending', record };
  }
  const outcome = await checkAscAddOn(
    deps.ascDirectory,
    deps.ascChannel,
    record.order,
    record.submissionId,
    new Date(record.confirmBy),
    deps.clock.now(),
  );
  if (outcome.kind === 'confirmed') {
    const saved = await completeBooking(deps, record, {
      start: outcome.start,
      reference: outcome.confirmationNumber,
      where: 'asc',
    });
    return { status: 'booked', record: saved };
  }
  if (record.status === 'asc_call_task') return { status: 'not_pending', record };
  if (outcome.kind === 'pending') {
    return { status: 'awaiting_asc_confirmation', submissionId: record.submissionId, confirmBy: record.confirmBy };
  }
  return createAscCallTask(deps, record, outcome);
}

/**
 * After surgery, opens a retro-authorization item due by the payer's notification deadline, approve-first by
 * the auth specialist. Self-pay cases need none.
 */
export async function onSurgeryCompleted(
  deps: UrgentAddOnDeps,
  input: { readonly practiceId: PracticeId; readonly caseId: string; readonly completedAt: Date },
): Promise<RetroAuthorizationResult> {
  const record = await deps.store.get(input.practiceId, input.caseId);
  if (record === null || record.status !== 'booked') return { status: 'not_booked', record };
  if (record.retroAuthorization !== undefined) return { status: 'already_opened', record };

  const { order } = record;
  if (order.payer === null) {
    await deps.store.save({ ...record, retroAuthorization: { status: 'not_required' } });
    await audit(deps, input.practiceId, input.caseId, 'urgent_add_on.retro_auth_not_required', { orderId: order.orderId });
    return { status: 'not_required' };
  }
  const dueBy = await deps.authorization.getRetroNotificationDeadline({
    practiceId: input.practiceId,
    payerId: order.payer.payerId,
    procedureCode: order.procedure.code,
    performedAt: input.completedAt,
  });
  const { itemId } = await deps.authorization.openRetroAuthorization({
    practiceId: input.practiceId,
    caseId: input.caseId,
    payerId: order.payer.payerId,
    procedureCode: order.procedure.code,
    performedAt: input.completedAt,
    dueBy,
    approvalMode: 'approve_first',
    assigneeRole: 'auth_specialist',
  });
  await deps.store.save({ ...record, retroAuthorization: { status: 'opened', itemId } });
  const due = dueBy?.toISOString() ?? null;
  await audit(deps, input.practiceId, input.caseId, 'urgent_add_on.retro_auth_opened', {
    orderId: order.orderId,
    payerId: order.payer.payerId,
    itemId,
    dueBy: due,
  });
  return { status: 'opened', itemId, dueBy: due };
}
