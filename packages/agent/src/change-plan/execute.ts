/**
 * Runs an approved change plan step by step (RAH-57).
 *
 * - Nothing runs without the plan's approval.
 * - Each step calls exactly one existing tool through a port and records its result.
 * - A failed step pauses the plan and creates a review-queue task listing the remaining steps.
 *   Calling `executeChangePlan` again on the paused plan resumes at the failed step.
 * - An external step that has failed twice stops the plan: no more automatic attempts, and the task asks a
 *   scheduler to take over.
 */
import { ChangePlanError } from './plan.js';
import { MAX_EXTERNAL_ATTEMPTS, type ChangePlan, type ChangeStep, type StepAction } from './model.js';
import type { ExecutionPorts, WriteContext } from './ports.js';

export interface ExecuteOptions {
  readonly featureEnabled: boolean;
}

async function runAction(action: StepAction, ctx: WriteContext, ports: ExecutionPorts): Promise<string> {
  switch (action.kind) {
    case 'enter_rescheduling':
      await ports.caseState.transition(ctx, 'Rescheduling', 'Approved change plan is running.');
      return 'Case moved to Rescheduling.';
    case 'post_facility_slot': {
      const r = await ports.facility.post(ctx, action.slot);
      return `Posted at ${action.slot.facilityId} (posting ${r.postingId}).`;
    }
    case 'update_facility_posting': {
      const r = await ports.facility.update(ctx, action.slot);
      return `Posting ${r.postingId} updated to ${action.slot.start}.`;
    }
    case 'cancel_facility_posting':
      await ports.facility.cancel(ctx, action.facilityId, action.slotId);
      return `Posting at ${action.facilityId} cancelled.`;
    case 'resubmit_authorization': {
      const r = await ports.authorization.resubmit(ctx, {
        cptCodes: action.cptCodes,
        scheduledStart: action.scheduledStart,
        facilityId: action.facilityId,
        surgeonId: action.surgeonId,
        reason: action.reason,
      });
      return `Authorization re-submitted (${r.submissionId}).`;
    }
    case 'reopen_readiness_item':
      await ports.readiness.reopen(ctx, action.itemId, 'Lapses before the new surgery date.');
      return `Readiness item ${action.itemId} reopened.`;
    case 'update_coordination_request':
      await ports.coordination.updateRequest(ctx, action.requestId, {
        scheduledStart: action.scheduledStart,
        facilityId: action.facilityId,
        surgeonId: action.surgeonId,
        cptCodes: action.cptCodes,
      });
      return `Request ${action.requestId} updated.`;
    case 'cancel_coordination_request':
      await ports.coordination.cancelRequest(ctx, action.requestId);
      return `Request ${action.requestId} cancelled.`;
    case 'move_post_op_visit': {
      const r = await ports.postOp.move(ctx, action.appointmentId, action.newStart);
      return `Post-op visit ${r.appointmentId} moved to ${action.newStart}.`;
    }
    case 'cancel_post_op_visit':
      await ports.postOp.cancel(ctx, action.appointmentId);
      return `Post-op visit ${action.appointmentId} cancelled.`;
    case 'notify_patient': {
      const r = await ports.messaging.send(ctx, {
        template: action.template,
        ...(action.scheduledStart ? { scheduledStart: action.scheduledStart } : {}),
        ...(action.facilityId ? { facilityId: action.facilityId } : {}),
      });
      return `Patient message ${r.messageId} sent (${action.template}).`;
    }
    case 'update_ehr':
      await ports.ehr.updateCase(ctx, action.change);
      return 'EHR updated.';
    case 'update_practice_management':
      await ports.practiceManagement.updateCase(ctx, action.change);
      return 'Practice management updated.';
    case 'release_slot_to_waitlist':
      await ports.waitlist.releaseSlot(ctx, { slotId: action.slotId, facilityId: action.facilityId, start: action.start });
      return `Slot ${action.slotId} offered to the waitlist.`;
    case 'reenter_workflow':
      await ports.caseState.transition(ctx, action.status, 'Change plan finished.');
      return `Case returned to ${action.status}.`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs (or resumes) an approved plan. Returns the updated plan; the input is not changed. */
export async function executeChangePlan(
  plan: ChangePlan,
  ports: ExecutionPorts,
  options: ExecuteOptions,
): Promise<ChangePlan> {
  if (!options.featureEnabled) {
    throw new ChangePlanError('feature_disabled', 'FEATURE_RESCHEDULE_CASCADE is off for this practice.');
  }
  if (!plan.approval) {
    throw new ChangePlanError('not_approved', `Plan ${plan.planId} has not been approved; nothing was run.`);
  }
  if (plan.status !== 'approved' && plan.status !== 'paused') {
    throw new ChangePlanError('invalid_status', `Plan ${plan.planId} is ${plan.status} and cannot run.`);
  }

  const steps: ChangeStep[] = [...plan.steps];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as ChangeStep;
    if (step.status === 'succeeded') continue;

    const attempt = step.attempts + 1;
    const ctx: WriteContext = {
      practiceId: plan.practiceId,
      caseId: step.caseId,
      idempotencyKey: `${plan.planId}:${step.stepId}`,
    };
    let ok = true;
    let detail: string;
    try {
      detail = await runAction(step.action, ctx, ports);
    } catch (err) {
      ok = false;
      detail = errorMessage(err);
    }
    const updated: ChangeStep = {
      ...step,
      status: ok ? 'succeeded' : 'failed',
      attempts: attempt,
      results: [...step.results, { attempt, at: ports.clock.now(), ok, detail }],
    };
    steps[i] = updated;
    if (ok) continue;

    const stop = updated.external && attempt >= MAX_EXTERNAL_ATTEMPTS;
    const remaining = steps.slice(i);
    const reason = stop
      ? `Step "${updated.description}" failed ${attempt} times (${detail}). The agent will not retry; a scheduler must take over.`
      : `Step "${updated.description}" failed (${detail}). The plan is paused; resume it once the cause is fixed.`;
    const task = await ports.reviewQueue.createTask({
      practiceId: plan.practiceId,
      planId: plan.planId,
      title: stop ? 'Change plan stopped: take over' : 'Change plan paused',
      reason,
      remainingSteps: remaining.map((s) => ({ stepId: s.stepId, caseId: s.caseId, description: s.description })),
      requiresTakeOver: stop,
    });
    return {
      ...plan,
      steps,
      status: stop ? 'stopped' : 'paused',
      tasks: [...plan.tasks, { taskId: task.taskId, reason, remainingStepIds: remaining.map((s) => s.stepId) }],
    };
  }

  return { ...plan, steps, status: 'completed' };
}
