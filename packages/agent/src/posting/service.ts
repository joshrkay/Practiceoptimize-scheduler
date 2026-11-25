import { randomUUID } from 'node:crypto';
import { crossCheck } from './crosscheck.js';
import {
  missingFields,
  renderCancellation,
  renderPosting,
  renderReconfirmation,
} from './format.js';
import type {
  Clock,
  DirectSchedulingRoute,
  FacilityDirectory,
  InboundConfirmation,
  PostingPolicy,
  ReviewQueue,
  SendTool,
  SubmissionStore,
} from './ports.js';
import type {
  BlockReason,
  FacilityDirectoryEntry,
  Mismatch,
  PostingCase,
  PracticeId,
  SignedOrder,
  Submission,
} from './types.js';

export const RECONFIRM_WINDOW_HOURS = 72;

/** FEATURE_COORD_FACILITY_POSTING defaults to false. */
export function isFacilityPostingEnabled(env: Record<string, string | undefined>): boolean {
  return env['FEATURE_COORD_FACILITY_POSTING'] === 'true';
}

export interface PostingServiceDeps {
  directory: FacilityDirectory;
  sendTool: SendTool;
  /** Optional direct scheduling-system route (RAH-77). */
  directRoute?: DirectSchedulingRoute;
  policy: PostingPolicy;
  reviewQueue: ReviewQueue;
  clock: Clock;
  store: SubmissionStore;
  enabled: boolean;
  newId?: () => string;
}

export type PostingResult =
  | { status: 'disabled' }
  | { status: 'not_required'; reason: 'office_procedure_room' }
  | { status: 'denied_by_policy' }
  | { status: 'blocked'; submission: Submission; reason: BlockReason; mismatches: Mismatch[] }
  | { status: 'pending_approval'; submission: Submission }
  | { status: 'sent'; submission: Submission };

export class PostingError extends Error {}

function startsAtIso(c: PostingCase): string {
  const d = new Date(`${c.date}T${c.startTime}:00${c.utcOffset}`);
  if (Number.isNaN(d.getTime())) {
    throw new PostingError(`Invalid surgery date/time for case ${c.caseId}`);
  }
  return d.toISOString();
}

export class PostingService {
  private readonly newId: () => string;

  constructor(private readonly deps: PostingServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
  }

  /** Prepare the first posting for an approved slot. */
  prepare(input: { case: PostingCase; order: SignedOrder }): Promise<PostingResult> {
    return this.submit('initial', input.case, input.order);
  }

  /** A change to a case already posted: sends an updated posting after approval. */
  async change(input: { case: PostingCase; order: SignedOrder }): Promise<PostingResult> {
    const history = await this.deps.store.listByCase(input.case.practiceId, input.case.caseId);
    const hasPosted = history.some(
      (s) => (s.kind === 'initial' || s.kind === 'update') && (s.status === 'sent' || s.status === 'confirmed'),
    );
    return this.submit(hasPosted ? 'update' : 'initial', input.case, input.order);
  }

  /** Cancel a posting: sends a cancellation notice after approval. */
  async cancel(input: {
    practiceId: PracticeId;
    caseId: string;
    reason: string;
  }): Promise<PostingResult | { status: 'nothing_to_cancel' }> {
    if (!this.deps.enabled) return { status: 'disabled' };
    const history = await this.deps.store.listByCase(input.practiceId, input.caseId);
    const latest = this.latestPosting(history);
    if (!latest || latest.kind === 'cancellation') return { status: 'nothing_to_cancel' };
    const entry = await this.entry(latest.practiceId, latest.facilityId);
    if (entry.siteType === 'office_procedure_room') {
      return { status: 'not_required', reason: 'office_procedure_room' };
    }
    const wasSent = latest.status === 'sent' || latest.status === 'confirmed';
    await this.supersedePending(history);
    if (!wasSent) return { status: 'nothing_to_cancel' };
    const document = renderCancellation(
      entry.postingFormat,
      latest.caseSnapshot,
      input.reason,
      latest.confirmationNumber,
    );
    return this.queue(this.build('cancellation', latest.caseSnapshot, document, latest.version));
  }

  /** Scheduler approval. The posting is then sent by the route the directory entry names. */
  async approve(practiceId: PracticeId, submissionId: string, approvedBy: string): Promise<Submission> {
    const sub = await this.pending(practiceId, submissionId);
    sub.approvedBy = approvedBy;
    sub.approvalBasis = 'scheduler';
    return this.dispatch(sub, await this.entry(practiceId, sub.facilityId));
  }

  async reject(practiceId: PracticeId, submissionId: string, rejectedBy: string): Promise<Submission> {
    const sub = await this.pending(practiceId, submissionId);
    sub.status = 'rejected';
    sub.approvedBy = rejectedBy;
    await this.deps.store.save(sub);
    return sub;
  }

  /** Record the facility's confirmation number (called by the inbound matcher). */
  async recordConfirmation(input: InboundConfirmation): Promise<Submission | undefined> {
    const history = await this.deps.store.listByCase(input.practiceId, input.caseId);
    const awaiting = [...history].reverse().find((s) => s.status === 'sent');
    if (!awaiting) return undefined;
    const now = this.deps.clock.now().toISOString();
    awaiting.status = 'confirmed';
    awaiting.confirmationNumber = input.confirmationNumber;
    awaiting.confirmedAt = now;
    await this.deps.store.save(awaiting);
    if (awaiting.kind === 'reconfirmation' && awaiting.parentId) {
      const parent = await this.deps.store.get(input.practiceId, awaiting.parentId);
      if (parent) {
        parent.reconfirmedAt = now;
        parent.reconfirmationNumber = input.confirmationNumber;
        await this.deps.store.save(parent);
      }
    }
    return awaiting;
  }

  /**
   * Queue a reconfirmation request for each posted case whose surgery starts within 72 hours
   * and has not been asked yet. Reconfirmations are approve-first like every other send.
   */
  async runReconfirmations(practiceId: PracticeId): Promise<Submission[]> {
    if (!this.deps.enabled) return [];
    const now = this.deps.clock.now().getTime();
    const horizon = now + RECONFIRM_WINDOW_HOURS * 3_600_000;
    const all = await this.deps.store.listByPractice(practiceId);
    const byCase = new Map<string, Submission[]>();
    for (const s of all) byCase.set(s.caseId, [...(byCase.get(s.caseId) ?? []), s]);
    const created: Submission[] = [];
    for (const history of byCase.values()) {
      const latest = this.latestPosting(history);
      if (!latest || latest.kind === 'cancellation') continue;
      if (latest.status !== 'sent' && latest.status !== 'confirmed') continue;
      if (latest.reconfirmRequestedAt) continue;
      const start = new Date(latest.surgeryStartsAt).getTime();
      if (start <= now || start > horizon) continue;
      const entry = await this.entry(practiceId, latest.facilityId);
      const document = renderReconfirmation(
        entry.postingFormat,
        latest.caseSnapshot,
        latest.confirmationNumber,
      );
      const sub = this.build('reconfirmation', latest.caseSnapshot, document, latest.version);
      sub.parentId = latest.id;
      latest.reconfirmRequestedAt = this.deps.clock.now().toISOString();
      await this.deps.store.save(latest);
      const result = await this.queue(sub);
      created.push(result.submission);
    }
    return created;
  }

  // ---- internals ----

  private async submit(
    kind: 'initial' | 'update',
    c: PostingCase,
    order: SignedOrder,
  ): Promise<PostingResult> {
    if (!this.deps.enabled) return { status: 'disabled' };
    const entry = await this.entry(c.practiceId, c.facilityId);
    // Decision to confirm: office procedure room cases need no external posting.
    if (entry.siteType === 'office_procedure_room') {
      return { status: 'not_required', reason: 'office_procedure_room' };
    }
    const verdict = await this.deps.policy.evaluate({
      practiceId: c.practiceId,
      caseId: c.caseId,
      action: 'facility_posting',
    });
    if (verdict.decision === 'deny') return { status: 'denied_by_policy' };

    const history = await this.deps.store.listByCase(c.practiceId, c.caseId);
    const block = this.validate(c, order);
    if (block) {
      const sub = this.build(kind, c, renderPosting(entry.postingFormat, kind, c, 0), 0);
      sub.status = 'blocked';
      sub.blockReason = block.reason;
      sub.mismatches = block.mismatches;
      await this.deps.store.save(sub);
      await this.deps.reviewQueue.escalate({
        practiceId: c.practiceId,
        caseId: c.caseId,
        submissionId: sub.id,
        reason: block.reason,
        mismatches: block.mismatches,
        summary: block.summary,
      });
      return { status: 'blocked', submission: sub, reason: block.reason, mismatches: block.mismatches };
    }

    await this.supersedePending(history);
    const version = history.filter((s) => s.kind === 'initial' || s.kind === 'update').filter((s) => s.status !== 'blocked').length + 1;
    const sub = this.build(kind, c, renderPosting(entry.postingFormat, kind, c, version), version);

    // ADR-0007: an urgent add-on's signed urgent order is the approval.
    if (c.urgentAddOn && order.urgent && order.signed) {
      sub.approvalBasis = 'urgent_signed_order';
      sub.approvedBy = order.orderId;
      return { status: 'sent', submission: await this.dispatch(sub, entry) };
    }
    return this.queue(sub);
  }

  private validate(
    c: PostingCase,
    order: SignedOrder,
  ): { reason: BlockReason; mismatches: Mismatch[]; summary: string } | undefined {
    if (!order.signed || order.caseId !== c.caseId) {
      return { reason: 'order_not_signed', mismatches: [], summary: 'No signed order on file for this case' };
    }
    const missing = missingFields(c);
    if (missing.length > 0) {
      return { reason: 'incomplete', mismatches: [], summary: `Posting is missing: ${missing.join(', ')}` };
    }
    const mismatches = crossCheck(c, order);
    if (mismatches.length > 0) {
      const shown = mismatches.map((m) => `${m.field}: posting "${m.posting}" vs order "${m.order}"`);
      return { reason: 'mismatch', mismatches, summary: `Posting differs from signed order (${shown.join('; ')})` };
    }
    return undefined;
  }

  private build(
    kind: Submission['kind'],
    c: PostingCase,
    document: Submission['document'],
    version: number,
  ): Submission {
    return {
      id: this.newId(),
      practiceId: c.practiceId,
      caseId: c.caseId,
      facilityId: c.facilityId,
      kind,
      version,
      status: 'pending_approval',
      document,
      caseSnapshot: c,
      surgeryStartsAt: startsAtIso(c),
      createdAt: this.deps.clock.now().toISOString(),
    };
  }

  private async queue(sub: Submission): Promise<{ status: 'pending_approval'; submission: Submission }> {
    await this.deps.store.save(sub);
    await this.deps.reviewQueue.enqueueForApproval({
      practiceId: sub.practiceId,
      caseId: sub.caseId,
      submissionId: sub.id,
      summary: `Approve ${sub.kind} to facility: ${sub.document.subject}`,
    });
    return { status: 'pending_approval', submission: sub };
  }

  /** Route chosen from the directory entry: direct scheduling when available, else its channel. */
  private async dispatch(sub: Submission, entry: FacilityDirectoryEntry): Promise<Submission> {
    const direct = entry.directScheduling;
    if (direct?.available && this.deps.directRoute) {
      const res = await this.deps.directRoute.submit({
        practiceId: sub.practiceId,
        caseId: sub.caseId,
        systemId: direct.systemId,
        document: sub.document,
      });
      if (res.accepted) {
        sub.route = 'direct_scheduling';
        if (res.reference) sub.messageId = res.reference;
      }
    }
    if (!sub.route) {
      const res = await this.deps.sendTool.send({
        practiceId: sub.practiceId,
        caseId: sub.caseId,
        channel: entry.channel,
        document: sub.document,
      });
      sub.route = 'directory_channel';
      sub.messageId = res.messageId;
    }
    sub.status = 'sent';
    sub.sentAt = this.deps.clock.now().toISOString();
    await this.deps.store.save(sub);
    return sub;
  }

  private async entry(practiceId: PracticeId, facilityId: string): Promise<FacilityDirectoryEntry> {
    const entry = await this.deps.directory.get(practiceId, facilityId);
    if (!entry) throw new PostingError(`Facility ${facilityId} is not in the directory`);
    return entry;
  }

  private async pending(practiceId: PracticeId, id: string): Promise<Submission> {
    const sub = await this.deps.store.get(practiceId, id);
    if (!sub) throw new PostingError(`Submission ${id} not found`);
    if (sub.status !== 'pending_approval') {
      throw new PostingError(`Submission ${id} is ${sub.status}, not pending approval`);
    }
    return sub;
  }

  private latestPosting(history: Submission[]): Submission | undefined {
    return [...history]
      .reverse()
      .find((s) => s.kind !== 'reconfirmation' && s.status !== 'blocked' && s.status !== 'superseded' && s.status !== 'rejected');
  }

  private async supersedePending(history: Submission[]): Promise<void> {
    for (const s of history) {
      if (s.status === 'pending_approval') {
        s.status = 'superseded';
        await this.deps.store.save(s);
      }
    }
  }
}
