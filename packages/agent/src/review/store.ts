import type { PracticeId } from './ports';
import type { FeedbackRecord, ReviewItem, ReviewStatus, Takeover } from './types';

export interface ReviewListFilter {
  readonly status?: ReviewStatus;
  readonly caseId?: string;
}

/** Persistence for the queue. Every method is scoped by practice. */
export interface ReviewStore {
  insert(item: ReviewItem): Promise<void>;
  get(practiceId: PracticeId, id: string): Promise<ReviewItem | undefined>;
  list(practiceId: PracticeId, filter?: ReviewListFilter): Promise<ReviewItem[]>;
  /** Atomic compare-and-set on status: returns the updated item, or undefined if status differed. */
  transition(
    practiceId: PracticeId,
    id: string,
    from: ReviewStatus,
    patch: Partial<ReviewItem> & { status: ReviewStatus },
  ): Promise<ReviewItem | undefined>;
  addFeedback(record: FeedbackRecord): Promise<void>;
  listFeedback(practiceId: PracticeId): Promise<FeedbackRecord[]>;
  setTakeover(takeover: Takeover): Promise<boolean>;
  clearTakeover(practiceId: PracticeId, caseId: string): Promise<boolean>;
  getTakeover(practiceId: PracticeId, caseId: string): Promise<Takeover | undefined>;
}

export class InMemoryReviewStore implements ReviewStore {
  private readonly items = new Map<string, ReviewItem>();
  private readonly feedback: FeedbackRecord[] = [];
  private readonly takeovers = new Map<string, Takeover>();

  private key(practiceId: PracticeId, id: string): string {
    return `${practiceId}\u0000${id}`;
  }

  async insert(item: ReviewItem): Promise<void> {
    this.items.set(this.key(item.practiceId, item.id), item);
  }

  async get(practiceId: PracticeId, id: string): Promise<ReviewItem | undefined> {
    return this.items.get(this.key(practiceId, id));
  }

  async list(practiceId: PracticeId, filter: ReviewListFilter = {}): Promise<ReviewItem[]> {
    return [...this.items.values()]
      .filter((i) => i.practiceId === practiceId)
      .filter((i) => filter.status === undefined || i.status === filter.status)
      .filter((i) => filter.caseId === undefined || i.caseId === filter.caseId)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.id.localeCompare(b.id));
  }

  async transition(
    practiceId: PracticeId,
    id: string,
    from: ReviewStatus,
    patch: Partial<ReviewItem> & { status: ReviewStatus },
  ): Promise<ReviewItem | undefined> {
    const k = this.key(practiceId, id);
    const current = this.items.get(k);
    if (current?.status !== from) return undefined;
    const next = { ...current, ...patch };
    this.items.set(k, next);
    return next;
  }

  async addFeedback(record: FeedbackRecord): Promise<void> {
    this.feedback.push(record);
  }

  async listFeedback(practiceId: PracticeId): Promise<FeedbackRecord[]> {
    return this.feedback.filter((f) => f.practiceId === practiceId);
  }

  async setTakeover(takeover: Takeover): Promise<boolean> {
    const k = this.key(takeover.practiceId, takeover.caseId);
    if (this.takeovers.has(k)) return false;
    this.takeovers.set(k, takeover);
    return true;
  }

  async clearTakeover(practiceId: PracticeId, caseId: string): Promise<boolean> {
    return this.takeovers.delete(this.key(practiceId, caseId));
  }

  async getTakeover(practiceId: PracticeId, caseId: string): Promise<Takeover | undefined> {
    return this.takeovers.get(this.key(practiceId, caseId));
  }
}
