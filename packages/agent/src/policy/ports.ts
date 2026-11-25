/**
 * The shapes the policy engine reads and returns.
 *
 * The typed tool layer (RAH-16) is built in parallel, so the proposed action is defined here as the
 * minimal shape the policy engine needs. At integration the tool layer maps its tool calls onto this.
 */

/** Branded practice identifier. The practice is the isolation boundary. */
export type PracticeId = string & { readonly __brand: 'PracticeId' };

/** How much the agent may do on its own for one kind of action. */
export type AutonomyTier = 'autonomous' | 'approve_first' | 'human_only';

/** Where the case is performed. Tiers can be set per site of service. */
export type SiteOfService = 'office_procedure_room' | 'asc';

/** Every action the agent can propose. */
export type ActionKind =
  // Autonomous by default
  | 'eligibility_check'
  | 'auth_status_check'
  | 'reminder'
  | 'confirmation'
  | 'attach_received_document'
  | 'data_sync'
  // Approve-first by default
  | 'auth_submission'
  | 'retro_auth_submission'
  | 'facility_posting'
  | 'slot_booking'
  | 'vendor_booking'
  | 'reschedule_plan'
  | 'cancellation'
  // Depends on the template (signed: autonomous; edited or unsigned: approve-first)
  | 'patient_instructions'
  // Human-only by default
  | 'denial_appeal'
  | 'peer_to_peer'
  | 'financial_conversation'
  | 'clinical_question'
  | 'upset_patient_response';

export type Laterality = 'left' | 'right' | 'bilateral' | 'not_applicable';

/** Case facts an action asserts (what it would post, book or tell the patient). */
export interface CaseFacts {
  laterality?: Laterality;
  /** Procedure code, for example CPT 28296. */
  procedureCode?: string;
  /** ISO calendar date, YYYY-MM-DD. */
  procedureDate?: string;
}

/** The surgeon's signed order for the case: the source of truth for the cross-check. */
export interface SignedOrder extends CaseFacts {
  orderId: string;
  signedBySurgeonId: string;
  /** ISO timestamp of the signature. */
  signedAt: string;
  /** True when the surgeon signed it as an urgent order (ADR-0007). */
  urgent: boolean;
}

export type TemplateStatus = 'clinician_signed' | 'edited' | 'unsigned';

export interface InstructionsTemplate {
  templateId: string;
  status: TemplateStatus;
}

/** Clinical prep the action would give or change, measured against the surgeon-approved template. */
export interface ClinicalPrep {
  /** Null when no surgeon-approved prep template exists for the case. */
  surgeonApprovedTemplateId: string | null;
  /** Every item that goes beyond or differs from the approved template. Empty when it matches. */
  deviations: string[];
}

export type Channel = 'call' | 'sms' | 'email' | 'portal' | 'fax';
export type Recipient = 'patient' | 'payer' | 'facility' | 'vendor' | 'care_team';

/** Present when the action calls or messages someone. */
export interface Communication {
  channel: Channel;
  recipient: Recipient;
  /** True when the call or message says it comes from an automated agent. */
  identifiesAsAutomated: boolean;
}

/** Signals from the conversation that need a human immediately. */
export type PatientReportedConcern = 'emergency' | 'self_harm';

/** One action the agent proposes to take on a case. */
export interface ProposedAction {
  actionId: string;
  practiceId: PracticeId;
  caseId: string;
  kind: ActionKind;
  siteOfService: SiteOfService;
  /** The planner's confidence in this action, 0 to 1. */
  confidence: number;
  /** Conflicts found between data sources (for example EHR and facility disagree). Empty when none. */
  dataConflicts: string[];
  /** Facts the action asserts. Cross-checked against the signed order. */
  facts?: CaseFacts;
  signedOrder?: SignedOrder;
  /** Set on a slot booking for an urgent add-on. */
  urgentAddOn?: boolean;
  /** Set on patient instructions. */
  instructionsTemplate?: InstructionsTemplate;
  /** Set when the action gives or changes clinical prep. */
  clinicalPrep?: ClinicalPrep;
  communication?: Communication;
  /** Failed attempts so far at this external step. */
  failedAttempts: number;
  patientReportedConcerns?: PatientReportedConcern[];
}

/**
 * Practice configuration for the policy engine.
 *
 * There is deliberately no field for hard rules: no configuration may disable one.
 */
export interface PolicyConfig {
  practiceId: PracticeId;
  /**
   * Actions with confidence below this drop one tier. Between 0 and 1.
   * Defaults to DEFAULT_CONFIDENCE_THRESHOLD (0.8) when omitted.
   */
  confidenceThreshold?: number;
  /** Practice-wide tier per policy key. */
  tierOverrides?: Partial<Record<PolicyKey, AutonomyTier>>;
  /** Tier per policy key for one site of service. Wins over tierOverrides. */
  siteTierOverrides?: Partial<Record<SiteOfService, Partial<Record<PolicyKey, AutonomyTier>>>>;
}

/**
 * The key a tier is configured under. Mostly the action kind, but patient instructions split by template
 * status and an urgent add-on booked on a signed urgent order has its own key.
 */
export type PolicyKey =
  | Exclude<ActionKind, 'patient_instructions'>
  | 'patient_instructions_signed_template'
  | 'patient_instructions_unsigned_template'
  | 'urgent_add_on_booking';

export type HardRuleId =
  | 'clinical_prep_within_approved_template'
  | 'cancel_requires_human_approval'
  | 'cross_check_signed_order'
  | 'escalate_patient_emergency'
  | 'identify_as_automated'
  | 'escalate_after_two_failed_attempts';

/**
 * What a hard rule does when it fires.
 * - block: the action is not executed and goes to a human.
 * - escalate_immediately: block, and a human must look now.
 * - require_approval: the action may proceed only after human approval.
 */
export type HardRuleEffect = 'block' | 'escalate_immediately' | 'require_approval';

export type CrossCheckField = 'laterality' | 'procedure' | 'date' | 'signed_order';

/** One disagreement between the action and the signed order. */
export interface Mismatch {
  field: CrossCheckField;
  action: string | null;
  signedOrder: string | null;
}

export interface HardRuleFinding {
  rule: HardRuleId;
  effect: HardRuleEffect;
  message: string;
  mismatches?: Mismatch[];
}

export type Disposition = 'execute' | 'queue_for_approval' | 'escalate_to_human';

export interface TierDowngrade {
  from: AutonomyTier;
  to: AutonomyTier;
  reasons: string[];
}

/** The policy engine's verdict on one proposed action. */
export interface PolicyDecision {
  actionId: string;
  practiceId: PracticeId;
  policyKey: PolicyKey;
  disposition: Disposition;
  /** The tier that decided the disposition. */
  tier: AutonomyTier;
  /** The configured tier before any downgrade or hard-rule floor. */
  configuredTier: AutonomyTier;
  downgrade: TierDowngrade | null;
  /** True when a hard rule stopped the action. */
  blocked: boolean;
  /** Null, or how fast a human must look. */
  escalation: 'immediate' | 'standard' | null;
  hardRuleFindings: HardRuleFinding[];
  /** Set when something other than a scheduler's click counts as the approval. */
  approvedBy: 'signed_urgent_order' | null;
  reasons: string[];
}
