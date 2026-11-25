import type { CancellationReason, CaseHistoryRecord, MetricAuditEvent } from './ports.js';

/** Bump when any formula below changes, so stored numbers stay comparable. */
export const METRIC_DEFINITIONS_VERSION = 1;

export const LATE_CANCELLATION_HOURS = 72;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const REASONS: readonly CancellationReason[] = [
  'patient_request',
  'illness',
  'transport',
  'insurance',
  'facility',
  'surgeon',
  'other',
];

/** Aggregates only: counts and rates, no case ids, no patient data. */
export interface WeeklyPracticeMetrics {
  definitionsVersion: number;
  practiceId: string;
  /** Monday of the week, UTC, YYYY-MM-DD. */
  weekStart: string;
  agentActions: number;
  edits: number;
  rejections: number;
  /** (edits + rejections) / agent actions, or null with no actions. */
  correctionRate: number | null;
  activeCases: number;
  schedulerMinutesPerCase: number | null;
  lateCancellationsByReason: Record<CancellationReason, number>;
  lateCancellations: number;
  authDecisions: number;
  daysOrderToAuthDecision: number | null;
  authFirstPassRate: number | null;
  authDenials: number;
  patientInboundCalls: number;
  patientCallsPerCase: number | null;
}

export function weekStartOf(iso: string): string {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
  return new Date(monday).toISOString().slice(0, 10);
}

export const correctionRate = (edits: number, rejections: number, actions: number): number | null =>
  actions === 0 ? null : (edits + rejections) / actions;

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function emptyReasons(): Record<CancellationReason, number> {
  return Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<CancellationReason, number>;
}

interface Acc {
  actions: number;
  edits: number;
  rejections: number;
  minutes: number;
  minuteCases: Set<string>;
  cases: Set<string>;
  calls: number;
  reasons: Record<CancellationReason, number>;
  decisions: number;
  firstPass: number;
  decisionDays: number;
  denials: number;
}

/** Pure: events and case history for one practice in, one row per week out. */
export function computeWeeklyMetrics(
  practiceId: string,
  events: MetricAuditEvent[],
  cases: CaseHistoryRecord[],
): WeeklyPracticeMetrics[] {
  const weeks = new Map<string, Acc>();
  const get = (iso: string): Acc => {
    const key = weekStartOf(iso);
    let a = weeks.get(key);
    if (!a) {
      a = {
        actions: 0, edits: 0, rejections: 0, minutes: 0, minuteCases: new Set(), cases: new Set(),
        calls: 0, reasons: emptyReasons(), decisions: 0, firstPass: 0, decisionDays: 0, denials: 0,
      };
      weeks.set(key, a);
    }
    return a;
  };

  for (const e of events) {
    if (e.practiceId !== practiceId) continue;
    const a = get(e.occurredAt);
    if (e.caseId) a.cases.add(e.caseId);
    if (e.kind === 'agent_action') a.actions++;
    else if (e.kind === 'action_edited') a.edits++;
    else if (e.kind === 'action_rejected') a.rejections++;
    else if (e.kind === 'patient_inbound_call') a.calls++;
    else if (e.kind === 'workspace_activity') {
      a.minutes += e.minutes ?? 0;
      if (e.caseId) a.minuteCases.add(e.caseId);
    }
  }

  for (const c of cases) {
    if (c.practiceId !== practiceId) continue;
    if (c.cancellation) {
      const { cancelledAt, scheduledFor, reason } = c.cancellation;
      const lead = Date.parse(scheduledFor) - Date.parse(cancelledAt);
      if (lead >= 0 && lead < LATE_CANCELLATION_HOURS * HOUR_MS) {
        get(cancelledAt).reasons[REASONS.includes(reason) ? reason : 'other']++;
      }
    }
    if (c.authDecisionAt) {
      const a = get(c.authDecisionAt);
      a.decisions++;
      a.decisionDays += (Date.parse(c.authDecisionAt) - Date.parse(c.orderedAt)) / DAY_MS;
      if (c.authFirstPass) a.firstPass++;
      if (c.authDecision === 'denied') a.denials++;
    }
  }

  return [...weeks.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([weekStart, a]) => ({
      definitionsVersion: METRIC_DEFINITIONS_VERSION,
      practiceId,
      weekStart,
      agentActions: a.actions,
      edits: a.edits,
      rejections: a.rejections,
      correctionRate: correctionRate(a.edits, a.rejections, a.actions),
      activeCases: a.cases.size,
      schedulerMinutesPerCase: ratio(a.minutes, a.minuteCases.size),
      lateCancellationsByReason: a.reasons,
      lateCancellations: Object.values(a.reasons).reduce((s, n) => s + n, 0),
      authDecisions: a.decisions,
      daysOrderToAuthDecision: ratio(a.decisionDays, a.decisions),
      authFirstPassRate: ratio(a.firstPass, a.decisions),
      authDenials: a.denials,
      patientInboundCalls: a.calls,
      patientCallsPerCase: ratio(a.calls, a.cases.size),
    }));
}
