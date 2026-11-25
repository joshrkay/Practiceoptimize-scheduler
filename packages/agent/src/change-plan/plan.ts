/**
 * Change plan builder and approval (RAH-57).
 *
 * `buildChangePlan` turns one change request into one proposed plan covering every affected case: the case
 * that changed, the later cases of its series (moved to keep their spacing), or every case on a surgeon's
 * cancelled day. It only reads. `approveChangePlan` records the single scheduler approval that execution needs.
 */
import { computeCancellationEffect, computeMoveEffect, DAY_MS, addMs, diffMs, type ComputedEffect } from './impact.js';
import type { Approver, CaseSnapshot, ChangePlan, ChangeRequest, IsoDateTime, PracticeId, Slot } from './model.js';
import type { PlanningPorts } from './ports.js';

export const RESCHEDULE_CASCADE_FLAG = 'FEATURE_RESCHEDULE_CASCADE';

/** The cascade is off unless `FEATURE_RESCHEDULE_CASCADE` is exactly "true". */
export function isRescheduleCascadeEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[RESCHEDULE_CASCADE_FLAG] === 'true';
}

export class ChangePlanError extends Error {
  constructor(
    readonly code:
      | 'feature_disabled'
      | 'case_not_found'
      | 'case_not_active'
      | 'no_cases_affected'
      | 'invalid_status'
      | 'already_approved'
      | 'blocked'
      | 'human_approver_required'
      | 'not_approved',
    message: string,
  ) {
    super(message);
    this.name = 'ChangePlanError';
  }
}

export interface BuildOptions {
  readonly featureEnabled: boolean;
}

function assertEnabled(featureEnabled: boolean): void {
  if (!featureEnabled) {
    throw new ChangePlanError('feature_disabled', `${RESCHEDULE_CASCADE_FLAG} is off for this practice.`);
  }
}

async function loadActiveCase(ports: PlanningPorts, practiceId: PracticeId, caseId: string): Promise<CaseSnapshot> {
  const c = await ports.cases.getCase(practiceId, caseId);
  if (!c || c.practiceId !== practiceId) {
    throw new ChangePlanError('case_not_found', `Case ${caseId} was not found in this practice.`);
  }
  if (c.status === 'Cancelled') {
    throw new ChangePlanError('case_not_active', `Case ${caseId} is cancelled and cannot be changed.`);
  }
  return c;
}

/** Picks the best slot the finder returns that no other case in this plan has taken. */
function pickSlot(slots: readonly Slot[], taken: Set<string>): Slot | undefined {
  const slot = slots.find((s) => !taken.has(s.slotId));
  if (slot) taken.add(slot.slotId);
  return slot;
}

interface Builder {
  readonly ports: PlanningPorts;
  readonly now: IsoDateTime;
  readonly taken: Set<string>;
  readonly planned: Set<string>;
  readonly effects: ComputedEffect[];
}

async function findSlot(
  b: Builder,
  c: CaseSnapshot,
  overrides: {
    readonly preferredStart: IsoDateTime;
    readonly earliestStart?: IsoDateTime;
    readonly surgeonId?: string;
    readonly facilityId?: string;
    readonly siteOfService?: Slot['siteOfService'];
    readonly durationMinutes?: number;
    readonly excludeDates?: readonly string[];
  },
): Promise<Slot | undefined> {
  const slots = await b.ports.slots.findSlots({
    practiceId: c.practiceId,
    caseId: c.caseId,
    surgeonId: overrides.surgeonId ?? c.surgeonId,
    facilityId: overrides.facilityId ?? c.facilityId,
    siteOfService: overrides.siteOfService ?? c.siteOfService,
    durationMinutes: overrides.durationMinutes ?? c.procedure.durationMinutes,
    earliestStart: overrides.earliestStart ?? b.now,
    preferredStart: overrides.preferredStart,
    ...(overrides.excludeDates ? { excludeDates: overrides.excludeDates } : {}),
  });
  return pickSlot(slots, b.taken);
}

/**
 * When a series case moves, propose moving each later case by the same amount so the planned spacing holds.
 * Later cases already in the plan are left alone.
 */
async function addSeriesFollowers(b: Builder, moved: CaseSnapshot, newSlot: Slot | undefined): Promise<void> {
  if (!moved.series || !newSlot) return;
  const delta = diffMs(newSlot.start, moved.scheduledStart);
  if (delta === 0) return;

  const series = await b.ports.cases.listSeries(moved.practiceId, moved.series.seriesId);
  const later = series
    .filter((s) => s.series && s.series.position > (moved.series?.position ?? 0) && s.status !== 'Cancelled')
    .sort((x, y) => (x.series?.position ?? 0) - (y.series?.position ?? 0));

  let previousStart = newSlot.start;
  for (const follower of later) {
    if (b.planned.has(follower.caseId)) continue;
    b.planned.add(follower.caseId);
    const preferredStart = addMs(follower.scheduledStart, delta);
    const slot = await findSlot(b, follower, {
      preferredStart,
      earliestStart: addMs(previousStart, 1),
    });
    const days = Math.round(delta / DAY_MS);
    b.effects.push(
      await computeMoveEffect(
        follower,
        {
          slot,
          procedure: follower.procedure,
          surgeonId: follower.surgeonId,
          reason: 'series_spacing',
          notes: [
            `Proposed to keep series ${moved.series.seriesId} spacing after case ${moved.caseId} moved ${days} day(s).`,
          ],
        },
        b.ports,
      ),
    );
    if (slot) previousStart = slot.start;
  }
}

async function planMove(
  b: Builder,
  c: CaseSnapshot,
  slot: Slot | undefined,
  target: { procedure?: CaseSnapshot['procedure']; surgeonId?: string; reason?: 'requested' | 'surgeon_calendar' },
): Promise<void> {
  b.planned.add(c.caseId);
  b.effects.push(
    await computeMoveEffect(
      c,
      {
        slot,
        procedure: target.procedure ?? c.procedure,
        surgeonId: target.surgeonId ?? c.surgeonId,
        reason: target.reason ?? 'requested',
      },
      b.ports,
    ),
  );
  await addSeriesFollowers(b, c, slot);
}

/** Builds one proposed change plan. Reads only; nothing is executed. */
export async function buildChangePlan(
  practiceId: PracticeId,
  change: ChangeRequest,
  ports: PlanningPorts,
  options: BuildOptions,
): Promise<ChangePlan> {
  assertEnabled(options.featureEnabled);
  const b: Builder = { ports, now: ports.clock.now(), taken: new Set(), planned: new Set(), effects: [] };

  switch (change.type) {
    case 'date': {
      const c = await loadActiveCase(ports, practiceId, change.caseId);
      await planMove(b, c, await findSlot(b, c, { preferredStart: change.preferredStart }), {});
      break;
    }
    case 'site': {
      const c = await loadActiveCase(ports, practiceId, change.caseId);
      const slot = await findSlot(b, c, {
        preferredStart: c.scheduledStart,
        facilityId: change.facilityId,
        siteOfService: change.siteOfService,
      });
      await planMove(b, c, slot, {});
      break;
    }
    case 'procedure': {
      const c = await loadActiveCase(ports, practiceId, change.caseId);
      // A procedure that still fits keeps its slot; a longer one needs a new slot.
      const slot =
        change.procedure.durationMinutes <= c.procedure.durationMinutes
          ? {
              slotId: c.slotId,
              facilityId: c.facilityId,
              siteOfService: c.siteOfService,
              surgeonId: c.surgeonId,
              start: c.scheduledStart,
              end: addMs(c.scheduledStart, change.procedure.durationMinutes * 60_000),
            }
          : await findSlot(b, c, { preferredStart: c.scheduledStart, durationMinutes: change.procedure.durationMinutes });
      await planMove(b, c, slot, { procedure: change.procedure });
      break;
    }
    case 'surgeon': {
      const c = await loadActiveCase(ports, practiceId, change.caseId);
      const slot = await findSlot(b, c, { preferredStart: c.scheduledStart, surgeonId: change.surgeonId });
      await planMove(b, c, slot, { surgeonId: change.surgeonId });
      break;
    }
    case 'cancellation': {
      const c = await loadActiveCase(ports, practiceId, change.caseId);
      b.planned.add(c.caseId);
      b.effects.push(computeCancellationEffect(c, change.reason));
      break;
    }
    case 'surgeon_calendar': {
      const affected = (await ports.cases.listCasesForSurgeonOnDate(practiceId, change.surgeonId, change.date))
        .filter((c) => c.practiceId === practiceId && c.status !== 'Cancelled')
        .sort((x, y) => diffMs(x.scheduledStart, y.scheduledStart));
      if (affected.length === 0) {
        throw new ChangePlanError('no_cases_affected', `Surgeon ${change.surgeonId} has no active cases on ${change.date}.`);
      }
      const nextDay = addMs(`${change.date}T00:00:00.000Z`, DAY_MS);
      for (const c of affected) {
        if (b.planned.has(c.caseId)) continue;
        const slot = await findSlot(b, c, {
          preferredStart: addMs(c.scheduledStart, DAY_MS),
          earliestStart: nextDay > b.now ? nextDay : b.now,
          excludeDates: [change.date],
        });
        await planMove(b, c, slot, { reason: 'surgeon_calendar' });
      }
      break;
    }
  }

  return {
    planId: ports.ids.next('plan'),
    practiceId,
    change,
    createdAt: b.now,
    status: 'proposed',
    requiresHumanApprover: change.type === 'cancellation',
    cases: b.effects.map((e) => e.effect),
    steps: b.effects.flatMap((e) => e.steps),
    blockers: b.effects.flatMap((e) => e.blockers),
    tasks: [],
  };
}

/**
 * Records the one approval a plan needs before anything runs. Cancellations need a human approver.
 * Returns a new plan; the input is not changed.
 */
export function approveChangePlan(plan: ChangePlan, approver: Approver, at: IsoDateTime): ChangePlan {
  if (plan.approval) {
    throw new ChangePlanError('already_approved', `Plan ${plan.planId} is already approved.`);
  }
  if (plan.status !== 'proposed') {
    throw new ChangePlanError('invalid_status', `Plan ${plan.planId} is ${plan.status}; only a proposed plan can be approved.`);
  }
  if (plan.blockers.length > 0) {
    throw new ChangePlanError('blocked', `Plan ${plan.planId} cannot be approved: ${plan.blockers.join(' ')}`);
  }
  if (plan.requiresHumanApprover && approver.type !== 'human') {
    throw new ChangePlanError('human_approver_required', 'A cancellation must be approved by a person.');
  }
  return { ...plan, status: 'approved', approval: { approver, at } };
}

export function rejectChangePlan(plan: ChangePlan, by: string, reason: string, at: IsoDateTime): ChangePlan {
  if (plan.status !== 'proposed') {
    throw new ChangePlanError('invalid_status', `Plan ${plan.planId} is ${plan.status}; only a proposed plan can be rejected.`);
  }
  return { ...plan, status: 'rejected', rejection: { by, at, reason } };
}
