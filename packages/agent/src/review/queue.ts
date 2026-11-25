import { randomUUID } from 'node:crypto';
import { diffInputs } from './diff';
import type { ActionExecutor, AuditSink, Clock, Escalator, HardRuleCheck, ProposedActionRef } from './ports';
import type { ReviewListFilter, ReviewStore } from './store';
import type {
  Actor,
  BulkApproveResult,
  DecisionFailure,
  DecisionResult,
  NewReviewItem,
  ReviewItem,
  Takeover,
} from './types';

/**
 * Default time a proposed action may wait for review before it escalates to the practice admin.
 * The product spec does not fix this; 24 hours is a placeholder. Configure per deployment.
 */
export const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Low-risk action types that may be approved as a group. */
export const DEFAULT_BULK_ELIGIBLE_ACTION_TYPES: readonly string[] = ['confirmation', 'reminder', 'posting_update'];

/** Never bulk approvable, even if misconfigured as eligible. */
export const NEVER_BULK_ACTION_TYPES: readonly string[] = ['auth_submission', 'change_plan'];

export interface ReviewQueueConfig {
  readonly expiryMs?: number;
  readonly bulkEligibleActionTypes?: readonly string[];
}

export interface ReviewQueueDeps {
  readonly store: ReviewStore;
  readonly hardRuleCheck: HardRuleCheck;
  readonly executor: ActionExecutor;
  readonly audit: AuditSink;
  readonly clock: Clock;
  readonly escalator: Escalator;
  readonly config?: ReviewQueueConfig;
}

export type EnqueueResult =
  | { readonly ok: true; readonly item: ReviewItem }
  | { readonly ok: false; readonly code: 'case_taken_over'; readonly message: string };

export class ReviewQueue {
  private readonly expiryMs: number;
  private readonly bulkTypes: ReadonlySet<string>;

  constructor(private readonly deps: ReviewQueueDeps) {
    this.expiryMs = deps.config?.expiryMs ?? DEFAULT_EXPIRY_MS;
    const eligible = deps.config?.bulkEligibleActionTypes ?? DEFAULT_BULK_ELIGIBLE_ACTION_TYPES;
    this.bulkTypes = new Set(eligible.filter((t) => !NEVER_BULK_ACTION_TYPES.includes(t)));
  }

  /** Planner entry point. Refuses while the case is taken over. */
  async enqueue(practiceId: string, input: NewReviewItem): Promise<EnqueueResult> {
    if (await this.deps.store.getTakeover(practiceId, input.caseId)) {
      return { ok: false, code: 'case_taken_over', message: 'Case is taken over; the planner takes no action.' };
    }
    const now = this.deps.clock.now();
    const item: ReviewItem = {
      id: randomUUID(),
      practiceId,
      caseId: input.caseId,
      actionType: input.actionType,
      inputs: structuredClone(input.inputs),
      reason: input.reason,
      evidenceLinks: [...input.evidenceLinks],
      policyResult: input.policyResult,
      createdAt: now,
      expiresAt: input.expiresAt ?? new Date(now.getTime() + this.expiryMs),
      status: 'pending',
    };
    await this.deps.store.insert(item);
    return { ok: true, item };
  }

  list(practiceId: string, filter?: ReviewListFilter): Promise<ReviewItem[]> {
    return this.deps.store.list(practiceId, filter);
  }

  get(practiceId: string, id: string): Promise<ReviewItem | undefined> {
    return this.deps.store.get(practiceId, id);
  }

  approve(actor: Actor, itemId: string): Promise<DecisionResult> {
    return this.decide(actor, itemId, undefined);
  }

  async editAndApprove(
    actor: Actor,
    itemId: string,
    editedInputs: Readonly<Record<string, unknown>>,
  ): Promise<DecisionResult> {
    if (typeof editedInputs !== 'object' || editedInputs === null || Array.isArray(editedInputs)) {
      return { ok: false, code: 'invalid', message: 'Edited inputs must be an object.' };
    }
    return this.decide(actor, itemId, editedInputs);
  }

  async reject(actor: Actor, itemId: string, reason: string): Promise<DecisionResult> {
    if (reason.trim() === '') return { ok: false, code: 'invalid', message: 'A rejection reason is required.' };
    const gate = await this.pendingItem(actor, itemId);
    if (!gate.ok) return gate;
    const now = this.deps.clock.now();
    const updated = await this.deps.store.transition(actor.practiceId, itemId, 'pending', {
      status: 'rejected',
      decidedBy: actor.userId,
      decidedAt: now,
      rejectionReason: reason,
    });
    if (!updated) return this.notPending(actor, itemId);
    await this.deps.store.addFeedback({
      practiceId: actor.practiceId,
      itemId,
      caseId: updated.caseId,
      actionType: updated.actionType,
      label: 'rejected',
      originalInputs: updated.inputs,
      reason,
      actorId: actor.userId,
      createdAt: now,
    });
    await this.audit(actor, 'review.rejected', updated, { reason });
    return { ok: true, item: updated };
  }

  /**
   * Approve a group of items of one low-risk action type. Each item re-runs the hard rules on its
   * own; failures drop out with their reason and the rest proceed.
   */
  async bulkApprove(
    actor: Actor,
    actionType: string,
    itemIds: readonly string[],
  ): Promise<BulkApproveResult | DecisionFailure> {
    if (!this.bulkTypes.has(actionType)) {
      return { ok: false, code: 'invalid', message: `Action type "${actionType}" cannot be bulk approved.` };
    }
    const approved: ReviewItem[] = [];
    const dropped: { itemId: string; code: string; reason: string }[] = [];
    for (const itemId of new Set(itemIds)) {
      const item = await this.deps.store.get(actor.practiceId, itemId);
      if (!item) {
        dropped.push({ itemId, code: 'not_found', reason: 'Item not found.' });
      } else if (item.actionType !== actionType) {
        dropped.push({ itemId, code: 'wrong_type', reason: `Item is "${item.actionType}", not "${actionType}".` });
      } else if (item.policyResult.humanOnly) {
        dropped.push({ itemId, code: 'human_only', reason: 'Human-only items cannot be bulk approved.' });
      } else {
        const result = await this.decide(actor, itemId, undefined);
        if (result.ok) approved.push(result.item);
        else dropped.push({ itemId, code: result.code, reason: result.message });
      }
    }
    await this.deps.audit.record({
      practiceId: actor.practiceId,
      actorId: actor.userId,
      action: 'review.bulk_approved',
      details: { actionType, approved: approved.map((i) => i.id), dropped },
    });
    return { approved, dropped };
  }

  /** Pause the planner for a case until released. */
  async takeOver(
    actor: Actor,
    caseId: string,
  ): Promise<{ ok: true; takeover: Takeover } | { ok: false; message: string }> {
    const takeover: Takeover = {
      practiceId: actor.practiceId,
      caseId,
      userId: actor.userId,
      since: this.deps.clock.now(),
    };
    if (!(await this.deps.store.setTakeover(takeover))) {
      return { ok: false, message: 'Case is already taken over.' };
    }
    await this.deps.audit.record({
      practiceId: actor.practiceId,
      actorId: actor.userId,
      action: 'case.taken_over',
      caseId,
    });
    return { ok: true, takeover };
  }

  async release(actor: Actor, caseId: string): Promise<{ ok: boolean; message?: string }> {
    if (!(await this.deps.store.clearTakeover(actor.practiceId, caseId))) {
      return { ok: false, message: 'Case is not taken over.' };
    }
    await this.deps.audit.record({
      practiceId: actor.practiceId,
      actorId: actor.userId,
      action: 'case.released',
      caseId,
    });
    return { ok: true };
  }

  /** The planner calls this before acting. It should still record the event either way. */
  async plannerMayAct(practiceId: string, caseId: string): Promise<boolean> {
    return (await this.deps.store.getTakeover(practiceId, caseId)) === undefined;
  }

  /** Expire overdue pending items and escalate each to the practice admin. */
  async expireDue(practiceId: string): Promise<ReviewItem[]> {
    const now = this.deps.clock.now();
    const expired: ReviewItem[] = [];
    for (const item of await this.deps.store.list(practiceId, { status: 'pending' })) {
      if (item.expiresAt.getTime() > now.getTime()) continue;
      const updated = await this.deps.store.transition(practiceId, item.id, 'pending', {
        status: 'expired',
        decidedAt: now,
      });
      if (!updated) continue;
      await this.deps.escalator.escalateToPracticeAdmin(practiceId, item.id, 'Expired without review');
      await this.deps.audit.record({
        practiceId,
        actorId: 'system',
        action: 'review.expired',
        itemId: item.id,
        caseId: item.caseId,
      });
      expired.push(updated);
    }
    return expired;
  }

  private async decide(
    actor: Actor,
    itemId: string,
    editedInputs: Readonly<Record<string, unknown>> | undefined,
  ): Promise<DecisionResult> {
    const gate = await this.pendingItem(actor, itemId);
    if (!gate.ok) return gate;
    const item = gate.item;
    const finalInputs = editedInputs ?? item.inputs;
    const diff = editedInputs ? diffInputs(item.inputs, editedInputs) : [];
    const action: ProposedActionRef = {
      practiceId: actor.practiceId,
      caseId: item.caseId,
      actionType: item.actionType,
      inputs: finalInputs,
    };

    // Hard rules always run on what will actually execute, including edits.
    const hardRule = await this.deps.hardRuleCheck(action);
    if (!hardRule.ok) {
      await this.audit(actor, 'review.blocked_by_hard_rule', item, { reason: hardRule.reason });
      return { ok: false, code: 'hard_rule_failed', message: hardRule.reason, item, hardRule };
    }

    const claimed = await this.deps.store.transition(actor.practiceId, itemId, 'pending', { status: 'executing' });
    if (!claimed) return this.notPending(actor, itemId);

    const now = this.deps.clock.now();
    const exec = await this.deps.executor.execute(action);
    if (!exec.ok) {
      const failed = await this.deps.store.transition(actor.practiceId, itemId, 'executing', {
        status: 'failed',
        error: exec.error,
        decidedBy: actor.userId,
        decidedAt: now,
      });
      await this.audit(actor, 'review.execution_failed', item, { error: exec.error });
      return { ok: false, code: 'execution_failed', message: exec.error, ...(failed ? { item: failed } : {}) };
    }

    const edited = diff.length > 0;
    const done = await this.deps.store.transition(actor.practiceId, itemId, 'executing', {
      status: edited ? 'edited_approved' : 'approved',
      decidedBy: actor.userId,
      decidedAt: now,
      executedInputs: finalInputs,
      ...(edited ? { diff } : {}),
    });
    if (edited) {
      await this.deps.store.addFeedback({
        practiceId: actor.practiceId,
        itemId,
        caseId: item.caseId,
        actionType: item.actionType,
        label: 'edited',
        originalInputs: item.inputs,
        editedInputs: finalInputs,
        diff,
        actorId: actor.userId,
        createdAt: now,
      });
    }
    await this.audit(actor, edited ? 'review.edited_approved' : 'review.approved', item, edited ? { diff } : {});
    return { ok: true, item: done ?? claimed };
  }

  /** Load a pending, unexpired item for this practice. */
  private async pendingItem(
    actor: Actor,
    itemId: string,
  ): Promise<{ ok: true; item: ReviewItem } | DecisionFailure> {
    const item = await this.deps.store.get(actor.practiceId, itemId);
    if (!item) return { ok: false, code: 'not_found', message: 'Review item not found.' };
    if (item.status !== 'pending') return { ok: false, code: 'not_pending', message: `Item is ${item.status}.`, item };
    if (item.expiresAt.getTime() <= this.deps.clock.now().getTime()) {
      return { ok: false, code: 'expired', message: 'Item expired; it escalates to the practice admin.', item };
    }
    return { ok: true, item };
  }

  private async notPending(actor: Actor, itemId: string): Promise<DecisionFailure> {
    const item = await this.deps.store.get(actor.practiceId, itemId);
    return {
      ok: false,
      code: 'not_pending',
      message: `Item is ${item?.status ?? 'missing'}.`,
      ...(item ? { item } : {}),
    };
  }

  private audit(actor: Actor, action: string, item: ReviewItem, details: Record<string, unknown>): Promise<void> {
    return this.deps.audit.record({
      practiceId: actor.practiceId,
      actorId: actor.userId,
      action,
      itemId: item.id,
      caseId: item.caseId,
      details,
    });
  }
}
