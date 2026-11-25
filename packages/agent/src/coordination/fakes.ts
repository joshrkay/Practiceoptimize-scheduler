/** In-memory implementations of the coordination ports, for tests and local runs. */
import type { CaseSnapshot } from './journey.js';
import type {
  ApprovalAction,
  ApprovalPolicy,
  CareTeamDirectory,
  CaseReader,
  CaseRiskSignal,
  Clock,
  CoordinationRequestStore,
  IdGenerator,
  OutboundMessage,
  OutboundSender,
  PartyContact,
  ReviewQueue,
  SchedulerTask,
  SchedulerTaskQueue,
} from './ports.js';
import { DuplicateActiveRequestError } from './ports.js';
import type { CoordinationRequest, PartyRole } from './requests.js';
import { idempotencyKey, isActive } from './requests.js';

export class FakeClock implements Clock {
  private current: Date;
  constructor(start: string | Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceHours(hours: number): void {
    this.current = new Date(this.current.getTime() + hours * 60 * 60 * 1000);
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;
  constructor(private readonly prefix = 'coord-req') {}
  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }
}

export class InMemoryCaseReader implements CaseReader {
  private readonly cases = new Map<string, CaseSnapshot>();
  put(snapshot: CaseSnapshot): void {
    this.cases.set(`${snapshot.practiceId}|${snapshot.caseId}`, { ...snapshot });
  }
  async getCase(practiceId: string, caseId: string): Promise<CaseSnapshot | null> {
    return this.cases.get(`${practiceId}|${caseId}`) ?? null;
  }
}

export class InMemoryDirectory implements CareTeamDirectory {
  private readonly parties = new Map<string, PartyContact>();
  put(practiceId: string, caseId: string, contact: PartyContact): void {
    this.parties.set(`${practiceId}|${caseId}|${contact.role}`, contact);
  }
  async resolveParty(practiceId: string, caseId: string, role: PartyRole): Promise<PartyContact | null> {
    return this.parties.get(`${practiceId}|${caseId}|${role}`) ?? null;
  }
}

export class RecordingSender implements OutboundSender {
  readonly sent: OutboundMessage[] = [];
  async send(message: OutboundMessage): Promise<{ messageId: string }> {
    this.sent.push(message);
    return { messageId: `msg-${this.sent.length}` };
  }
}

export class FakeApprovalPolicy implements ApprovalPolicy {
  readonly asked: ApprovalAction[] = [];
  constructor(private readonly approveFirstTypes: ReadonlySet<string> = new Set()) {}
  async requiresApproval(action: ApprovalAction): Promise<boolean> {
    this.asked.push(action);
    return this.approveFirstTypes.has(action.requestType);
  }
}

export class InMemoryReviewQueue implements ReviewQueue {
  readonly items: { reviewItemId: string; requestId: string; withdrawn: string | null }[] = [];
  async submit(item: Parameters<ReviewQueue['submit']>[0]): Promise<{ reviewItemId: string }> {
    const reviewItemId = `review-${this.items.length + 1}`;
    this.items.push({ reviewItemId, requestId: item.requestId, withdrawn: null });
    return { reviewItemId };
  }
  async withdraw(_practiceId: string, reviewItemId: string, reason: string): Promise<void> {
    const item = this.items.find((candidate) => candidate.reviewItemId === reviewItemId);
    if (item) item.withdrawn = reason;
  }
}

export class InMemoryTaskQueue implements SchedulerTaskQueue {
  readonly tasks: (SchedulerTask & { taskId: string })[] = [];
  async createTask(task: SchedulerTask): Promise<{ taskId: string }> {
    const existing = this.tasks.find((candidate) => candidate.idempotencyKey === task.idempotencyKey);
    if (existing) return { taskId: existing.taskId };
    const taskId = `task-${this.tasks.length + 1}`;
    this.tasks.push({ ...task, taskId });
    return { taskId };
  }
}

export class RecordingRiskSignal implements CaseRiskSignal {
  readonly raised: { caseId: string; requestId: string }[] = [];
  readonly cleared: { caseId: string; requestId: string }[] = [];
  async raise(signal: { caseId: string; requestId: string }): Promise<void> {
    this.raised.push({ caseId: signal.caseId, requestId: signal.requestId });
  }
  async clear(signal: { caseId: string; requestId: string }): Promise<void> {
    this.cleared.push({ caseId: signal.caseId, requestId: signal.requestId });
  }
}

/** Mirrors the table's partial unique index: one active request per practice, case, party and type. */
export class InMemoryCoordinationRequestStore implements CoordinationRequestStore {
  private readonly rows = new Map<string, CoordinationRequest>();

  async insert(request: CoordinationRequest): Promise<void> {
    if (isActive(request)) {
      const key = idempotencyKey(request);
      for (const row of this.rows.values()) {
        if (isActive(row) && idempotencyKey(row) === key) throw new DuplicateActiveRequestError(key);
      }
    }
    this.rows.set(request.id, structuredClone(request));
  }

  async update(request: CoordinationRequest): Promise<void> {
    const existing = this.rows.get(request.id);
    if (!existing || existing.practiceId !== request.practiceId) {
      throw new Error(`Coordination request ${request.id} not found`);
    }
    this.rows.set(request.id, structuredClone(request));
  }

  async get(practiceId: string, requestId: string): Promise<CoordinationRequest | null> {
    const row = this.rows.get(requestId);
    return row && row.practiceId === practiceId ? structuredClone(row) : null;
  }

  async listByCase(practiceId: string, caseId: string): Promise<CoordinationRequest[]> {
    return [...this.rows.values()]
      .filter((row) => row.practiceId === practiceId && row.caseId === caseId)
      .map((row) => structuredClone(row));
  }

  async listActive(practiceId: string): Promise<CoordinationRequest[]> {
    return [...this.rows.values()]
      .filter((row) => row.practiceId === practiceId && isActive(row))
      .map((row) => structuredClone(row));
  }
}
