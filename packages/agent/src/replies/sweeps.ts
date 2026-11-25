import type { CaseDirectory, Clock, PendingChangeStore, ReviewQueue, TaskQueue } from './ports.js';

export const DEFAULT_CONFIRM_NO_REPLY_HOURS = 24;

/** Parses CONFIRM_NO_REPLY_HOURS. Falls back to 24 for missing or invalid values. */
export function parseConfirmNoReplyHours(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIRM_NO_REPLY_HOURS;
}

export interface NoReplyDeps {
  cases: CaseDirectory;
  tasks: TaskQueue;
  clock: Clock;
  /** CONFIRM_NO_REPLY_HOURS. */
  noReplyHours: number;
}

/**
 * Creates a scheduler call task for each 72-hour confirmation with no reply (of any kind) within
 * `noReplyHours`. Idempotent per confirmation. Returns the number of tasks requested.
 */
export async function createNoReplyCallTasks(deps: NoReplyDeps, practiceId: string): Promise<number> {
  const now = deps.clock.now().getTime();
  const waitMs = deps.noReplyHours * 3_600_000;
  let created = 0;
  for (const c of await deps.cases.listAwaitingConfirmation(practiceId)) {
    if (!c.confirmationSentAt || c.confirmedAt || c.repliedAt) continue;
    if (now - c.confirmationSentAt.getTime() < waitMs) continue;
    await deps.tasks.createTask({
      practiceId,
      caseId: c.caseId,
      kind: 'confirm_no_reply_call',
      priority: 'normal',
      summary: `No reply to the confirmation within ${deps.noReplyHours} hours. Call the patient.`,
      dedupeKey: `noreply:${c.caseId}:${c.confirmationSentAt.toISOString()}`,
    });
    created += 1;
  }
  return created;
}

export interface PickDeps {
  pending: PendingChangeStore;
  reviewQueue: ReviewQueue;
  clock: Clock;
}

export type PickResult = 'submitted' | 'not_found' | 'expired' | 'already_closed' | 'invalid_slot';

/**
 * Called by the case-page picker when the patient chooses one of the three offered slots. The pick
 * becomes a change plan in the review queue; nothing is rescheduled here.
 */
export async function recordSlotPick(
  deps: PickDeps,
  input: { practiceId: string; requestId: string; slotId: string },
): Promise<PickResult> {
  const p = await deps.pending.get(input.requestId);
  // A request from another practice is indistinguishable from a missing one.
  if (!p || p.practiceId !== input.practiceId) return 'not_found';
  if (p.status !== 'open') return 'already_closed';
  if (deps.clock.now() >= p.expiresAt) return 'expired';
  if (!p.slotIds.includes(input.slotId)) return 'invalid_slot';
  if (!(await deps.pending.close(p.requestId, 'picked'))) return 'already_closed';
  await deps.reviewQueue.submitChangePlan({
    practiceId: p.practiceId,
    caseId: p.caseId,
    requestId: p.requestId,
    slotId: input.slotId,
    patientWords: p.patientWords,
  });
  return 'submitted';
}

/** Sends change requests with no pick after 24 hours to the review queue with the patient's words. */
export async function expireChangeRequests(deps: PickDeps): Promise<number> {
  let expired = 0;
  for (const p of await deps.pending.listOpenExpiringBy(deps.clock.now())) {
    if (!(await deps.pending.close(p.requestId, 'expired'))) continue;
    await deps.reviewQueue.submitChangeRequest({
      practiceId: p.practiceId,
      caseId: p.caseId,
      requestId: p.requestId,
      patientWords: p.patientWords,
      reason: 'no_pick_within_window',
    });
    expired += 1;
  }
  return expired;
}
