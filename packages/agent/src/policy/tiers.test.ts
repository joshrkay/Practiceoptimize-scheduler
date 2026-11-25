import { describe, expect, it } from 'vitest';
import type { AutonomyTier, PolicyKey } from './ports.js';
import { makeAction, makeConfig, signedOrder } from './testing.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_TIERS,
  confidenceThresholdFor,
  downgradeOneTier,
  hasSignedUrgentOrder,
  policyKeyFor,
  resolveTier,
  stricterTier,
} from './tiers.js';

describe('default tiers', () => {
  const expected: Record<PolicyKey, AutonomyTier> = {
    eligibility_check: 'autonomous',
    auth_status_check: 'autonomous',
    reminder: 'autonomous',
    confirmation: 'autonomous',
    attach_received_document: 'autonomous',
    data_sync: 'autonomous',
    patient_instructions_signed_template: 'autonomous',
    urgent_add_on_booking: 'autonomous',
    auth_submission: 'approve_first',
    retro_auth_submission: 'approve_first',
    facility_posting: 'approve_first',
    slot_booking: 'approve_first',
    vendor_booking: 'approve_first',
    reschedule_plan: 'approve_first',
    cancellation: 'approve_first',
    patient_instructions_unsigned_template: 'approve_first',
    denial_appeal: 'human_only',
    peer_to_peer: 'human_only',
    financial_conversation: 'human_only',
    clinical_question: 'human_only',
    upset_patient_response: 'human_only',
  };

  it.each(Object.entries(expected))('%s defaults to %s', (key, tier) => {
    expect(DEFAULT_TIERS[key as PolicyKey]).toBe(tier);
    expect(resolveTier(makeConfig(), key as PolicyKey, 'asc')).toBe(tier);
  });

  it('covers exactly the expected keys', () => {
    expect(Object.keys(DEFAULT_TIERS).sort()).toEqual(Object.keys(expected).sort());
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_TIERS)).toBe(true);
  });
});

describe('policyKeyFor', () => {
  it('uses the action kind for ordinary actions', () => {
    expect(policyKeyFor(makeAction({ kind: 'auth_submission' }))).toBe('auth_submission');
  });

  it('splits patient instructions by template status', () => {
    const instructions = (status: 'clinician_signed' | 'edited' | 'unsigned') =>
      policyKeyFor(makeAction({ kind: 'patient_instructions', instructionsTemplate: { templateId: 't-1', status } }));
    expect(instructions('clinician_signed')).toBe('patient_instructions_signed_template');
    expect(instructions('edited')).toBe('patient_instructions_unsigned_template');
    expect(instructions('unsigned')).toBe('patient_instructions_unsigned_template');
    expect(policyKeyFor(makeAction({ kind: 'patient_instructions' }))).toBe('patient_instructions_unsigned_template');
  });

  it('gives an urgent add-on with a signed urgent order its own key', () => {
    const action = makeAction({ kind: 'slot_booking', urgentAddOn: true, signedOrder: signedOrder({ urgent: true }) });
    expect(policyKeyFor(action)).toBe('urgent_add_on_booking');
  });

  it('keeps an urgent add-on without a signed urgent order as a slot booking', () => {
    const cases = [
      makeAction({ kind: 'slot_booking', urgentAddOn: true }),
      makeAction({ kind: 'slot_booking', urgentAddOn: true, signedOrder: signedOrder({ urgent: false }) }),
      makeAction({ kind: 'slot_booking', urgentAddOn: true, signedOrder: signedOrder({ urgent: true, signedBySurgeonId: ' ' }) }),
      makeAction({ kind: 'slot_booking', urgentAddOn: true, signedOrder: signedOrder({ urgent: true, signedAt: '' }) }),
      makeAction({ kind: 'slot_booking', urgentAddOn: false, signedOrder: signedOrder({ urgent: true }) }),
    ];
    for (const action of cases) {
      expect(hasSignedUrgentOrder(action)).toBe(false);
      expect(policyKeyFor(action)).toBe('slot_booking');
    }
  });
});

describe('resolveTier', () => {
  it('lets a practice override a default', () => {
    const config = makeConfig({ tierOverrides: { auth_submission: 'autonomous' } });
    expect(resolveTier(config, 'auth_submission', 'asc')).toBe('autonomous');
  });

  it('lets a site override win over the practice override', () => {
    const config = makeConfig({
      tierOverrides: { slot_booking: 'autonomous' },
      siteTierOverrides: { asc: { slot_booking: 'human_only' } },
    });
    expect(resolveTier(config, 'slot_booking', 'asc')).toBe('human_only');
    expect(resolveTier(config, 'slot_booking', 'office_procedure_room')).toBe('autonomous');
  });

  it('fails safe to human-only for an unknown key or tier', () => {
    expect(resolveTier(makeConfig(), 'not_a_key' as PolicyKey, 'asc')).toBe('human_only');
    const config = makeConfig({ tierOverrides: { reminder: 'yolo' as AutonomyTier } });
    expect(resolveTier(config, 'reminder', 'asc')).toBe('human_only');
  });
});

describe('tier arithmetic', () => {
  it('downgrades one tier at a time and stops at human-only', () => {
    expect(downgradeOneTier('autonomous')).toBe('approve_first');
    expect(downgradeOneTier('approve_first')).toBe('human_only');
    expect(downgradeOneTier('human_only')).toBe('human_only');
  });

  it('picks the stricter tier', () => {
    expect(stricterTier('autonomous', 'approve_first')).toBe('approve_first');
    expect(stricterTier('human_only', 'approve_first')).toBe('human_only');
  });
});

describe('confidenceThresholdFor', () => {
  it('defaults to 0.8', () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(confidenceThresholdFor(makeConfig())).toBe(0.8);
  });

  it('uses the practice value', () => {
    expect(confidenceThresholdFor(makeConfig({ confidenceThreshold: 0.9 }))).toBe(0.9);
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(() => confidenceThresholdFor(makeConfig({ confidenceThreshold: value }))).toThrow(RangeError);
  });
});
