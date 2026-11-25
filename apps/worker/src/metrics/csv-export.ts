import type { WeeklyPracticeMetrics } from './definitions.js';

const COLUMNS = [
  'definitions_version', 'practice_id', 'week_start', 'agent_actions', 'edits', 'rejections',
  'correction_rate', 'scheduler_minutes_per_case', 'late_cancellations', 'late_cancellations_by_reason',
  'auth_decisions', 'days_order_to_auth_decision', 'auth_first_pass_rate', 'auth_denials',
  'patient_inbound_calls', 'patient_calls_per_case',
];

const num = (n: number | null): string => (n === null ? '' : String(Math.round(n * 10000) / 10000));

function cell(v: string): string {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Aggregate rows only. Nothing here can carry patient data. */
export function metricsToCsv(rows: WeeklyPracticeMetrics[]): string {
  const lines = rows.map((r) =>
    [
      String(r.definitionsVersion), r.practiceId, r.weekStart, String(r.agentActions), String(r.edits),
      String(r.rejections), num(r.correctionRate), num(r.schedulerMinutesPerCase),
      String(r.lateCancellations),
      Object.entries(r.lateCancellationsByReason).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(';'),
      String(r.authDecisions), num(r.daysOrderToAuthDecision), num(r.authFirstPassRate),
      String(r.authDenials), String(r.patientInboundCalls), num(r.patientCallsPerCase),
    ].map(cell).join(','),
  );
  return [COLUMNS.join(','), ...lines].join('\n') + '\n';
}
