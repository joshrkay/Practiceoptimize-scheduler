import { describe, expect, it } from 'vitest';
import { evaluate } from './evaluate.js';
import type { ActionKind, PolicyConfig, PracticeId } from './ports.js';
import { makeAction, makeConfig, signedOrder } from './testing.js';

describe('evaluate', () => {
  describe('Scenario 1: approve-first action is held', () => {
    it('queues an auth submission for approval with default tiers', () => {
      const decision = evaluate(makeAction({ kind: 'auth_submission' }), makeConfig());
      expect(decision).toMatchObject({
        disposition: 'queue_for_approval',
        tier: 'approve_first',
        configuredTier: 'approve_first',
        blocked: false,
        escalation: null,
        downgrade: null,
        approvedBy: null,
        hardRuleFindings: [],
      });
    });
  });

  describe('Scenario 2: laterality mismatch is blocked', () => {
    it('blocks a left-foot posting against a right-foot order and escalates as human-only', () => {
      const action = makeAction({
        kind: 'facility_posting',
        siteOfService: 'asc',
        signedOrder: signedOrder({ laterality: 'right' }),
        facts: { laterality: 'left', procedureCode: '28296', procedureDate: '2027-01-14' },
      });
      const decision = evaluate(action, makeConfig());
      expect(decision).toMatchObject({
        disposition: 'escalate_to_human',
        tier: 'human_only',
        blocked: true,
        escalation: 'standard',
      });
      expect(decision.hardRuleFindings).toEqual([
        expect.objectContaining({
          rule: 'cross_check_signed_order',
          mismatches: [{ field: 'laterality', action: 'left', signedOrder: 'right' }],
        }),
      ]);
      expect(decision.reasons[0]).toContain('action says left, signed order says right');
    });

    it('still blocks when the practice made postings autonomous', () => {
      const action = makeAction({ kind: 'facility_posting', signedOrder: signedOrder(), facts: { laterality: 'left' } });
      const config = makeConfig({ tierOverrides: { facility_posting: 'autonomous' } });
      expect(evaluate(action, config).disposition).toBe('escalate_to_human');
    });
  });

  describe('default tiers drive the disposition', () => {
    it.each<[ActionKind, string]>([
      ['eligibility_check', 'execute'],
      ['auth_status_check', 'execute'],
      ['reminder', 'execute'],
      ['confirmation', 'execute'],
      ['attach_received_document', 'execute'],
      ['data_sync', 'execute'],
      ['auth_submission', 'queue_for_approval'],
      ['retro_auth_submission', 'queue_for_approval'],
      ['slot_booking', 'queue_for_approval'],
      ['vendor_booking', 'queue_for_approval'],
      ['reschedule_plan', 'queue_for_approval'],
      ['denial_appeal', 'escalate_to_human'],
      ['peer_to_peer', 'escalate_to_human'],
      ['financial_conversation', 'escalate_to_human'],
      ['clinical_question', 'escalate_to_human'],
      ['upset_patient_response', 'escalate_to_human'],
    ])('%s -> %s', (kind, disposition) => {
      expect(evaluate(makeAction({ kind }), makeConfig()).disposition).toBe(disposition);
    });

    it('human-only by tier is escalated but not marked blocked', () => {
      const decision = evaluate(makeAction({ kind: 'denial_appeal' }), makeConfig());
      expect(decision).toMatchObject({ blocked: false, escalation: 'standard', tier: 'human_only' });
    });

    it('queues a matching facility posting', () => {
      const action = makeAction({
        kind: 'facility_posting',
        signedOrder: signedOrder(),
        facts: { laterality: 'right', procedureCode: '28296', procedureDate: '2027-01-14' },
      });
      expect(evaluate(action, makeConfig()).disposition).toBe('queue_for_approval');
    });

    it('runs patient instructions from a clinician-signed template', () => {
      const action = makeAction({
        kind: 'patient_instructions',
        instructionsTemplate: { templateId: 'post-op-foot', status: 'clinician_signed' },
        signedOrder: signedOrder(),
        facts: { laterality: 'right' },
      });
      expect(evaluate(action, makeConfig())).toMatchObject({
        disposition: 'execute',
        policyKey: 'patient_instructions_signed_template',
      });
    });

    it.each(['edited', 'unsigned'] as const)('holds patient instructions from an %s template', (status) => {
      const action = makeAction({
        kind: 'patient_instructions',
        instructionsTemplate: { templateId: 'post-op-foot', status },
        signedOrder: signedOrder(),
      });
      expect(evaluate(action, makeConfig()).disposition).toBe('queue_for_approval');
    });
  });

  describe('one-tier downgrade', () => {
    it('drops autonomous to approve-first below the default threshold', () => {
      const decision = evaluate(makeAction({ kind: 'reminder', confidence: 0.79 }), makeConfig());
      expect(decision.disposition).toBe('queue_for_approval');
      expect(decision.downgrade).toEqual({
        from: 'autonomous',
        to: 'approve_first',
        reasons: ['Confidence 0.79 is below the practice threshold 0.8.'],
      });
    });

    it('does not drop at exactly the threshold', () => {
      expect(evaluate(makeAction({ confidence: 0.8 }), makeConfig()).downgrade).toBeNull();
    });

    it('drops approve-first to human-only on a data conflict', () => {
      const decision = evaluate(
        makeAction({ kind: 'slot_booking', dataConflicts: ['EHR says ASC, facility calendar says office'] }),
        makeConfig(),
      );
      expect(decision).toMatchObject({ disposition: 'escalate_to_human', tier: 'human_only', escalation: 'standard' });
      expect(decision.downgrade?.reasons).toEqual(['Data conflicts: EHR says ASC, facility calendar says office.']);
    });

    it('drops only one tier when confidence is low and data conflicts', () => {
      const decision = evaluate(makeAction({ kind: 'data_sync', confidence: 0.2, dataConflicts: ['DOB differs'] }), makeConfig());
      expect(decision.tier).toBe('approve_first');
      expect(decision.downgrade?.reasons).toHaveLength(2);
    });

    it('treats a missing confidence as low', () => {
      expect(evaluate(makeAction({ confidence: Number.NaN }), makeConfig()).tier).toBe('approve_first');
    });

    it('uses the practice threshold', () => {
      const action = makeAction({ kind: 'reminder', confidence: 0.85 });
      expect(evaluate(action, makeConfig({ confidenceThreshold: 0.9 })).disposition).toBe('queue_for_approval');
      expect(evaluate(action, makeConfig({ confidenceThreshold: 0.6 })).disposition).toBe('execute');
    });

    it('rejects an invalid threshold', () => {
      expect(() => evaluate(makeAction(), makeConfig({ confidenceThreshold: 2 }))).toThrow(RangeError);
    });
  });

  describe('urgent add-on exception (ADR-0007)', () => {
    const urgentBooking = (overrides: Parameters<typeof makeAction>[0] = {}) =>
      makeAction({
        kind: 'slot_booking',
        urgentAddOn: true,
        signedOrder: signedOrder({ urgent: true }),
        facts: { laterality: 'right', procedureCode: '28296', procedureDate: '2027-01-14' },
        ...overrides,
      });

    it("books on the surgeon's signed urgent order without a scheduler approval", () => {
      const decision = evaluate(urgentBooking(), makeConfig());
      expect(decision).toMatchObject({
        disposition: 'execute',
        policyKey: 'urgent_add_on_booking',
        approvedBy: 'signed_urgent_order',
      });
      expect(decision.reasons).toContain("The surgeon's signed urgent order is the approval (ADR-0007).");
    });

    it('holds an urgent add-on whose order is not signed as urgent', () => {
      const decision = evaluate(urgentBooking({ signedOrder: signedOrder({ urgent: false }) }), makeConfig());
      expect(decision).toMatchObject({ disposition: 'queue_for_approval', approvedBy: null, policyKey: 'slot_booking' });
    });

    it('blocks an urgent add-on that does not match the order', () => {
      const decision = evaluate(urgentBooking({ facts: { laterality: 'left' } }), makeConfig());
      expect(decision).toMatchObject({ disposition: 'escalate_to_human', blocked: true, approvedBy: null });
    });

    it('still drops a tier on low confidence', () => {
      const decision = evaluate(urgentBooking({ confidence: 0.5 }), makeConfig());
      expect(decision).toMatchObject({ disposition: 'queue_for_approval', approvedBy: null });
    });

    it('respects a practice that wants approval anyway', () => {
      const config = makeConfig({ siteTierOverrides: { asc: { urgent_add_on_booking: 'approve_first' } } });
      const decision = evaluate(urgentBooking({ siteOfService: 'asc' }), config);
      expect(decision).toMatchObject({ disposition: 'queue_for_approval', approvedBy: null });
    });
  });

  describe('hard rules run first and cannot be disabled', () => {
    it('escalates a patient emergency immediately, even on an autonomous action', () => {
      const decision = evaluate(makeAction({ kind: 'confirmation', patientReportedConcerns: ['self_harm'] }), makeConfig());
      expect(decision).toMatchObject({ disposition: 'escalate_to_human', blocked: true, escalation: 'immediate' });
    });

    it('holds a cancellation even when configured autonomous', () => {
      const config = makeConfig({
        tierOverrides: { cancellation: 'autonomous' },
        siteTierOverrides: { office_procedure_room: { cancellation: 'autonomous' } },
      });
      const decision = evaluate(makeAction({ kind: 'cancellation' }), config);
      expect(decision).toMatchObject({
        configuredTier: 'autonomous',
        tier: 'approve_first',
        disposition: 'queue_for_approval',
        blocked: false,
      });
      expect(decision.reasons).toEqual(['A cancellation always needs human approval.']);
    });

    it('lets a low-confidence cancellation drop to human-only', () => {
      const decision = evaluate(makeAction({ kind: 'cancellation', confidence: 0.1 }), makeConfig());
      expect(decision.disposition).toBe('escalate_to_human');
    });

    it('ignores any attempt to switch hard rules off through configuration', () => {
      const config = {
        ...makeConfig({ tierOverrides: { auth_status_check: 'autonomous' } }),
        hardRules: { identify_as_automated: false, escalate_after_two_failed_attempts: false },
        disableHardRules: true,
      } as unknown as PolicyConfig;
      const action = makeAction({
        kind: 'auth_status_check',
        failedAttempts: 2,
        communication: { channel: 'call', recipient: 'payer', identifiesAsAutomated: false },
      });
      const decision = evaluate(action, config);
      expect(decision.blocked).toBe(true);
      expect(decision.hardRuleFindings.map((finding) => finding.rule)).toEqual([
        'identify_as_automated',
        'escalate_after_two_failed_attempts',
      ]);
    });

    it('blocks clinical prep beyond the template', () => {
      const action = makeAction({ clinicalPrep: { surgeonApprovedTemplateId: 'prep-1', deviations: ['NPO from 6 pm'] } });
      expect(evaluate(action, makeConfig()).disposition).toBe('escalate_to_human');
    });
  });

  it('refuses a config from another practice', () => {
    const config = makeConfig({ practiceId: 'practice-other' as PracticeId });
    expect(() => evaluate(makeAction(), config)).toThrow('different practice');
  });

  it('fails safe to human-only for an unknown action kind', () => {
    const decision = evaluate(makeAction({ kind: 'wire_money' as ActionKind }), makeConfig());
    expect(decision.disposition).toBe('escalate_to_human');
  });
});
