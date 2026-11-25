import type {
  Clock,
  DirectSchedulingRoute,
  FacilityDirectory,
  PostingPolicy,
  ReviewItem,
  ReviewQueue,
  SendTool,
  SubmissionStore,
} from './ports.js';
import type { FacilityDirectoryEntry, Mismatch, PracticeId, Submission } from './types.js';

export class FakeDirectory implements FacilityDirectory {
  private readonly entries = new Map<string, FacilityDirectoryEntry>();
  add(practiceId: PracticeId, entry: FacilityDirectoryEntry): void {
    this.entries.set(`${practiceId}/${entry.facilityId}`, entry);
  }
  async get(practiceId: PracticeId, facilityId: string) {
    return this.entries.get(`${practiceId}/${facilityId}`);
  }
}

export class FakeSendTool implements SendTool {
  readonly sent: Parameters<SendTool['send']>[0][] = [];
  async send(request: Parameters<SendTool['send']>[0]) {
    this.sent.push(request);
    return { messageId: `msg-${this.sent.length}` };
  }
}

export class FakeDirectRoute implements DirectSchedulingRoute {
  readonly submitted: Parameters<DirectSchedulingRoute['submit']>[0][] = [];
  accept = true;
  async submit(request: Parameters<DirectSchedulingRoute['submit']>[0]) {
    this.submitted.push(request);
    return this.accept ? { accepted: true, reference: 'direct-1' } : { accepted: false };
  }
}

export class FakePolicy implements PostingPolicy {
  decision: 'approve_first' | 'deny' = 'approve_first';
  async evaluate() {
    return { decision: this.decision };
  }
}

export class FakeReviewQueue implements ReviewQueue {
  readonly approvals: ReviewItem[] = [];
  readonly escalations: (ReviewItem & { reason: string; mismatches: Mismatch[] })[] = [];
  async enqueueForApproval(item: ReviewItem) {
    this.approvals.push(item);
  }
  async escalate(item: ReviewItem & { reason: string; mismatches: Mismatch[] }) {
    this.escalations.push(item);
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  set(date: Date): void {
    this.current = date;
  }
}

export class InMemorySubmissionStore implements SubmissionStore {
  private readonly rows = new Map<string, Submission>();
  async save(submission: Submission) {
    this.rows.set(`${submission.practiceId}/${submission.id}`, { ...submission });
  }
  async get(practiceId: PracticeId, id: string) {
    const row = this.rows.get(`${practiceId}/${id}`);
    return row ? { ...row } : undefined;
  }
  async listByPractice(practiceId: PracticeId) {
    return [...this.rows.values()].filter((r) => r.practiceId === practiceId).map((r) => ({ ...r }));
  }
  async listByCase(practiceId: PracticeId, caseId: string) {
    return (await this.listByPractice(practiceId)).filter((r) => r.caseId === caseId);
  }
}
