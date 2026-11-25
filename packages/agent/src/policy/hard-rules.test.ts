import { describe, expect, it } from 'vitest';
import { HARD_RULES, checkHardRules } from './hard-rules.js';
import type { HardRuleId } from './ports.js';
import { makeAction, signedOrder } from './testing.js';

const rules = (action: Parameters<typeof checkHardRules>[0]) => checkHardRules(action).map((finding) => finding.rule);

describe('hard rules', () => {
  it('has all six rules', () => {
    const ids: HardRuleId[] = [
      'clinical_prep_within_approved_template',
      'cancel_requires_human_approval',
      'cross_check_signed_order',
      'escalate_patient_emergency',
      'identify_as_automated',
      'escalate_after_two_failed_attempts',
    ];
    expect(HARD_RULES.map((rule) => rule.id).sort()).toEqual(ids.sort());
    expect(Object.isFrozen(HARD_RULES)).toBe(true);
  });

  it('finds nothing for a clean routine action', () => {
    expect(checkHardRules(makeAction())).toEqual([]);
  });

  describe('never change clinical prep beyond the surgeon-approved template', () => {
    it('blocks a deviation from the template', () => {
      const [finding] = checkHardRules(
        makeAction({
          kind: 'patient_instructions',
          instructionsTemplate: { templateId: 'prep-1', status: 'clinician_signed' },
          facts: {},
          signedOrder: signedOrder(),
          clinicalPrep: { surgeonApprovedTemplateId: 'prep-1', deviations: ['stop anticoagulant 7 days early'] },
        }),
      );
      expect(finding).toMatchObject({ rule: 'clinical_prep_within_approved_template', effect: 'block' });
      expect(finding?.message).toContain('stop anticoagulant 7 days early');
    });

    it('blocks prep with no approved template', () => {
      const action = makeAction({ clinicalPrep: { surgeonApprovedTemplateId: null, deviations: [] } });
      expect(checkHardRules(action)).toEqual([
        expect.objectContaining({ rule: 'clinical_prep_within_approved_template', effect: 'block' }),
      ]);
    });

    it('allows prep that matches the template', () => {
      const action = makeAction({ clinicalPrep: { surgeonApprovedTemplateId: 'prep-1', deviations: [] } });
      expect(checkHardRules(action)).toEqual([]);
    });
  });

  describe('never cancel without human approval', () => {
    it('requires approval for every cancellation', () => {
      expect(checkHardRules(makeAction({ kind: 'cancellation' }))).toEqual([
        expect.objectContaining({ rule: 'cancel_requires_human_approval', effect: 'require_approval' }),
      ]);
    });

    it('leaves a reschedule plan alone', () => {
      expect(rules(makeAction({ kind: 'reschedule_plan' }))).toEqual([]);
    });
  });

  describe('cross-check laterality, procedure and date against the signed order', () => {
    const posting = (facts: Parameters<typeof makeAction>[0]) =>
      makeAction({ kind: 'facility_posting', signedOrder: signedOrder(), ...facts });

    it('passes a posting that matches the order, ignoring code case and spacing', () => {
      const action = posting({ facts: { laterality: 'right', procedureCode: ' 28296 ', procedureDate: '2027-01-14' } });
      expect(checkHardRules(action)).toEqual([]);
    });

    it('blocks a laterality mismatch and shows it', () => {
      const [finding] = checkHardRules(posting({ facts: { laterality: 'left' } }));
      expect(finding).toMatchObject({
        rule: 'cross_check_signed_order',
        effect: 'block',
        mismatches: [{ field: 'laterality', action: 'left', signedOrder: 'right' }],
      });
      expect(finding?.message).toContain('laterality: action says left, signed order says right');
    });

    it('blocks a procedure mismatch', () => {
      const [finding] = checkHardRules(posting({ facts: { procedureCode: '28285' } }));
      expect(finding?.mismatches).toEqual([{ field: 'procedure', action: '28285', signedOrder: '28296' }]);
    });

    it('blocks a date mismatch', () => {
      const [finding] = checkHardRules(posting({ facts: { procedureDate: '2027-01-15' } }));
      expect(finding?.mismatches).toEqual([{ field: 'date', action: '2027-01-15', signedOrder: '2027-01-14' }]);
    });

    it('treats a fact the order does not state as a mismatch', () => {
      const { laterality: _l, procedureCode: _p, procedureDate: _d, ...bareOrder } = signedOrder();
      const action = makeAction({
        kind: 'facility_posting',
        signedOrder: bareOrder,
        facts: { laterality: 'left', procedureCode: '28296', procedureDate: '2027-01-14' },
      });
      const [finding] = checkHardRules(action);
      expect(finding?.mismatches).toEqual([
        { field: 'laterality', action: 'left', signedOrder: null },
        { field: 'procedure', action: '28296', signedOrder: null },
        { field: 'date', action: '2027-01-14', signedOrder: null },
      ]);
      expect(finding?.message).toContain('signed order says nothing');
    });

    it('blocks a posting with no signed order', () => {
      const [finding] = checkHardRules(makeAction({ kind: 'facility_posting', facts: { laterality: 'right' } }));
      expect(finding?.mismatches).toEqual([{ field: 'signed_order', action: null, signedOrder: null }]);
      expect(finding?.message).toContain('no signed order to check against');
    });

    it('checks every patient message', () => {
      const action = makeAction({
        kind: 'reminder',
        communication: { channel: 'sms', recipient: 'patient', identifiesAsAutomated: true },
        signedOrder: signedOrder(),
        facts: { procedureDate: '2027-02-01' },
      });
      expect(rules(action)).toEqual(['cross_check_signed_order']);
    });

    it('checks patient instructions and urgent add-on bookings', () => {
      expect(rules(makeAction({ kind: 'patient_instructions', facts: {} }))).toEqual(['cross_check_signed_order']);
      const urgent = makeAction({
        kind: 'slot_booking',
        urgentAddOn: true,
        signedOrder: signedOrder({ urgent: true }),
        facts: { laterality: 'left' },
      });
      expect(rules(urgent)).toEqual(['cross_check_signed_order']);
    });

    it('does not check actions that neither post nor message the patient', () => {
      const action = makeAction({
        kind: 'auth_submission',
        communication: { channel: 'portal', recipient: 'payer', identifiesAsAutomated: true },
        facts: { laterality: 'left' },
      });
      expect(rules(action)).toEqual([]);
    });
  });

  describe('escalate patient-reported emergencies or self-harm immediately', () => {
    it.each([['emergency'], ['self_harm']] as const)('escalates %s', (concern) => {
      const [finding] = checkHardRules(makeAction({ kind: 'confirmation', patientReportedConcerns: [concern] }));
      expect(finding).toMatchObject({ rule: 'escalate_patient_emergency', effect: 'escalate_immediately' });
    });

    it('names every concern', () => {
      const [finding] = checkHardRules(makeAction({ patientReportedConcerns: ['emergency', 'self_harm'] }));
      expect(finding?.message).toContain('emergency and self-harm');
    });
  });

  describe('identify as automated on every call and message', () => {
    it.each(['call', 'sms', 'email', 'portal', 'fax'] as const)('blocks an unidentified %s', (channel) => {
      const action = makeAction({ kind: 'auth_status_check', communication: { channel, recipient: 'payer', identifiesAsAutomated: false } });
      expect(checkHardRules(action)).toEqual([expect.objectContaining({ rule: 'identify_as_automated', effect: 'block' })]);
    });

    it('allows an identified call', () => {
      const action = makeAction({
        kind: 'auth_status_check',
        communication: { channel: 'call', recipient: 'care_team', identifiesAsAutomated: true },
      });
      expect(checkHardRules(action)).toEqual([]);
    });

    it('describes the recipient in words', () => {
      const action = makeAction({ communication: { channel: 'call', recipient: 'care_team', identifiesAsAutomated: false } });
      expect(checkHardRules(action)[0]?.message).toBe('The call to the care team does not say it is automated.');
    });
  });

  describe('escalate after two failed attempts at any external step', () => {
    it('allows a first retry', () => {
      expect(rules(makeAction({ failedAttempts: 1 }))).toEqual([]);
    });

    it.each([2, 3])('blocks after %i failures', (failedAttempts) => {
      expect(checkHardRules(makeAction({ failedAttempts }))).toEqual([
        expect.objectContaining({ rule: 'escalate_after_two_failed_attempts', effect: 'block' }),
      ]);
    });
  });

  it('reports every rule that fires', () => {
    const action = makeAction({
      kind: 'cancellation',
      failedAttempts: 2,
      patientReportedConcerns: ['emergency'],
      communication: { channel: 'call', recipient: 'patient', identifiesAsAutomated: false },
    });
    expect(rules(action)).toEqual([
      'escalate_patient_emergency',
      'cross_check_signed_order',
      'identify_as_automated',
      'escalate_after_two_failed_attempts',
      'cancel_requires_human_approval',
    ]);
  });
});
