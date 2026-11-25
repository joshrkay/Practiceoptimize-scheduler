import { describe, expect, it } from 'vitest';
import fixture from '../../../../tests/fixtures/policy/actions.json' with { type: 'json' };
import { evaluate } from './evaluate.js';
import type { ProposedAction, PracticeId, SignedOrder } from './ports.js';

interface FixtureAction extends Omit<ProposedAction, 'actionId' | 'practiceId' | 'caseId' | 'dataConflicts' | 'failedAttempts'> {
  withSignedOrder?: boolean;
  urgentOrder?: boolean;
  failedAttempts?: number;
}

const practiceId = fixture.practiceId as PracticeId;

function toAction(index: number, raw: FixtureAction): ProposedAction {
  const { withSignedOrder, urgentOrder, failedAttempts, ...rest } = raw;
  const action: ProposedAction = {
    actionId: `action-fixture-${index}`,
    practiceId,
    caseId: `case-fixture-${index}`,
    dataConflicts: [],
    failedAttempts: failedAttempts ?? 0,
    ...rest,
  };
  if (withSignedOrder === true) {
    action.signedOrder = { ...(fixture.signedOrder as SignedOrder), urgent: urgentOrder === true };
  }
  return action;
}

describe('policy fixtures (tests/fixtures/policy/actions.json)', () => {
  it.each(fixture.cases.map((entry, index) => [entry.name, index, entry] as const))('%s', (_name, index, entry) => {
    const decision = evaluate(toAction(index, entry.action as FixtureAction), { practiceId });
    expect(decision.disposition).toBe(entry.expected.disposition);
    expect(decision.blocked).toBe(entry.expected.blocked);
    expect(decision.hardRuleFindings.map((finding) => finding.rule)).toEqual(entry.expected.rules);
  });
});
