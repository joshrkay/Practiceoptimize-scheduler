/**
 * Effect computation (RAH-57): given a case and where it is going, list every downstream step.
 * Read-only: this module only asks ports questions; it never writes.
 */
import {
  EXTERNAL_STEP_KINDS,
  type CaseChangeSummary,
  type CaseEffect,
  type CaseSnapshot,
  type ChangeStep,
  type IsoDateTime,
  type Procedure,
  type ReentryStatus,
  type Slot,
  type StepAction,
  type SurgeonId,
} from './model.js';
import type { PlanningPorts } from './ports.js';

const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export function addMs(iso: IsoDateTime, ms: number): IsoDateTime {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function diffMs(later: IsoDateTime, earlier: IsoDateTime): number {
  return Date.parse(later) - Date.parse(earlier);
}

export function utcDate(iso: IsoDateTime): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
}

/** The slot a case holds today, rebuilt from its record. */
export function currentSlot(c: CaseSnapshot): Slot {
  return {
    slotId: c.slotId,
    facilityId: c.facilityId,
    siteOfService: c.siteOfService,
    surgeonId: c.surgeonId,
    start: c.scheduledStart,
    end: addMs(c.scheduledStart, c.procedure.durationMinutes * MINUTE_MS),
  };
}

export interface MoveTarget {
  /** Undefined when the slot finder found nothing; the effect then carries a blocker. */
  readonly slot: Slot | undefined;
  readonly procedure: Procedure;
  readonly surgeonId: SurgeonId;
  readonly reason: CaseEffect['reason'];
  readonly notes?: readonly string[];
}

export interface ComputedEffect {
  readonly effect: CaseEffect;
  readonly steps: readonly ChangeStep[];
  readonly blockers: readonly string[];
}

class StepList {
  private readonly steps: ChangeStep[] = [];
  constructor(private readonly caseId: string) {}

  add(action: StepAction, description: string): void {
    const n = String(this.steps.length + 1).padStart(2, '0');
    this.steps.push({
      stepId: `${this.caseId}:${n}:${action.kind}`,
      caseId: this.caseId,
      description,
      external: EXTERNAL_STEP_KINDS.has(action.kind),
      action,
      status: 'pending',
      attempts: 0,
      results: [],
    });
  }

  list(): readonly ChangeStep[] {
    return this.steps;
  }
}

function sameCodes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/** Effects of moving a case (date, site, procedure, surgeon, surgeon calendar, or series spacing). */
export async function computeMoveEffect(
  c: CaseSnapshot,
  target: MoveTarget,
  ports: Pick<PlanningPorts, 'authorization' | 'readiness'>,
): Promise<ComputedEffect> {
  const oldSlot = currentSlot(c);
  const notes = [...(target.notes ?? [])];
  const { slot } = target;

  if (!slot) {
    const blocker = `No open slot found for case ${c.caseId}; choose a slot by hand or change the request.`;
    return {
      effect: {
        caseId: c.caseId,
        patientRef: c.patientRef,
        fromStatus: c.status,
        reentryStatus: 'Booked',
        reason: target.reason,
        oldSlot,
        authorizationResubmission: false,
        expiringReadinessItemIds: [],
        notes: [...notes, blocker],
      },
      steps: [],
      blockers: [blocker],
    };
  }

  const steps = new StepList(c.caseId);
  const startMoved = slot.start !== oldSlot.start;
  const facilityMoved = slot.facilityId !== oldSlot.facilityId;
  const slotChanged = slot.slotId !== oldSlot.slotId;
  const surgeonChanged = target.surgeonId !== c.surgeonId;
  const codesChanged = !sameCodes(target.procedure.cptCodes, c.procedure.cptCodes);

  steps.add({ kind: 'enter_rescheduling' }, 'Move the case to Rescheduling while the plan runs.');

  if (facilityMoved) {
    steps.add({ kind: 'post_facility_slot', slot }, `Post the case at facility ${slot.facilityId} for ${slot.start}.`);
    steps.add(
      { kind: 'cancel_facility_posting', facilityId: oldSlot.facilityId, slotId: oldSlot.slotId },
      `Cancel the posting at facility ${oldSlot.facilityId}.`,
    );
  } else {
    steps.add({ kind: 'update_facility_posting', slot }, `Update the posting at facility ${slot.facilityId} to ${slot.start}.`);
  }

  const auth = await ports.authorization.checkWindow({
    practiceId: c.practiceId,
    caseId: c.caseId,
    authorization: c.authorization,
    scheduledStart: slot.start,
    cptCodes: target.procedure.cptCodes,
    facilityId: slot.facilityId,
    surgeonId: target.surgeonId,
  });
  if (!auth.covered) {
    steps.add(
      {
        kind: 'resubmit_authorization',
        cptCodes: target.procedure.cptCodes,
        scheduledStart: slot.start,
        facilityId: slot.facilityId,
        surgeonId: target.surgeonId,
        reason: auth.reason,
      },
      `Re-submit the authorization: ${auth.reason}`,
    );
  }

  const expiring = startMoved
    ? await ports.readiness.findExpiring(c.practiceId, c.caseId, c.readinessItems, slot.start)
    : [];
  for (const item of expiring) {
    steps.add(
      { kind: 'reopen_readiness_item', itemId: item.itemId, label: item.label },
      `Reopen "${item.label}": it lapses before the new date.`,
    );
  }

  for (const req of c.coordinationRequests) {
    steps.add(
      {
        kind: 'update_coordination_request',
        requestId: req.requestId,
        party: req.party,
        scheduledStart: slot.start,
        facilityId: slot.facilityId,
        surgeonId: target.surgeonId,
        cptCodes: target.procedure.cptCodes,
      },
      `Update the ${req.party} request: ${req.label}.`,
    );
  }

  if (c.postOpVisit && startMoved) {
    const newStart = addMs(c.postOpVisit.start, diffMs(slot.start, oldSlot.start));
    steps.add(
      { kind: 'move_post_op_visit', appointmentId: c.postOpVisit.appointmentId, newStart },
      `Move the post-op visit to ${newStart}, keeping its interval after surgery.`,
    );
  }

  steps.add(
    {
      kind: 'notify_patient',
      template: startMoved || facilityMoved ? 'case_rescheduled' : 'case_details_changed',
      scheduledStart: slot.start,
      facilityId: slot.facilityId,
    },
    'Tell the patient what changed.',
  );

  const summary: CaseChangeSummary = {
    cancelled: false,
    scheduledStart: slot.start,
    facilityId: slot.facilityId,
    surgeonId: target.surgeonId,
    cptCodes: target.procedure.cptCodes,
  };
  steps.add({ kind: 'update_ehr', change: summary }, 'Update the case in the EHR.');
  steps.add({ kind: 'update_practice_management', change: summary }, 'Update the case in practice management.');

  if (slotChanged) {
    steps.add(
      { kind: 'release_slot_to_waitlist', slotId: oldSlot.slotId, facilityId: oldSlot.facilityId, start: oldSlot.start },
      `Offer the freed ${oldSlot.start} slot to the waitlist.`,
    );
  }

  const reentryStatus: ReentryStatus = auth.covered ? 'Booked' : 'Auth pending';
  steps.add({ kind: 'reenter_workflow', status: reentryStatus }, `Return the case to ${reentryStatus}.`);

  if (surgeonChanged) notes.push(`Surgeon changes from ${c.surgeonId} to ${target.surgeonId}.`);
  if (codesChanged) notes.push(`Procedure codes change to ${target.procedure.cptCodes.join(', ')}.`);

  return {
    effect: {
      caseId: c.caseId,
      patientRef: c.patientRef,
      fromStatus: c.status,
      reentryStatus,
      reason: target.reason,
      oldSlot,
      newSlot: slot,
      authorizationResubmission: !auth.covered,
      expiringReadinessItemIds: expiring.map((i) => i.itemId),
      notes,
    },
    steps: steps.list(),
    blockers: [],
  };
}

/** Effects of cancelling one case. Never touches other cases, including the rest of its series. */
export function computeCancellationEffect(c: CaseSnapshot, reason: string): ComputedEffect {
  const oldSlot = currentSlot(c);
  const steps = new StepList(c.caseId);
  const notes = [`Cancellation reason: ${reason}`];
  if (c.series) {
    notes.push(
      `Case is part of series ${c.series.seriesId}; the other cases in the series are not changed. Cancel them separately if intended.`,
    );
  }

  steps.add(
    { kind: 'cancel_facility_posting', facilityId: oldSlot.facilityId, slotId: oldSlot.slotId },
    `Cancel the posting at facility ${oldSlot.facilityId}.`,
  );
  for (const req of c.coordinationRequests) {
    steps.add(
      { kind: 'cancel_coordination_request', requestId: req.requestId, party: req.party },
      `Cancel the ${req.party} request: ${req.label}.`,
    );
  }
  if (c.postOpVisit) {
    steps.add(
      { kind: 'cancel_post_op_visit', appointmentId: c.postOpVisit.appointmentId },
      'Cancel the post-op visit.',
    );
  }
  steps.add({ kind: 'notify_patient', template: 'case_cancelled' }, 'Tell the patient the case is cancelled.');
  const summary: CaseChangeSummary = { cancelled: true };
  steps.add({ kind: 'update_ehr', change: summary }, 'Mark the case cancelled in the EHR.');
  steps.add({ kind: 'update_practice_management', change: summary }, 'Mark the case cancelled in practice management.');
  steps.add(
    { kind: 'release_slot_to_waitlist', slotId: oldSlot.slotId, facilityId: oldSlot.facilityId, start: oldSlot.start },
    `Offer the freed ${oldSlot.start} slot to the waitlist.`,
  );
  steps.add({ kind: 'reenter_workflow', status: 'Cancelled' }, 'Close the case as Cancelled.');

  return {
    effect: {
      caseId: c.caseId,
      patientRef: c.patientRef,
      fromStatus: c.status,
      reentryStatus: 'Cancelled',
      reason: 'requested',
      oldSlot,
      authorizationResubmission: false,
      expiringReadinessItemIds: [],
      notes,
    },
    steps: steps.list(),
    blockers: [],
  };
}
