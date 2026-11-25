import type { CaseReadiness, TrackedCase } from '@scheduler/case-model';

export type ReminderJourney = 'outreach' | 'coordination';

export interface ReminderRequest {
  readonly practiceId: string;
  readonly caseId: string;
  readonly itemId: string;
  readonly itemLabel: string;
  readonly journey: ReminderJourney;
  readonly reason: string;
}

/** Asks the owning journey to remind. The sweep never sends messages itself. */
export interface ReminderPort {
  requestReminder(request: ReminderRequest): Promise<void>;
}

export interface TodayEscalation {
  readonly practiceId: string;
  readonly caseId: string;
  readonly itemId: string;
  readonly kind: 'cutoff' | 'expired' | 'surgeon_decision';
  readonly title: string;
  /** Stable key so repeated hourly sweeps do not create duplicate Today items. */
  readonly dedupeKey: string;
}

export interface EscalationPort {
  escalateToToday(escalation: TodayEscalation): Promise<void>;
}

export interface ReadinessStore {
  listTrackedCases(): Promise<readonly TrackedCase[]>;
  /** Reopen an expired item. */
  reopenItem(caseId: string, itemId: string): Promise<void>;
  recordReminder(caseId: string, itemId: string, at: Date): Promise<void>;
  saveStatus(caseId: string, readiness: CaseReadiness): Promise<void>;
}

export interface Clock {
  now(): Date;
}
