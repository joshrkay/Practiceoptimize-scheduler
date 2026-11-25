/**
 * Readiness rule shape and matching.
 *
 * A readiness rule adds one readiness item to a case when all of its conditions match.
 * Conditions are AND across fields and OR within a field; an omitted field matches any case.
 * Rules encode what the practice and facility require; they never decide clinical necessity.
 */
import type { AnesthesiaType, CaseType, PracticeId, ReadinessCase, RiskFlag, SiteOfService } from './ports.js';

export const READINESS_ITEM_TYPES = [
  'history_and_physical',
  'anesthesia_packet',
  'lab',
  'imaging_study',
  'clearance',
  'surgical_consent',
  'patient_instructions',
  'authorization',
  'financial_quote',
  'financial_consent',
  'deposit',
  'dme_dispensing',
  'other',
] as const;
export type ReadinessItemType = (typeof READINESS_ITEM_TYPES)[number];

export const READINESS_ITEM_OWNERS = ['agent', 'patient', 'provider', 'scheduler', 'surgeon'] as const;
export type ReadinessItemOwner = (typeof READINESS_ITEM_OWNERS)[number];

export type RuleSource = 'practice' | 'facility';

export interface RuleConditions {
  procedureCodes?: readonly string[];
  procedureTags?: readonly string[];
  sitesOfService?: readonly SiteOfService[];
  anesthesia?: readonly AnesthesiaType[];
  /** Matches when the case carries any of these flags. */
  riskFlags?: readonly RiskFlag[];
  payerIds?: readonly string[];
  caseTypes?: readonly CaseType[];
  authorizationRequired?: boolean;
  inHouseDme?: boolean;
}

export interface ReadinessItemTemplate {
  /** Stable identity of the item across rules and regenerations, for example `lab.a1c`. */
  key: string;
  type: ReadinessItemType;
  label: string;
  owner: ReadinessItemOwner;
  /** Days before the surgery date the item is due; 0 means surgery day. */
  dueDaysBeforeSurgery: number;
  /** Expiry window: evidence must be dated within this many days before surgery. */
  validityDays?: number;
}

export interface ReadinessRule {
  id: string;
  practiceId: PracticeId;
  version: number;
  source: RuleSource;
  /** Required for facility rules: the facility the rule belongs to. */
  facilityId?: string;
  description: string;
  enabled: boolean;
  /** True when the item sends patient-facing content; edits then need clinician sign-off. */
  patientFacing: boolean;
  when: RuleConditions;
  item: ReadinessItemTemplate;
}

function anyOf<T>(allowed: readonly T[] | undefined, value: T | undefined): boolean {
  if (allowed === undefined) return true;
  return value !== undefined && allowed.includes(value);
}

function intersects<T>(allowed: readonly T[] | undefined, values: readonly T[]): boolean {
  if (allowed === undefined) return true;
  return values.some((v) => allowed.includes(v));
}

function flagMatches(expected: boolean | undefined, actual: boolean): boolean {
  return expected === undefined || expected === actual;
}

/** Whether the rule applies to the case. Disabled rules and other practices' rules never match. */
export function matchesRule(rule: ReadinessRule, c: ReadinessCase): boolean {
  if (!rule.enabled || rule.practiceId !== c.practiceId) return false;
  if (rule.source === 'facility' && rule.facilityId !== c.facilityId) return false;
  const w = rule.when;
  return (
    anyOf(w.procedureCodes, c.procedureCode) &&
    intersects(w.procedureTags, c.procedureTags) &&
    anyOf(w.sitesOfService, c.siteOfService) &&
    anyOf(w.anesthesia, c.anesthesia) &&
    intersects(w.riskFlags, c.riskFlags) &&
    anyOf(w.payerIds, c.payerId) &&
    anyOf(w.caseTypes, c.caseType) &&
    flagMatches(w.authorizationRequired, c.authorizationRequired) &&
    flagMatches(w.inHouseDme, c.inHouseDme)
  );
}

function isNonNegativeInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Returns the problems with a rule; an empty list means the rule is valid. */
export function validateRule(rule: ReadinessRule): string[] {
  const problems: string[] = [];
  if (!rule.id) problems.push('id is required');
  if (!rule.practiceId) problems.push('practiceId is required');
  if (!Number.isInteger(rule.version) || rule.version < 1) problems.push('version must be a positive integer');
  if (rule.source === 'facility' && !rule.facilityId) problems.push('facility rules need a facilityId');
  if (rule.source === 'practice' && rule.facilityId !== undefined) problems.push('practice rules take no facilityId');
  const item = rule.item;
  if (!item.key) problems.push('item.key is required');
  if (!item.label) problems.push('item.label is required');
  if (!READINESS_ITEM_TYPES.includes(item.type)) problems.push(`unknown item.type: ${String(item.type)}`);
  if (!READINESS_ITEM_OWNERS.includes(item.owner)) problems.push(`unknown item.owner: ${String(item.owner)}`);
  if (!isNonNegativeInt(item.dueDaysBeforeSurgery)) {
    problems.push('item.dueDaysBeforeSurgery must be a non-negative integer');
  }
  if (item.validityDays !== undefined && !(isNonNegativeInt(item.validityDays) && item.validityDays > 0)) {
    problems.push('item.validityDays must be a positive integer');
  }
  for (const [field, value] of Object.entries(rule.when)) {
    if (Array.isArray(value) && value.length === 0) problems.push(`when.${field} must not be empty`);
  }
  return problems;
}
