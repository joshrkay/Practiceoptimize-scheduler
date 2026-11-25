import type { PolicyConfig, PracticeId, ProposedAction, SignedOrder } from './ports.js';

/** Synthetic data only. Builders for policy tests and evals. */
export const TEST_PRACTICE_ID = 'practice-podiatry-test-001' as PracticeId;

export function signedOrder(overrides: Partial<SignedOrder> = {}): SignedOrder {
  return {
    orderId: 'order-test-001',
    signedBySurgeonId: 'surgeon-test-001',
    signedAt: '2026-12-01T15:00:00Z',
    urgent: false,
    laterality: 'right',
    procedureCode: '28296',
    procedureDate: '2027-01-14',
    ...overrides,
  };
}

export function makeAction(overrides: Partial<ProposedAction> = {}): ProposedAction {
  return {
    actionId: 'action-test-001',
    practiceId: TEST_PRACTICE_ID,
    caseId: 'case-test-001',
    kind: 'eligibility_check',
    siteOfService: 'office_procedure_room',
    confidence: 0.95,
    dataConflicts: [],
    failedAttempts: 0,
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return { practiceId: TEST_PRACTICE_ID, ...overrides };
}
