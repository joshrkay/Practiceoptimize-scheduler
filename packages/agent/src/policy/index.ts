/** Policy engine: autonomy tiers and hard rules (RAH-17). */
export { evaluate } from './evaluate.js';
export { HARD_RULES, MAX_FAILED_ATTEMPTS, checkHardRules } from './hard-rules.js';
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_TIERS,
  confidenceThresholdFor,
  downgradeOneTier,
  hasSignedUrgentOrder,
  policyKeyFor,
  resolveTier,
  stricterTier,
} from './tiers.js';
export type * from './ports.js';
