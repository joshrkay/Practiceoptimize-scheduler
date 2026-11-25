/**
 * Runs the care team coordination journey for a practice: opens the requests each case stage needs,
 * holds approve-first requests for the review queue, sends reminders and phone tasks on the injected
 * clock, marks requests overdue, and re-runs affected parties after an approved change.
 */
import type { CoordinationConfig } from './escalation.js';
import { evaluateEscalation } from './escalation.js';
import type { CaseSnapshot, JourneyDefinition, JourneyStep } from './journey.js';
import { computeDueAt, findStep, isApproveFirst, stepApplies, stepsForStage } from './journey.js';
import type {
  ApprovalPolicy,
  CareTeamDirectory,
  CaseReader,
  CaseRiskSignal,
  Clock,
  CoordinationRequestStore,
  IdGenerator,
  OutboundMessage,
  OutboundSender,
  ReviewQueue,
  SchedulerTaskQueue,
} from './ports.js';
import { DuplicateActiveRequestError } from './ports.js';
import type { CoordinationRequest } from './requests.js';
import {
  appendHistory,
  idempotencyKey,
  isActive,
  markAnswered,
  markCancelled,
  markOverdue,
} from './requests.js';

export interface CoordinatorDeps {
  config: CoordinationConfig;
  journey: JourneyDefinition;
  clock: Clock;
  ids: IdGenerator;
  cases: CaseReader;
  directory: CareTeamDirectory;
  sender: OutboundSender;
  policy: ApprovalPolicy;
  reviewQueue: ReviewQueue;
  tasks: SchedulerTaskQueue;
  risk: CaseRiskSignal;
  store: CoordinationRequestStore;
}

export type SkipReason = 'already_requested' | 'party_unresolved';

export interface StageResult {
  disabled: boolean;
  created: CoordinationRequest[];
  skipped: { stepId: string; reason: SkipReason }[];
}

export interface EscalationResult {
  disabled: boolean;
  reminders: number;
  phoneTasks: number;
  overdue: number;
}

/** A change plan a scheduler has approved. Its approval covers the cascade's outbound messages. */
export type ApprovedChange =
  | { kind: 'reschedule'; practiceId: string; caseId: string; changePlanId: string; newSurgeryDate: string }
  | { kind: 'cancel_case'; practiceId: string; caseId: string; changePlanId: string };

export interface ChangeResult {
  disabled: boolean;
  cancelled: CoordinationRequest[];
  reissued: CoordinationRequest[];
  /** Requests whose party was sent a cancellation notice. */
  notified: CoordinationRequest[];
}

interface OpenOptions {
  stage: string;
  supersedesId?: string;
  changePlanId?: string;
}

export class CoordinationNotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'CoordinationNotFoundError';
  }
}

export class CareTeamCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  /** Opens every request the journey requires when a case reaches `stage`. Safe to call repeatedly. */
  async onStageReached(practiceId: string, caseId: string, stage: string): Promise<StageResult> {
    const result: StageResult = { disabled: !this.deps.config.enabled, created: [], skipped: [] };
    if (result.disabled) return result;
    const snapshot = await this.requireCase(practiceId, caseId);
    for (const step of stepsForStage(this.deps.journey, stage, snapshot)) {
      const outcome = await this.openForStep(snapshot, step, { stage });
      if ('request' in outcome) result.created.push(outcome.request);
      else result.skipped.push({ stepId: step.id, reason: outcome.skipped });
    }
    return result;
  }

  /** A scheduler approved an approve-first request in the review queue: send it now. */
  async approveRequest(practiceId: string, requestId: string, reviewItemId: string): Promise<CoordinationRequest> {
    const request = await this.requireRequest(practiceId, requestId);
    if (!isActive(request) || request.approval.status !== 'pending') {
      throw new Error(`Coordination request ${requestId} is not awaiting approval`);
    }
    const now = this.deps.clock.now();
    let next: CoordinationRequest = appendHistory(
      { ...request, approval: { status: 'approved', via: 'review_queue', ref: reviewItemId, approvedAt: now.toISOString() } },
      'approved',
      now,
      reviewItemId,
    );
    const step = findStep(this.deps.journey, request.stepId);
    if (step && 'hoursAfterSend' in step.due) {
      next = { ...next, dueAt: computeDueAt(step, request.surgeryDate, now).toISOString() };
    }
    next = await this.send(next, request.supersedesId === null ? 'request' : 'updated_request');
    await this.deps.store.update(next);
    return next;
  }

  /** A scheduler rejected an approve-first request: it is cancelled and never sent. */
  async rejectRequest(practiceId: string, requestId: string, reason: string): Promise<CoordinationRequest> {
    const request = await this.requireRequest(practiceId, requestId);
    if (request.approval.status !== 'pending') {
      throw new Error(`Coordination request ${requestId} is not awaiting approval`);
    }
    const next = markCancelled(request, this.deps.clock.now(), `rejected in review: ${reason}`);
    await this.deps.store.update(next);
    return next;
  }

  /** The party replied. Stops the reminder ladder and clears any risk the request raised. */
  async recordAnswer(practiceId: string, requestId: string, detail?: string): Promise<CoordinationRequest> {
    const request = await this.requireRequest(practiceId, requestId);
    const next = markAnswered(request, this.deps.clock.now(), detail);
    await this.deps.store.update(next);
    if (request.status === 'overdue' && request.blocksReadiness) {
      await this.deps.risk.clear({ practiceId, caseId: request.caseId, requestId });
    }
    return next;
  }

  /** One sweep of the reminder ladder for a practice, at the injected clock's time. */
  async runEscalation(practiceId: string): Promise<EscalationResult> {
    const result: EscalationResult = { disabled: !this.deps.config.enabled, reminders: 0, phoneTasks: 0, overdue: 0 };
    if (result.disabled) return result;
    const now = this.deps.clock.now();
    for (const request of await this.deps.store.listActive(practiceId)) {
      const actions = evaluateEscalation(request, this.deps.config, now);
      if (actions.length === 0) continue;
      let next = request;
      for (const action of actions) {
        if (action.kind === 'reminder') {
          await this.deps.sender.send({ ...this.messageFor(next, 'reminder'), reminderLevel: action.level });
          next = appendHistory({ ...next, remindersSent: action.level }, 'reminder_sent', now, `level ${action.level}`);
          result.reminders += 1;
        } else if (action.kind === 'phone_task') {
          const { taskId } = await this.deps.tasks.createTask({
            practiceId,
            caseId: next.caseId,
            kind: 'phone_call',
            idempotencyKey: `${next.id}|phone_call`,
            requestId: next.id,
            partyRole: next.partyRole,
          });
          next = appendHistory({ ...next, phoneTaskId: taskId }, 'phone_task_created', now, taskId);
          result.phoneTasks += 1;
        } else {
          next = markOverdue(next, now);
          result.overdue += 1;
          if (next.blocksReadiness) {
            await this.deps.risk.raise({ practiceId, caseId: next.caseId, requestId: next.id, reason: 'coordination_overdue' });
          }
        }
      }
      await this.deps.store.update(next);
    }
    return result;
  }

  /**
   * An approved change. A reschedule cancels the case's open requests and re-runs each affected party's
   * date-sensitive step from the new date (updated request), or sends a cancellation notice when the step no
   * longer applies. Answered requests for the old date are re-run too. A case cancellation cancels every
   * open request and notifies each party that was contacted.
   */
  async onChangeApproved(change: ApprovedChange): Promise<ChangeResult> {
    const result: ChangeResult = { disabled: !this.deps.config.enabled, cancelled: [], reissued: [], notified: [] };
    if (result.disabled) return result;
    const { practiceId, caseId, changePlanId } = change;
    const requests = await this.deps.store.listByCase(practiceId, caseId);

    if (change.kind === 'cancel_case') {
      for (const request of requests.filter(isActive)) {
        await this.cancelForChange(request, changePlanId, true, result);
      }
      return result;
    }

    const snapshot: CaseSnapshot = { ...(await this.requireCase(practiceId, caseId)), surgeryDate: change.newSurgeryDate };
    for (const request of this.latestPerPartyAndType(requests)) {
      const step = findStep(this.deps.journey, request.stepId);
      if (!step || !step.dateSensitive) continue;
      if (request.status === 'cancelled' || request.surgeryDate === change.newSurgeryDate) continue;
      const stillApplies = stepApplies(step, snapshot);
      if (isActive(request)) await this.cancelForChange(request, changePlanId, !stillApplies, result);
      else if (!stillApplies) await this.notifyCancellation(request, changePlanId, result);
      if (stillApplies) {
        const outcome = await this.openForStep(snapshot, step, {
          stage: request.stage,
          supersedesId: request.id,
          changePlanId,
        });
        if ('request' in outcome) result.reissued.push(outcome.request);
      }
    }
    return result;
  }

  private latestPerPartyAndType(requests: CoordinationRequest[]): CoordinationRequest[] {
    const latest = new Map<string, CoordinationRequest>();
    for (const request of [...requests].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      latest.set(idempotencyKey(request), request);
    }
    return [...latest.values()];
  }

  private async cancelForChange(
    request: CoordinationRequest,
    changePlanId: string,
    notify: boolean,
    result: ChangeResult,
  ): Promise<void> {
    const now = this.deps.clock.now();
    let next = markCancelled(request, now, `change plan ${changePlanId}`);
    if (request.approval.status === 'pending' && request.approval.reviewItemId !== null) {
      await this.deps.reviewQueue.withdraw(request.practiceId, request.approval.reviewItemId, `change plan ${changePlanId}`);
    }
    if (request.status === 'overdue' && request.blocksReadiness) {
      await this.deps.risk.clear({ practiceId: request.practiceId, caseId: request.caseId, requestId: request.id });
    }
    if (notify && request.sentAt !== null) {
      await this.deps.sender.send(this.messageFor(next, 'cancellation_notice'));
      next = appendHistory(next, 'cancellation_notice_sent', now, changePlanId);
      result.notified.push(next);
    }
    await this.deps.store.update(next);
    result.cancelled.push(next);
  }

  private async notifyCancellation(request: CoordinationRequest, changePlanId: string, result: ChangeResult): Promise<void> {
    await this.deps.sender.send(this.messageFor(request, 'cancellation_notice'));
    const next = appendHistory(request, 'cancellation_notice_sent', this.deps.clock.now(), changePlanId);
    await this.deps.store.update(next);
    result.notified.push(next);
  }

  private async openForStep(
    snapshot: CaseSnapshot,
    step: JourneyStep,
    options: OpenOptions,
  ): Promise<{ request: CoordinationRequest } | { skipped: SkipReason }> {
    const { practiceId, caseId } = snapshot;
    const party = await this.deps.directory.resolveParty(practiceId, caseId, step.partyRole);
    if (!party) {
      await this.deps.tasks.createTask({
        practiceId,
        caseId,
        kind: 'resolve_contact',
        idempotencyKey: `${practiceId}|${caseId}|${step.id}|resolve_contact`,
        partyRole: step.partyRole,
      });
      return { skipped: 'party_unresolved' };
    }

    const existing = await this.deps.store.listByCase(practiceId, caseId);
    const duplicate = existing.find(
      (row) =>
        row.partyId === party.partyId &&
        row.type === step.type &&
        (isActive(row) || (row.status === 'answered' && row.surgeryDate === snapshot.surgeryDate)),
    );
    if (duplicate) return { skipped: 'already_requested' };

    const now = this.deps.clock.now();
    const needsApproval =
      options.changePlanId === undefined &&
      (isApproveFirst(step) ||
        (await this.deps.policy.requiresApproval({
          practiceId,
          caseId,
          requestType: step.type,
          partyRole: step.partyRole,
        })));

    let request: CoordinationRequest = {
      id: this.deps.ids.next(),
      practiceId,
      caseId,
      partyId: party.partyId,
      partyRole: step.partyRole,
      type: step.type,
      stepId: step.id,
      stage: options.stage,
      channel: step.channel ?? party.preferredChannel,
      status: 'open',
      approval:
        options.changePlanId !== undefined
          ? { status: 'approved', via: 'change_plan', ref: options.changePlanId, approvedAt: now.toISOString() }
          : needsApproval
            ? { status: 'pending', reviewItemId: null }
            : { status: 'not_required' },
      surgeryDate: snapshot.surgeryDate,
      dueAt: computeDueAt(step, snapshot.surgeryDate, now).toISOString(),
      createdAt: now.toISOString(),
      sentAt: null,
      answeredAt: null,
      cancelledAt: null,
      cancelReason: null,
      remindersSent: 0,
      phoneTaskId: null,
      supersedesId: options.supersedesId ?? null,
      blocksReadiness: step.blocksReadiness,
      history: [{ at: now.toISOString(), event: 'created', detail: step.id }],
    };

    try {
      await this.deps.store.insert(request);
    } catch (error) {
      if (error instanceof DuplicateActiveRequestError) return { skipped: 'already_requested' };
      throw error;
    }

    if (needsApproval) {
      const { reviewItemId } = await this.deps.reviewQueue.submit({
        practiceId,
        caseId,
        kind: 'coordination_request',
        requestId: request.id,
        requestType: request.type,
      });
      request = { ...request, approval: { status: 'pending', reviewItemId } };
    } else {
      request = await this.send(request, options.supersedesId === undefined ? 'request' : 'updated_request');
    }
    await this.deps.store.update(request);
    return { request };
  }

  private async send(request: CoordinationRequest, kind: 'request' | 'updated_request'): Promise<CoordinationRequest> {
    await this.deps.sender.send(this.messageFor(request, kind));
    const now = this.deps.clock.now();
    return appendHistory({ ...request, sentAt: now.toISOString() }, 'sent', now, kind);
  }

  private messageFor(request: CoordinationRequest, kind: OutboundMessage['kind']): OutboundMessage {
    const message: OutboundMessage = {
      practiceId: request.practiceId,
      caseId: request.caseId,
      requestId: request.id,
      partyId: request.partyId,
      channel: request.channel,
      kind,
      requestType: request.type,
      surgeryDate: request.surgeryDate,
    };
    if (request.supersedesId !== null && kind === 'updated_request') message.supersedesRequestId = request.supersedesId;
    return message;
  }

  private async requireCase(practiceId: string, caseId: string): Promise<CaseSnapshot> {
    const snapshot = await this.deps.cases.getCase(practiceId, caseId);
    if (!snapshot) throw new CoordinationNotFoundError(`Case ${caseId}`);
    return snapshot;
  }

  private async requireRequest(practiceId: string, requestId: string): Promise<CoordinationRequest> {
    const request = await this.deps.store.get(practiceId, requestId);
    if (!request) throw new CoordinationNotFoundError(`Coordination request ${requestId}`);
    return request;
  }
}
