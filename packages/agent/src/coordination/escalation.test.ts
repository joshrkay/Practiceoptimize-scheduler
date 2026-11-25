import { describe, expect, it } from 'vitest';
import { evaluateEscalation, loadCoordinationConfig, nextEscalationAt } from './escalation.js';
import type { CoordinationRequest } from './requests.js';

const sentAt = new Date('2027-01-04T15:00:00.000Z');
const config = { remind1Hours: 48, remind2Hours: 96 };
const hoursLater = (hours: number) => new Date(sentAt.getTime() + hours * 3_600_000);

function request(overrides: Partial<CoordinationRequest> = {}): CoordinationRequest {
  return {
    id: 'req-1',
    practiceId: 'practice-a',
    caseId: 'case-1',
    partyId: 'party-pcp',
    partyRole: 'primary_care',
    type: 'clearance',
    stepId: 'clearance-primary-care',
    stage: 'scheduled',
    channel: 'fax',
    status: 'open',
    approval: { status: 'not_required' },
    surgeryDate: '2027-02-10',
    dueAt: '2027-02-03T00:00:00.000Z',
    createdAt: sentAt.toISOString(),
    sentAt: sentAt.toISOString(),
    answeredAt: null,
    cancelledAt: null,
    cancelReason: null,
    remindersSent: 0,
    phoneTaskId: null,
    supersedesId: null,
    blocksReadiness: true,
    history: [],
    ...overrides,
  };
}

describe('loadCoordinationConfig', () => {
  it('defaults to 48 and 96 hours with the feature off', () => {
    expect(loadCoordinationConfig({})).toEqual({ enabled: false, remind1Hours: 48, remind2Hours: 96 });
  });

  it('reads the flag and reminder hours from the environment', () => {
    expect(
      loadCoordinationConfig({
        FEATURE_CARE_TEAM_COORDINATION: 'true',
        COORD_REMIND_1_HOURS: '24',
        COORD_REMIND_2_HOURS: ' ',
      }),
    ).toEqual({ enabled: true, remind1Hours: 24, remind2Hours: 96 });
    expect(loadCoordinationConfig({ FEATURE_CARE_TEAM_COORDINATION: 'yes' }).enabled).toBe(false);
  });

  it('rejects invalid hours', () => {
    expect(() => loadCoordinationConfig({ COORD_REMIND_1_HOURS: 'abc' })).toThrow(/COORD_REMIND_1_HOURS/);
    expect(() => loadCoordinationConfig({ COORD_REMIND_2_HOURS: '-1' })).toThrow(/positive/);
    expect(() => loadCoordinationConfig({ COORD_REMIND_1_HOURS: '96', COORD_REMIND_2_HOURS: '48' })).toThrow(
      /greater than/,
    );
  });
});

describe('evaluateEscalation', () => {
  it('does nothing before the first rung', () => {
    expect(evaluateEscalation(request(), config, hoursLater(47.9))).toEqual([]);
  });

  it('sends reminder 1 at 48 hours', () => {
    expect(evaluateEscalation(request(), config, hoursLater(48))).toEqual([{ kind: 'reminder', level: 1 }]);
    expect(evaluateEscalation(request({ remindersSent: 1 }), config, hoursLater(60))).toEqual([]);
  });

  it('sends reminder 2 and a phone task at 96 hours', () => {
    expect(evaluateEscalation(request({ remindersSent: 1 }), config, hoursLater(96))).toEqual([
      { kind: 'reminder', level: 2 },
      { kind: 'phone_task' },
    ]);
  });

  it('sends one reminder, not a burst, when a sweep runs late', () => {
    expect(evaluateEscalation(request(), config, hoursLater(120))).toEqual([
      { kind: 'reminder', level: 2 },
      { kind: 'phone_task' },
    ]);
  });

  it('creates a missing phone task without re-sending reminder 2', () => {
    expect(evaluateEscalation(request({ remindersSent: 2 }), config, hoursLater(100))).toEqual([{ kind: 'phone_task' }]);
  });

  it('marks an open request overdue at its due date', () => {
    const due = request({ dueAt: hoursLater(10).toISOString() });
    expect(evaluateEscalation(due, config, hoursLater(10))).toEqual([{ kind: 'mark_overdue' }]);
    expect(evaluateEscalation({ ...due, status: 'overdue' }, config, hoursLater(10))).toEqual([]);
  });

  it('ignores unsent, answered and cancelled requests', () => {
    expect(evaluateEscalation(request({ sentAt: null }), config, hoursLater(200))).toEqual([]);
    expect(evaluateEscalation(request({ status: 'answered' }), config, hoursLater(200))).toEqual([]);
    expect(evaluateEscalation(request({ status: 'cancelled' }), config, hoursLater(200))).toEqual([]);
  });
});

describe('nextEscalationAt', () => {
  it('returns the next rung or the due date, whichever is first', () => {
    expect(nextEscalationAt(request(), config)).toEqual(hoursLater(48));
    expect(nextEscalationAt(request({ remindersSent: 1 }), config)).toEqual(hoursLater(96));
    expect(nextEscalationAt(request({ dueAt: hoursLater(5).toISOString() }), config)).toEqual(hoursLater(5));
  });

  it('returns the due date once the ladder is done, and null when nothing is left', () => {
    const done = request({ remindersSent: 2, phoneTaskId: 'task-1' });
    expect(nextEscalationAt(done, config)).toEqual(new Date(done.dueAt));
    expect(nextEscalationAt({ ...done, status: 'overdue' }, config)).toBeNull();
    expect(nextEscalationAt(request({ sentAt: null }), config)).toBeNull();
  });
});
