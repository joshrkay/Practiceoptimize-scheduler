import type { AutonomyTier, PolicyConfig, PolicyKey, ProposedAction, SiteOfService } from './ports.js';

/**
 * Default confidence threshold. Below it an action drops one tier.
 * The issue does not set a number; 0.8 is a conservative starting point that each practice can change.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

/** Default tiers from the PRD. */
export const DEFAULT_TIERS: Readonly<Record<PolicyKey, AutonomyTier>> = Object.freeze({
  eligibility_check: 'autonomous',
  auth_status_check: 'autonomous',
  reminder: 'autonomous',
  confirmation: 'autonomous',
  attach_received_document: 'autonomous',
  data_sync: 'autonomous',
  patient_instructions_signed_template: 'autonomous',
  // ADR-0007: the surgeon's signed urgent order is the approval.
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
});

const TIER_ORDER: readonly AutonomyTier[] = ['autonomous', 'approve_first', 'human_only'];

function rank(tier: AutonomyTier): number {
  return TIER_ORDER.indexOf(tier);
}

/** True when the action is an urgent add-on carrying a surgeon's signed urgent order. */
export function hasSignedUrgentOrder(action: ProposedAction): boolean {
  const order = action.signedOrder;
  return (
    action.urgentAddOn === true &&
    order !== undefined &&
    order.urgent &&
    order.signedBySurgeonId.trim() !== '' &&
    order.signedAt.trim() !== ''
  );
}

/** The key the action's tier is configured under. */
export function policyKeyFor(action: ProposedAction): PolicyKey {
  if (action.kind === 'patient_instructions') {
    return action.instructionsTemplate?.status === 'clinician_signed'
      ? 'patient_instructions_signed_template'
      : 'patient_instructions_unsigned_template';
  }
  if (action.kind === 'slot_booking' && hasSignedUrgentOrder(action)) {
    return 'urgent_add_on_booking';
  }
  return action.kind;
}

/** Site override, then practice override, then the default. Unknown keys fail safe to human-only. */
export function resolveTier(config: PolicyConfig, key: PolicyKey, site: SiteOfService): AutonomyTier {
  const tier = config.siteTierOverrides?.[site]?.[key] ?? config.tierOverrides?.[key] ?? DEFAULT_TIERS[key];
  return tier !== undefined && TIER_ORDER.includes(tier) ? tier : 'human_only';
}

/** One step toward human-only. Human-only stays human-only. */
export function downgradeOneTier(tier: AutonomyTier): AutonomyTier {
  return TIER_ORDER[Math.min(rank(tier) + 1, TIER_ORDER.length - 1)] as AutonomyTier;
}

/** The less autonomous of two tiers. */
export function stricterTier(a: AutonomyTier, b: AutonomyTier): AutonomyTier {
  return rank(a) >= rank(b) ? a : b;
}

/** The practice's threshold, or the default. Rejects values outside 0 to 1. */
export function confidenceThresholdFor(config: PolicyConfig): number {
  const threshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new RangeError(`confidenceThreshold must be between 0 and 1, got ${String(threshold)}`);
  }
  return threshold;
}
