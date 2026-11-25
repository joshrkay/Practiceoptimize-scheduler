import type {
  CaseDirectory,
  CaseUpdates,
  ChangePlanInput,
  ChangeRequestInput,
  ClassifierResult,
  Clock,
  Messenger,
  OptOuts,
  OutboundMessage,
  PendingChange,
  PendingChangeStore,
  PracticeDirectory,
  ReplyAudit,
  ReplyAuditEvent,
  ReplyCase,
  ReplyClassifier,
  ReplyFlags,
  ReviewQueue,
  SlotOffer,
  SlotOffers,
  TaskInput,
  TaskQueue,
  WebhookSecrets,
} from './ports.js';

/** In-memory fakes for tests and local wiring. */

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceHours(hours: number): void {
    this.current = new Date(this.current.getTime() + hours * 3_600_000);
  }
}

export class FakePractices implements PracticeDirectory, WebhookSecrets {
  constructor(
    private readonly byNumber: Record<string, string>,
    private readonly secrets: Record<string, string>,
  ) {}
  async practiceIdForNumber(n: string): Promise<string | null> {
    return this.byNumber[n] ?? null;
  }
  async inboundSecret(practiceId: string): Promise<string | null> {
    return this.secrets[practiceId] ?? null;
  }
}

export class FakeCases implements CaseDirectory, CaseUpdates {
  confirmed: string[] = [];
  replies: string[] = [];
  failLookup = false;
  failRecordReply = false;
  constructor(readonly cases: Map<string, ReplyCase & { practiceId: string; patientNumber: string }> = new Map()) {}
  add(c: ReplyCase & { practiceId: string; patientNumber: string }): void {
    this.cases.set(c.caseId, c);
  }
  async findCaseForPatientNumber(practiceId: string, patientNumber: string): Promise<ReplyCase | null> {
    if (this.failLookup) throw new Error('lookup down');
    for (const c of this.cases.values()) {
      if (c.practiceId === practiceId && c.patientNumber === patientNumber) return c;
    }
    return null;
  }
  async listAwaitingConfirmation(practiceId: string): Promise<ReplyCase[]> {
    return [...this.cases.values()].filter(
      (c) => c.practiceId === practiceId && c.confirmationSentAt && !c.confirmedAt,
    );
  }
  async markConfirmed(_practiceId: string, caseId: string, at: Date): Promise<void> {
    const c = this.cases.get(caseId);
    if (c) c.confirmedAt = at;
    this.confirmed.push(caseId);
  }
  async recordReply(_practiceId: string, caseId: string, at: Date): Promise<void> {
    if (this.failRecordReply) throw new Error('write failed');
    const c = this.cases.get(caseId);
    if (c) c.repliedAt = at;
    this.replies.push(caseId);
  }
}

export class FakeMessenger implements Messenger {
  sent: OutboundMessage[] = [];
  fail = false;
  async send(m: OutboundMessage): Promise<void> {
    if (this.fail) throw new Error('provider down');
    this.sent.push(m);
  }
}

export class FakeOptOuts implements OptOuts {
  optedOut: { practiceId: string; patientNumber: string; patientId: string | null }[] = [];
  async optOutAllChannels(practiceId: string, patientNumber: string, patientId: string | null): Promise<void> {
    this.optedOut.push({ practiceId, patientNumber, patientId });
  }
}

export class FakeTasks implements TaskQueue {
  tasks: TaskInput[] = [];
  fail = false;
  async createTask(t: TaskInput): Promise<void> {
    if (this.fail) throw new Error('queue down');
    if (!this.tasks.some((x) => x.dedupeKey === t.dedupeKey)) this.tasks.push(t);
  }
}

export class FakeReviewQueue implements ReviewQueue {
  plans: ChangePlanInput[] = [];
  requests: ChangeRequestInput[] = [];
  async submitChangePlan(p: ChangePlanInput): Promise<void> {
    this.plans.push(p);
  }
  async submitChangeRequest(r: ChangeRequestInput): Promise<void> {
    this.requests.push(r);
  }
}

export class FakeSlotOffers implements SlotOffers {
  offer: SlotOffer | null = { url: 'https://example.test/pick/abc', slotIds: ['s1', 's2', 's3'] };
  async proposeSlots(): Promise<SlotOffer | null> {
    return this.offer;
  }
}

export class FakePendingStore implements PendingChangeStore {
  items = new Map<string, PendingChange>();
  async add(c: PendingChange): Promise<void> {
    this.items.set(c.requestId, { ...c });
  }
  async get(id: string): Promise<PendingChange | null> {
    return this.items.get(id) ?? null;
  }
  async close(id: string, status: 'picked' | 'expired'): Promise<boolean> {
    const c = this.items.get(id);
    if (!c || c.status !== 'open') return false;
    c.status = status;
    return true;
  }
  async listOpenExpiringBy(now: Date): Promise<PendingChange[]> {
    return [...this.items.values()].filter((c) => c.status === 'open' && c.expiresAt <= now);
  }
}

export class FakeAudit implements ReplyAudit {
  events: ReplyAuditEvent[] = [];
  fail = false;
  async record(e: ReplyAuditEvent): Promise<void> {
    if (this.fail) throw new Error('audit down');
    this.events.push(e);
  }
}

export class FakeFlags implements ReplyFlags {
  constructor(public enabled = true) {}
  async patientRepliesEnabled(): Promise<boolean> {
    return this.enabled;
  }
}

/** Scripted classifier: returns queued results (or throws queued errors) and records its inputs. */
export class ScriptedClassifier implements ReplyClassifier {
  inputs: string[] = [];
  constructor(private script: (ClassifierResult | Error)[] = []) {}
  async classify(text: string): Promise<ClassifierResult> {
    this.inputs.push(text);
    const next = this.script.shift();
    if (!next) throw new Error('classifier script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
}
