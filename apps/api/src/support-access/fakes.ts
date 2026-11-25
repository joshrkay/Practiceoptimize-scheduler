import type {
  AuditPort,
  Clock,
  GrantStore,
  IdGenerator,
  PracticeNotification,
  PracticeNotifier,
  SupportSessionPort,
} from './ports.js';
import type { AccessLogFilter, GrantId, PracticeId, SupportAuditEvent, SupportGrant } from './types.js';

export class FakeClock implements Clock {
  private current: number;
  constructor(start = '2026-01-05T12:00:00.000Z') {
    this.current = Date.parse(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current += ms;
  }
  advanceHours(hours: number): void {
    this.advanceMs(hours * 3_600_000);
  }
}

export class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `grant-${this.n}`;
  }
}

export class InMemoryGrantStore implements GrantStore {
  private readonly grants = new Map<GrantId, SupportGrant>();
  async get(id: GrantId): Promise<SupportGrant | undefined> {
    const g = this.grants.get(id);
    return g ? structuredClone(g) : undefined;
  }
  async save(grant: SupportGrant): Promise<void> {
    this.grants.set(grant.id, structuredClone(grant));
  }
  async list(filter: { practiceId?: PracticeId; requesterUserId?: string }): Promise<readonly SupportGrant[]> {
    return [...this.grants.values()]
      .filter(
        (g) =>
          (filter.practiceId === undefined || g.practiceId === filter.practiceId) &&
          (filter.requesterUserId === undefined || g.requesterUserId === filter.requesterUserId),
      )
      .map((g) => structuredClone(g));
  }
}

export class InMemoryAudit implements AuditPort {
  readonly events: SupportAuditEvent[] = [];
  failNext = false;
  async record(event: SupportAuditEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('audit unavailable');
    }
    this.events.push(event);
  }
  async query(practiceId: PracticeId, f: AccessLogFilter): Promise<readonly SupportAuditEvent[]> {
    const out = this.events.filter(
      (e) =>
        e.practiceId === practiceId &&
        (f.grantId === undefined || e.grantId === f.grantId) &&
        (f.caseId === undefined || e.caseId === f.caseId) &&
        (f.from === undefined || e.at >= f.from) &&
        (f.to === undefined || e.at <= f.to),
    );
    return f.limit === undefined ? out : out.slice(0, f.limit);
  }
}

export class FakeSessions implements SupportSessionPort {
  readonly live = new Map<string, { grantId: GrantId; userId: string }>();
  failEnd = false;
  private n = 0;
  async open(input: { grantId: GrantId; userId: string }): Promise<string> {
    this.n += 1;
    const id = `sess-${this.n}`;
    this.live.set(id, { grantId: input.grantId, userId: input.userId });
    return id;
  }
  async endForGrant(grantId: GrantId): Promise<number> {
    if (this.failEnd) throw new Error('session store unavailable');
    let count = 0;
    for (const [id, s] of this.live) {
      if (s.grantId === grantId) {
        this.live.delete(id);
        count += 1;
      }
    }
    return count;
  }
}

export class FakeNotifier implements PracticeNotifier {
  readonly sent: PracticeNotification[] = [];
  fail = false;
  async notify(n: PracticeNotification): Promise<void> {
    if (this.fail) throw new Error('notifier down');
    this.sent.push(n);
  }
}
