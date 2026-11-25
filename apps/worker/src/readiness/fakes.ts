import type { CaseReadiness, TrackedCase } from '@scheduler/case-model';
import type {
  Clock,
  EscalationPort,
  ReadinessStore,
  ReminderPort,
  ReminderRequest,
  TodayEscalation,
} from './ports';

export class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advanceHours(h: number): void {
    this.current = new Date(this.current.getTime() + h * 3_600_000);
  }
}

export class FakeReminders implements ReminderPort {
  readonly requests: ReminderRequest[] = [];
  requestReminder(request: ReminderRequest): Promise<void> {
    this.requests.push(request);
    return Promise.resolve();
  }
}

/** Idempotent on dedupeKey, like the real Today view should be. */
export class FakeEscalations implements EscalationPort {
  readonly items = new Map<string, TodayEscalation>();
  escalateToToday(e: TodayEscalation): Promise<void> {
    this.items.set(e.dedupeKey, e);
    return Promise.resolve();
  }
}

export class FakeStore implements ReadinessStore {
  readonly statuses = new Map<string, CaseReadiness>();
  readonly reopened: string[] = [];
  failFor: string | undefined;
  constructor(private cases: TrackedCase[]) {}

  listTrackedCases(): Promise<readonly TrackedCase[]> {
    return Promise.resolve(this.cases);
  }
  reopenItem(caseId: string, itemId: string): Promise<void> {
    if (caseId === this.failFor) return Promise.reject(new Error('store down'));
    this.reopened.push(`${caseId}:${itemId}`);
    return Promise.resolve();
  }
  recordReminder(caseId: string, itemId: string, at: Date): Promise<void> {
    this.cases = this.cases.map((c) =>
      c.caseId !== caseId
        ? c
        : { ...c, items: c.items.map((i) => (i.id === itemId ? { ...i, lastReminderAt: at } : i)) },
    );
    return Promise.resolve();
  }
  saveStatus(caseId: string, readiness: CaseReadiness): Promise<void> {
    this.statuses.set(caseId, readiness);
    return Promise.resolve();
  }
}
