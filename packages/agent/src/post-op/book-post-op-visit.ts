import {
  DEFAULT_POST_OP_WINDOW,
  type OpenSlot,
  type PostOpDeps,
  type PostOpVisit,
  type PracticeId,
} from './ports.js';

export interface PostOpCase {
  practiceId: PracticeId;
  /** Each case in a case series has its own caseId and gets its own visit. */
  caseId: string;
  surgeonId: string;
  assistantId?: string;
  followUpLocationId: string;
  /** Local date, YYYY-MM-DD. */
  surgeryDate: string;
  /** Urgent add-ons are booked exactly like scheduled cases. */
  urgent?: boolean;
}

export type PostOpOutcome =
  | { status: 'booked'; visit: PostOpVisit; existing: boolean }
  | { status: 'rescheduled'; visit: PostOpVisit }
  | { status: 'cancelled'; visit: PostOpVisit }
  | { status: 'no_visit' }
  | { status: 'pending_approval' }
  | { status: 'task_created'; reason: 'no_slot' | 'unsupported' | 'move_failed' }
  | { status: 'disabled' };

const DAY_MS = 86_400_000;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

const slotDate = (s: OpenSlot): string => s.startsAt.slice(0, 10);

/** Nearest to the preferred offset first, earlier slot on ties, so results are deterministic. */
function rank(slots: OpenSlot[], surgeryDate: string, preferredOffset: number): OpenSlot[] {
  return [...slots].sort((a, b) => {
    const da = Math.abs(daysBetween(surgeryDate, slotDate(a)) - preferredOffset);
    const db = Math.abs(daysBetween(surgeryDate, slotDate(b)) - preferredOffset);
    return da - db || a.startsAt.localeCompare(b.startsAt);
  });
}

async function resolveWindow(deps: PostOpDeps, c: PostOpCase) {
  const w = await deps.settings.postOpWindow({ practiceId: c.practiceId, surgeonId: c.surgeonId });
  return w ?? DEFAULT_POST_OP_WINDOW;
}

async function searchWindow(deps: PostOpDeps, c: PostOpCase, minDays: number, maxDays: number) {
  const res = await deps.connector.findOpenSlots({
    practiceId: c.practiceId,
    providerIds: c.assistantId ? [c.surgeonId, c.assistantId] : [c.surgeonId],
    locationId: c.followUpLocationId,
    fromDate: addDays(c.surgeryDate, minDays),
    toDate: addDays(c.surgeryDate, maxDays),
  });
  if (res.kind === 'unsupported') return res;
  // Defensive: never trust the connector to honour the window or location.
  const slots = res.slots.filter((s) => {
    const off = daysBetween(c.surgeryDate, slotDate(s));
    return off >= minDays && off <= maxDays && s.locationId === c.followUpLocationId;
  });
  return { kind: 'slots' as const, slots };
}

const inFlight = new Map<string, Promise<PostOpOutcome>>();

/** Serialize operations per case so concurrent calls cannot double-book. */
function serialized(c: { practiceId: string; caseId: string }, fn: () => Promise<PostOpOutcome>) {
  const key = `${c.practiceId}:${c.caseId}`;
  const prev = inFlight.get(key) ?? Promise.resolve(undefined);
  const next: Promise<PostOpOutcome> = prev
    .then(fn, fn)
    .finally(() => {
      if (inFlight.get(key) === next) inFlight.delete(key);
    });
  inFlight.set(key, next);
  return next;
}

async function task(
  deps: PostOpDeps,
  c: Pick<PostOpCase, 'practiceId' | 'caseId'>,
  kind: 'post_op_no_slot' | 'post_op_appointments_unsupported' | 'post_op_move_failed',
  reason: string,
) {
  await deps.tasks.createTask({
    practiceId: c.practiceId,
    caseId: c.caseId,
    // A connector that cannot do appointments is a practice-setup problem for the workspace.
    target: kind === 'post_op_appointments_unsupported' ? 'workspace' : 'scheduler',
    kind,
    reason,
  });
  await deps.audit.record({ practiceId: c.practiceId, caseId: c.caseId, action: kind });
}

const unsupportedReason = (ehr: string, verb: string) =>
  `Appointments are not supported for ${ehr}; ${verb} the post-op visit manually.`;

/** Book the post-op visit once the surgery date is set. Idempotent per case. */
export function bookPostOpVisit(deps: PostOpDeps, c: PostOpCase): Promise<PostOpOutcome> {
  return serialized(c, () => doBook(deps, c));
}

async function doBook(deps: PostOpDeps, c: PostOpCase): Promise<PostOpOutcome> {
  if (!deps.enabled) return { status: 'disabled' };
  const existing = await deps.visits.get(c.practiceId, c.caseId);
  if (existing?.status === 'booked') return { status: 'booked', visit: existing, existing: true };

  const { minDays, maxDays } = await resolveWindow(deps, c);
  const search = await searchWindow(deps, c, minDays, maxDays);
  if (search.kind === 'unsupported') {
    await task(deps, c, 'post_op_appointments_unsupported', unsupportedReason(search.ehr, 'book'));
    return { status: 'task_created', reason: 'unsupported' };
  }
  const candidates = rank(search.slots, c.surgeryDate, Math.round((minDays + maxDays) / 2));
  if (candidates.length === 0) {
    await task(
      deps,
      c,
      'post_op_no_slot',
      `No open slot ${minDays}-${maxDays} days after surgery on ${c.surgeryDate} with the surgeon or assistant at the follow-up location.`,
    );
    return { status: 'task_created', reason: 'no_slot' };
  }

  const decision = await deps.policy.decide({
    practiceId: c.practiceId,
    action: 'book_post_op_visit',
    caseId: c.caseId,
  });
  if (decision === 'approve_first') {
    await deps.tasks.createTask({
      practiceId: c.practiceId,
      caseId: c.caseId,
      target: 'scheduler',
      kind: 'post_op_approval',
      reason: 'Approve booking this post-op visit.',
      proposedSlot: candidates[0]!,
    });
    await deps.audit.record({ practiceId: c.practiceId, caseId: c.caseId, action: 'post_op_approval_requested' });
    return { status: 'pending_approval' };
  }

  for (const slot of candidates) {
    const res = await deps.connector.bookAppointment({
      practiceId: c.practiceId,
      slot,
      caseId: c.caseId,
      idempotencyKey: `post-op:${c.practiceId}:${c.caseId}`,
    });
    if (res.kind === 'slot_taken') continue;
    if (res.kind === 'unsupported') {
      await task(deps, c, 'post_op_appointments_unsupported', unsupportedReason(res.ehr, 'book'));
      return { status: 'task_created', reason: 'unsupported' };
    }
    const visit: PostOpVisit = {
      practiceId: c.practiceId,
      caseId: c.caseId,
      appointmentId: res.appointmentId,
      locationId: slot.locationId,
      providerId: slot.providerId,
      startsAt: slot.startsAt,
      surgeryDate: c.surgeryDate,
      offsetDays: daysBetween(c.surgeryDate, slotDate(slot)),
      status: 'booked',
    };
    await deps.visits.save(visit);
    await deps.audit.record({ practiceId: c.practiceId, caseId: c.caseId, action: 'post_op_booked' });
    return { status: 'booked', visit, existing: false };
  }
  // Every candidate was taken between search and booking.
  await task(deps, c, 'post_op_no_slot', 'All open slots were taken while booking; pick another time.');
  return { status: 'task_created', reason: 'no_slot' };
}

/** Surgery moved: move the visit by the same offset from the new surgery date. */
export function reschedulePostOpVisit(deps: PostOpDeps, c: PostOpCase): Promise<PostOpOutcome> {
  return serialized(c, () => doReschedule(deps, c));
}

async function doReschedule(deps: PostOpDeps, c: PostOpCase): Promise<PostOpOutcome> {
  if (!deps.enabled) return { status: 'disabled' };
  const visit = await deps.visits.get(c.practiceId, c.caseId);
  if (visit?.status !== 'booked') return doBook(deps, c);
  if (visit.surgeryDate === c.surgeryDate) return { status: 'rescheduled', visit };

  const target = addDays(c.surgeryDate, visit.offsetDays);
  const { minDays, maxDays } = await resolveWindow(deps, c);
  const search = await searchWindow(deps, c, minDays, maxDays);
  if (search.kind === 'unsupported') {
    await task(deps, c, 'post_op_appointments_unsupported', unsupportedReason(search.ehr, 'move'));
    return { status: 'task_created', reason: 'unsupported' };
  }
  const onTarget = search.slots.filter((s) => slotDate(s) === target);
  const candidates = rank(onTarget.length > 0 ? onTarget : search.slots, c.surgeryDate, visit.offsetDays);
  for (const slot of candidates) {
    const res = await deps.connector.moveAppointment({
      practiceId: c.practiceId,
      appointmentId: visit.appointmentId,
      slot,
    });
    if (res.kind === 'slot_taken') continue;
    if (res.kind === 'ok') {
      const moved: PostOpVisit = {
        ...visit,
        locationId: slot.locationId,
        providerId: slot.providerId,
        startsAt: slot.startsAt,
        surgeryDate: c.surgeryDate,
        offsetDays: daysBetween(c.surgeryDate, slotDate(slot)),
      };
      await deps.visits.save(moved);
      await deps.audit.record({ practiceId: c.practiceId, caseId: c.caseId, action: 'post_op_rescheduled' });
      return { status: 'rescheduled', visit: moved };
    }
    break;
  }
  // The old visit stays in place; a person decides. We never book outside the window.
  await task(
    deps,
    c,
    'post_op_move_failed',
    `Could not move the post-op visit to ${target} (same offset after the new surgery date); the existing visit is unchanged.`,
  );
  return { status: 'task_created', reason: 'move_failed' };
}

/** Surgery cancelled: cancel the visit. */
export function cancelPostOpVisit(
  deps: PostOpDeps,
  c: Pick<PostOpCase, 'practiceId' | 'caseId'>,
): Promise<PostOpOutcome> {
  return serialized(c, async () => {
    if (!deps.enabled) return { status: 'disabled' };
    const visit = await deps.visits.get(c.practiceId, c.caseId);
    if (visit?.status !== 'booked') return { status: 'no_visit' };
    const res = await deps.connector.cancelAppointment({
      practiceId: c.practiceId,
      appointmentId: visit.appointmentId,
    });
    if (res.kind === 'unsupported') {
      await task(deps, c, 'post_op_appointments_unsupported', unsupportedReason(res.ehr, 'cancel'));
      return { status: 'task_created', reason: 'unsupported' };
    }
    const cancelled: PostOpVisit = { ...visit, status: 'cancelled' };
    await deps.visits.save(cancelled);
    await deps.audit.record({ practiceId: c.practiceId, caseId: c.caseId, action: 'post_op_cancelled' });
    return { status: 'cancelled', visit: cancelled };
  });
}
