import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GATE_A,
  InMemoryMetricsSource,
  METRIC_DEFINITIONS_VERSION,
  baselineFor,
  computeWeeklyMetrics,
  evaluateGateA,
  importBaseline,
  metricsToCsv,
  weekStartOf,
  type CaseHistoryRecord,
  type MetricAuditEvent,
} from './index.js';

const P = 'practice-podiatry-a';
const WEEK = '2026-03-02T10:00:00Z'; // Monday

function actions(n: number, kind: MetricAuditEvent['kind'], practiceId = P): MetricAuditEvent[] {
  return Array.from({ length: n }, () => ({ practiceId, kind, occurredAt: WEEK }));
}

describe('correction rate', () => {
  it('scenario 1: 8 edits + 2 rejections of 500 actions = 2.0%, which is not under 2%', () => {
    const events = [
      ...actions(500, 'agent_action'),
      ...actions(8, 'action_edited'),
      ...actions(2, 'action_rejected'),
      ...actions(50, 'agent_action', 'other-practice'),
    ];
    const [week, ...rest] = computeWeeklyMetrics(P, events, []);
    expect(rest).toHaveLength(0);
    expect(week?.definitionsVersion).toBe(METRIC_DEFINITIONS_VERSION);
    expect(week?.correctionRate).toBeCloseTo(0.02, 10);
    const gate = evaluateGateA({ edits: 8, rejections: 2, agentActions: 500, baselineMinutes: null, currentMinutes: null });
    expect(gate.correctionRatePct).toBe(2.0);
    expect(gate.correctionPass).toBe(false);
    expect(GATE_A.maxCorrectionRate).toBe(0.02);
  });

  it('passes below 2% and handles zero actions', () => {
    expect(evaluateGateA({ edits: 5, rejections: 4, agentActions: 500, baselineMinutes: null, currentMinutes: null }).correctionPass).toBe(true);
    const none = evaluateGateA({ edits: 0, rejections: 0, agentActions: 0, baselineMinutes: null, currentMinutes: null });
    expect(none.correctionPass).toBeNull();
    expect(none.pass).toBeNull();
  });
});

describe('baseline comparison', () => {
  it('scenario 2: 42 to 27 minutes shows -36% against the -30% target', () => {
    const g = evaluateGateA({ edits: 1, rejections: 0, agentActions: 500, baselineMinutes: 42, currentMinutes: 27 });
    expect(g.schedulerTimeChangePct).toBe(-36);
    expect(g.schedulerTimePass).toBe(true);
    expect(g.pass).toBe(true);
  });

  it('fails when the reduction is short of 30%, passes at exactly 30%', () => {
    const short = evaluateGateA({ edits: 0, rejections: 0, agentActions: 10, baselineMinutes: 40, currentMinutes: 30 });
    expect(short.schedulerTimePass).toBe(false);
    expect(short.pass).toBe(false);
    expect(evaluateGateA({ edits: 0, rejections: 0, agentActions: 10, baselineMinutes: 40, currentMinutes: 28 }).schedulerTimePass).toBe(true);
    expect(evaluateGateA({ edits: 0, rejections: 0, agentActions: 10, baselineMinutes: 0, currentMinutes: 28 }).schedulerTimeChange).toBeNull();
  });
});

describe('weekly metrics', () => {
  const events: MetricAuditEvent[] = [
    { practiceId: P, kind: 'workspace_activity', occurredAt: WEEK, caseId: 'c1', minutes: 20 },
    { practiceId: P, kind: 'workspace_activity', occurredAt: WEEK, caseId: 'c1', minutes: 10 },
    { practiceId: P, kind: 'workspace_activity', occurredAt: WEEK, caseId: 'c2', minutes: 20 },
    { practiceId: P, kind: 'workspace_activity', occurredAt: WEEK },
    { practiceId: P, kind: 'patient_inbound_call', occurredAt: WEEK, caseId: 'c1' },
    { practiceId: P, kind: 'patient_inbound_call', occurredAt: WEEK, caseId: 'c3' },
    { practiceId: P, kind: 'patient_inbound_call', occurredAt: '2026-03-10T09:00:00Z', caseId: 'c3' },
  ];
  const cases: CaseHistoryRecord[] = [
    {
      practiceId: P, caseId: 'c1', orderedAt: '2026-02-28T12:00:00Z', authDecisionAt: '2026-03-04T12:00:00Z',
      authDecision: 'approved', authFirstPass: true,
      cancellation: { cancelledAt: '2026-03-03T08:00:00Z', scheduledFor: '2026-03-05T08:00:00Z', reason: 'illness' },
    },
    {
      practiceId: P, caseId: 'c2', orderedAt: '2026-03-01T12:00:00Z', authDecisionAt: '2026-03-05T12:00:00Z',
      authDecision: 'denied', authFirstPass: false,
      cancellation: { cancelledAt: '2026-03-03T08:00:00Z', scheduledFor: '2026-03-20T08:00:00Z', reason: 'illness' },
    },
    {
      practiceId: P, caseId: 'c3', orderedAt: '2026-03-01T12:00:00Z',
      cancellation: { cancelledAt: '2026-03-04T08:00:00Z', scheduledFor: '2026-03-06T08:00:00Z', reason: 'bogus' as never },
    },
    { practiceId: 'other', caseId: 'x', orderedAt: WEEK, authDecisionAt: WEEK, authDecision: 'denied' },
  ];
  const [w1, w2] = computeWeeklyMetrics(P, events, cases);

  it('computes scheduler minutes, calls per case', () => {
    expect(w1?.weekStart).toBe('2026-03-02');
    expect(w1?.schedulerMinutesPerCase).toBe(25);
    expect(w1?.activeCases).toBe(3);
    expect(w1?.patientInboundCalls).toBe(2);
    expect(w1?.patientCallsPerCase).toBeCloseTo(2 / 3);
    expect(w2?.weekStart).toBe('2026-03-09');
    expect(w2?.schedulerMinutesPerCase).toBeNull();
  });

  it('counts only late cancellations under 72 hours, by reason', () => {
    expect(w1?.lateCancellations).toBe(2);
    expect(w1?.lateCancellationsByReason.illness).toBe(1);
    expect(w1?.lateCancellationsByReason.other).toBe(1);
  });

  it('computes auth turnaround, first pass and denials', () => {
    expect(w1?.authDecisions).toBe(2);
    expect(w1?.daysOrderToAuthDecision).toBeCloseTo((4 + 4) / 2);
    expect(w1?.authFirstPassRate).toBe(0.5);
    expect(w1?.authDenials).toBe(1);
    expect(w2?.authFirstPassRate).toBeNull();
  });

  it('week starts on Monday UTC', () => {
    expect(weekStartOf('2026-03-08T23:59:00Z')).toBe('2026-03-02');
    expect(weekStartOf('2026-03-09T00:00:00Z')).toBe('2026-03-09');
  });

  it('exports aggregates only', () => {
    const csv = metricsToCsv([w1!, w2!]);
    const [header, row1] = csv.split('\n');
    expect(header).toContain('correction_rate');
    expect(row1).toContain('illness:1;other:1');
    expect(csv).not.toMatch(/c1|c2|c3/);
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('escapes csv cells and neutralizes formulas', () => {
    const csv = metricsToCsv([{ ...w1!, practiceId: '=SUM(A1),"x"' }]);
    expect(csv).toContain(`"'=SUM(A1),""x"""`);
  });
});

describe('in-memory source', () => {
  it('filters by practice and time range', async () => {
    const src = new InMemoryMetricsSource(
      [...actions(2, 'agent_action'), ...actions(1, 'agent_action', 'other')],
      [{ practiceId: P, caseId: 'c', orderedAt: WEEK }],
    );
    expect(await src.auditEvents(P, new Date('2026-03-01'), new Date('2026-03-09'))).toHaveLength(2);
    expect(await src.auditEvents(P, new Date('2026-03-09'), new Date('2026-03-16'))).toHaveLength(0);
    expect(await src.caseHistory(P)).toHaveLength(1);
    expect(await new InMemoryMetricsSource().caseHistory(P)).toHaveLength(0);
  });
});

describe('baseline import', () => {
  const fixture = readFileSync(fileURLToPath(new URL('../../../../tests/fixtures/metrics/baseline.csv', import.meta.url)), 'utf8');

  it('imports the fixture', () => {
    const r = importBaseline(fixture);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(6);
    expect(baselineFor(r.rows, P, 'scheduler_minutes_per_case')).toBe(42);
    expect(baselineFor(r.rows, 'nobody', 'scheduler_minutes_per_case')).toBeNull();
  });

  it('rejects bad files without echoing cell contents', () => {
    expect(importBaseline('').errors).toEqual(['file is empty']);
    expect(importBaseline('a,b\n1,2').errors[0]).toMatch(/header/);
    const bad = [
      'practice_id,metric,value,source',
      ',scheduler_minutes_per_case,5,s',
      'p,secret-name,5,s',
      'p,scheduler_minutes_per_case,-1,s',
      'p,auth_first_pass_rate,1.5,s',
      'p,patient_calls_per_case,2,',
      'p,patient_calls_per_case,2,s',
      'p,patient_calls_per_case,3,s',
      'p,too,many,cols,here',
      'p,"quoted ""x""",1,s',
    ].join('\n');
    const r = importBaseline(bad);
    expect(r.rows).toHaveLength(1);
    expect(r.errors.length).toBeGreaterThanOrEqual(8);
    expect(r.errors.join(' ')).not.toContain('secret-name');
  });
});
