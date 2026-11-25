import { checkHardRules } from './hard-rules.js';
import type { AutonomyTier, Disposition, PolicyConfig, PolicyDecision, ProposedAction, TierDowngrade } from './ports.js';
import {
  confidenceThresholdFor,
  downgradeOneTier,
  hasSignedUrgentOrder,
  policyKeyFor,
  resolveTier,
  stricterTier,
} from './tiers.js';

const DISPOSITION_BY_TIER: Readonly<Record<AutonomyTier, Disposition>> = {
  autonomous: 'execute',
  approve_first: 'queue_for_approval',
  human_only: 'escalate_to_human',
};

/**
 * Decides what happens to one proposed action.
 *
 * Hard rules run first and cannot be disabled. Then the configured tier applies, dropping one tier when
 * confidence is below the practice's threshold or the data conflicts.
 */
export function evaluate(action: ProposedAction, config: PolicyConfig): PolicyDecision {
  if (action.practiceId !== config.practiceId) {
    throw new Error('Policy config belongs to a different practice than the action.');
  }
  const threshold = confidenceThresholdFor(config);
  const policyKey = policyKeyFor(action);
  const configuredTier = resolveTier(config, policyKey, action.siteOfService);
  const findings = checkHardRules(action);
  const base = {
    actionId: action.actionId,
    practiceId: action.practiceId,
    policyKey,
    configuredTier,
    hardRuleFindings: findings,
  };

  const immediate = findings.some((finding) => finding.effect === 'escalate_immediately');
  const blocking = findings.filter((finding) => finding.effect !== 'require_approval');
  if (blocking.length > 0) {
    return {
      ...base,
      disposition: 'escalate_to_human',
      tier: 'human_only',
      downgrade: null,
      blocked: true,
      escalation: immediate ? 'immediate' : 'standard',
      approvedBy: null,
      reasons: blocking.map((finding) => finding.message),
    };
  }

  const reasons: string[] = [];
  const downgradeReasons: string[] = [];
  // Written so a missing or NaN confidence counts as low.
  if (!(action.confidence >= threshold)) {
    downgradeReasons.push(`Confidence ${String(action.confidence)} is below the practice threshold ${threshold}.`);
  }
  if (action.dataConflicts.length > 0) {
    downgradeReasons.push(`Data conflicts: ${action.dataConflicts.join('; ')}.`);
  }

  let tier = configuredTier;
  let downgrade: TierDowngrade | null = null;
  if (downgradeReasons.length > 0) {
    tier = downgradeOneTier(configuredTier);
    downgrade = { from: configuredTier, to: tier, reasons: downgradeReasons };
    reasons.push(...downgradeReasons);
  }

  for (const finding of findings) {
    tier = stricterTier(tier, 'approve_first');
    reasons.push(finding.message);
  }

  const disposition = DISPOSITION_BY_TIER[tier];
  const approvedBy = disposition === 'execute' && policyKey === 'urgent_add_on_booking' && hasSignedUrgentOrder(action)
    ? 'signed_urgent_order'
    : null;
  if (approvedBy !== null) {
    reasons.push("The surgeon's signed urgent order is the approval (ADR-0007).");
  }

  return {
    ...base,
    disposition,
    tier,
    downgrade,
    blocked: false,
    escalation: tier === 'human_only' ? 'standard' : null,
    approvedBy,
    reasons,
  };
}
