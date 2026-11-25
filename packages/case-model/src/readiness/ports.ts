/**
 * Inputs the readiness engine needs from modules that are built elsewhere.
 *
 * `ReadinessCase` is the slice of the case record (RAH-15) the rules match on, and
 * `ResolvedReadinessSettings` is the practice and facility rule sets after settings
 * resolution (RAH-13). Both are wired to the real modules at integration.
 */
import type { ReadinessRule } from './rules.js';

export type PracticeId = string;

/** Where the procedure is performed. Hospitals are out of scope for the pilot. */
export type SiteOfService = 'office_procedure_room' | 'asc';

export type AnesthesiaType = 'local' | 'mac' | 'regional' | 'general';

/** How the case is paid for. Mixed means an insured procedure with a self-pay portion. */
export type CaseType = 'insured' | 'self_pay' | 'mixed';

export type CaseUrgency = 'elective' | 'urgent_add_on';

/** Patient risk flags carried on the order. Open-ended so a specialty pack can add more. */
export type RiskFlag = 'diabetes' | 'vascular_disease' | 'smoker' | 'anticoagulated' | (string & {});

/** ISO calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

export interface ReadinessCase {
  caseId: string;
  practiceId: PracticeId;
  /** Procedure code from the order, for example a CPT code. */
  procedureCode: string;
  /** Procedure families the practice tags its procedures with, for example `fusion` or `cosmetic`. */
  procedureTags: readonly string[];
  siteOfService: SiteOfService;
  anesthesia: AnesthesiaType;
  /** The facility (ASC or office location) where the case is booked. */
  facilityId: string;
  payerId?: string;
  caseType: CaseType;
  /** Whether the payer requires prior authorization for this procedure. */
  authorizationRequired: boolean;
  riskFlags: readonly RiskFlag[];
  /** Whether the practice dispenses DME from its own stock for this case. */
  inHouseDme: boolean;
  urgency: CaseUrgency;
  surgeryDate: IsoDate;
}

/** Readiness rules after settings resolution for one practice and facility. */
export interface ResolvedReadinessSettings {
  practiceId: PracticeId;
  practiceRules: readonly ReadinessRule[];
  facilityRules: readonly ReadinessRule[];
}

/** Port to the settings resolver. */
export interface ReadinessSettingsPort {
  resolve(practiceId: PracticeId, facilityId: string): Promise<ResolvedReadinessSettings>;
}

/** In-memory settings port for tests and local runs. */
export class InMemoryReadinessSettings implements ReadinessSettingsPort {
  private readonly practiceRules = new Map<PracticeId, ReadinessRule[]>();
  private readonly facilityRules = new Map<string, ReadinessRule[]>();

  setPracticeRules(practiceId: PracticeId, rules: readonly ReadinessRule[]): void {
    this.practiceRules.set(practiceId, [...rules]);
  }

  setFacilityRules(practiceId: PracticeId, facilityId: string, rules: readonly ReadinessRule[]): void {
    this.facilityRules.set(`${practiceId}/${facilityId}`, [...rules]);
  }

  async resolve(practiceId: PracticeId, facilityId: string): Promise<ResolvedReadinessSettings> {
    return {
      practiceId,
      practiceRules: [...(this.practiceRules.get(practiceId) ?? [])],
      facilityRules: [...(this.facilityRules.get(`${practiceId}/${facilityId}`) ?? [])],
    };
  }
}
