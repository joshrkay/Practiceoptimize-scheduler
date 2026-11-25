/**
 * Ports for everything site recommendation and slot finding read from outside.
 *
 * These are the minimal interfaces this module needs from work that is not built yet
 * (eligibility RAH-45, settings resolution RAH-13, policy RAH-17, readiness, calendars,
 * ASC integration RAH-77). They are wired to real adapters at integration; tests use the
 * in-memory fake in `fakes.ts`. Every call carries the practice ID, the isolation boundary.
 */
import type { BlockTimeSource } from './blocks.js';
import type { PracticeId, Site, SiteKind } from './types.js';

export type NetworkStatus = 'in_network' | 'out_of_network' | 'unknown';

/** Coverage from the latest eligibility check. */
export interface Coverage {
  payerId: string;
  planId: string;
  active: boolean;
  /** Network status per facility ID; a facility missing here is treated as `unknown`. */
  facilityNetwork: Record<string, NetworkStatus>;
}

export interface EligibilityPort {
  getCoverage(query: { practiceId: PracticeId; caseId: string; patientId: string }): Promise<Coverage | null>;
}

/** A payer's site-of-service rule for one procedure. */
export interface SiteOfServiceRule {
  /** Site kinds the payer covers for this procedure, or `any` when the payer has no rule. */
  allowedSiteKinds: SiteKind[] | 'any';
  /** Where the rule came from, shown in reasons (e.g. a payer policy name). */
  source: string;
}

export interface PayerRulesPort {
  getSiteOfServiceRule(query: {
    practiceId: PracticeId;
    payerId: string;
    planId: string;
    procedureCode: string;
  }): Promise<SiteOfServiceRule>;
}

export interface Privilege {
  granted: boolean;
  /** Last instant the privilege is valid; slots must end by then. Absent means no expiry on file. */
  validUntil?: string;
}

export interface PrivilegesPort {
  getPrivilege(query: {
    practiceId: PracticeId;
    surgeonId: string;
    facilityId: string;
    procedureCode: string;
  }): Promise<Privilege | null>;
}

export interface PatientRiskPort {
  /** Risk flags from the order (e.g. `asa_3`, `bmi_over_40`, `osa`). */
  getRiskFlags(query: { practiceId: PracticeId; caseId: string }): Promise<string[]>;
}

export type CaseOrderPreference = 'first_case' | 'last_case' | 'any';

/** Surgeon preferences after settings inheritance (practice, location, facility, surgeon). */
export interface ResolvedSurgeonPreferences {
  /** Site IDs in the surgeon's order of preference; unlisted sites rank after listed ones. */
  preferredSiteIds: string[];
  caseOrder: CaseOrderPreference;
  /** Planned spacing between cases in a case series, in days. */
  seriesSpacingDays?: { min: number; max?: number };
}

export interface SettingsPort {
  /** Risk flags the practice treats as high risk, which make site choice human-only. */
  getHighRiskFlags(query: { practiceId: PracticeId }): Promise<string[]>;
  resolveSurgeonPreferences(query: {
    practiceId: PracticeId;
    surgeonId: string;
    procedureCode: string;
  }): Promise<ResolvedSurgeonPreferences>;
}

export interface FacilitiesPort {
  listSites(query: { practiceId: PracticeId }): Promise<Site[]>;
}

export type AuthorizationStatus = 'approved' | 'not_required' | 'pending' | 'denied';

export interface AuthorizationWindow {
  status: AuthorizationStatus;
  /** Validity window for an approved authorization. */
  validFrom?: string;
  validTo?: string;
}

export interface AuthorizationPort {
  getAuthorization(query: { practiceId: PracticeId; caseId: string }): Promise<AuthorizationWindow>;
}

export interface ReadinessPort {
  /** Days needed from now before the case can be ready (pre-op clearance, labs, DME). */
  getLeadTimeDays(query: { practiceId: PracticeId; caseId: string }): Promise<number>;
}

export interface BusyInterval {
  memberId: string;
  start: string;
  end: string;
}

export interface TeamAvailabilityPort {
  getBusy(query: { practiceId: PracticeId; memberIds: string[]; from: string; to: string }): Promise<BusyInterval[]>;
}

export const SLOT_FINDING_FLAG = 'FEATURE_SLOT_FINDING';

export interface FeatureFlagsPort {
  isEnabled(flag: typeof SLOT_FINDING_FLAG): boolean;
}

/** Ports needed by site recommendation. */
export interface SiteRecommendationPorts {
  facilities: FacilitiesPort;
  eligibility: EligibilityPort;
  payerRules: PayerRulesPort;
  privileges: PrivilegesPort;
  patientRisk: PatientRiskPort;
  settings: SettingsPort;
}

/** Ports needed by slot finding (which runs site recommendation first). */
export interface SchedulingPorts extends SiteRecommendationPorts {
  blockTime: BlockTimeSource;
  authorizations: AuthorizationPort;
  readiness: ReadinessPort;
  teamAvailability: TeamAvailabilityPort;
  flags: FeatureFlagsPort;
}

/** Reads feature flags from the environment. Flags default to off. */
export function envFeatureFlags(env: Record<string, string | undefined>): FeatureFlagsPort {
  return { isEnabled: (flag) => env[flag] === 'true' };
}
