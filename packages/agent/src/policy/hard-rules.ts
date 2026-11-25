import type { HardRuleFinding, HardRuleId, Mismatch, ProposedAction } from './ports.js';

/** Failed attempts at one external step after which a human takes over. */
export const MAX_FAILED_ATTEMPTS = 2;

interface HardRule {
  id: HardRuleId;
  check: (action: ProposedAction) => HardRuleFinding | null;
}

/** Never change clinical prep beyond the surgeon-approved template. */
function clinicalPrepWithinApprovedTemplate(action: ProposedAction): HardRuleFinding | null {
  const prep = action.clinicalPrep;
  if (prep === undefined) return null;
  if (prep.surgeonApprovedTemplateId === null) {
    return {
      rule: 'clinical_prep_within_approved_template',
      effect: 'block',
      message: 'Clinical prep has no surgeon-approved template to follow.',
    };
  }
  if (prep.deviations.length > 0) {
    return {
      rule: 'clinical_prep_within_approved_template',
      effect: 'block',
      message: `Clinical prep goes beyond the surgeon-approved template: ${prep.deviations.join('; ')}.`,
    };
  }
  return null;
}

/** Never cancel without human approval. */
function cancelRequiresHumanApproval(action: ProposedAction): HardRuleFinding | null {
  if (action.kind !== 'cancellation') return null;
  return {
    rule: 'cancel_requires_human_approval',
    effect: 'require_approval',
    message: 'A cancellation always needs human approval.',
  };
}

/** True for actions that post to a facility, message the patient, or book on the signed order alone. */
function needsOrderCrossCheck(action: ProposedAction): boolean {
  return (
    action.kind === 'facility_posting' ||
    action.kind === 'patient_instructions' ||
    action.communication?.recipient === 'patient' ||
    (action.kind === 'slot_booking' && action.urgentAddOn === true)
  );
}

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function compareFacts(action: ProposedAction): Mismatch[] {
  const facts = action.facts ?? {};
  const order = action.signedOrder;
  if (order === undefined) {
    return [{ field: 'signed_order', action: null, signedOrder: null }];
  }
  const mismatches: Mismatch[] = [];
  if (facts.laterality !== undefined && facts.laterality !== order.laterality) {
    mismatches.push({ field: 'laterality', action: facts.laterality, signedOrder: order.laterality ?? null });
  }
  if (
    facts.procedureCode !== undefined &&
    (order.procedureCode === undefined || normalizeCode(facts.procedureCode) !== normalizeCode(order.procedureCode))
  ) {
    mismatches.push({ field: 'procedure', action: facts.procedureCode, signedOrder: order.procedureCode ?? null });
  }
  if (facts.procedureDate !== undefined && facts.procedureDate !== order.procedureDate) {
    mismatches.push({ field: 'date', action: facts.procedureDate, signedOrder: order.procedureDate ?? null });
  }
  return mismatches;
}

function describeMismatch(mismatch: Mismatch): string {
  if (mismatch.field === 'signed_order') return 'no signed order to check against';
  return `${mismatch.field}: action says ${mismatch.action ?? 'nothing'}, signed order says ${mismatch.signedOrder ?? 'nothing'}`;
}

/** Always cross-check laterality, procedure and date against the signed order before any posting or patient message. */
function crossCheckSignedOrder(action: ProposedAction): HardRuleFinding | null {
  if (!needsOrderCrossCheck(action)) return null;
  const mismatches = compareFacts(action);
  if (mismatches.length === 0) return null;
  return {
    rule: 'cross_check_signed_order',
    effect: 'block',
    message: `Does not match the signed order (${mismatches.map(describeMismatch).join('; ')}).`,
    mismatches,
  };
}

/** Escalate patient-reported emergencies or self-harm immediately. */
function escalatePatientEmergency(action: ProposedAction): HardRuleFinding | null {
  const concerns = action.patientReportedConcerns ?? [];
  if (concerns.length === 0) return null;
  return {
    rule: 'escalate_patient_emergency',
    effect: 'escalate_immediately',
    message: `Patient reported ${concerns.map((concern) => concern.replace('_', '-')).join(' and ')}: a human must respond now.`,
  };
}

/** Identify as automated on every call and message. */
function identifyAsAutomated(action: ProposedAction): HardRuleFinding | null {
  const communication = action.communication;
  if (communication === undefined || communication.identifiesAsAutomated) return null;
  return {
    rule: 'identify_as_automated',
    effect: 'block',
    message: `The ${communication.channel} to the ${communication.recipient.replace('_', ' ')} does not say it is automated.`,
  };
}

/** Escalate after two failed attempts at any external step. */
function escalateAfterTwoFailedAttempts(action: ProposedAction): HardRuleFinding | null {
  if (action.failedAttempts < MAX_FAILED_ATTEMPTS) return null;
  return {
    rule: 'escalate_after_two_failed_attempts',
    effect: 'block',
    message: `This step has failed ${action.failedAttempts} times: a human takes over.`,
  };
}

/** The hard rules, in evaluation order. Not configurable. */
export const HARD_RULES: readonly HardRule[] = Object.freeze([
  { id: 'escalate_patient_emergency', check: escalatePatientEmergency },
  { id: 'clinical_prep_within_approved_template', check: clinicalPrepWithinApprovedTemplate },
  { id: 'cross_check_signed_order', check: crossCheckSignedOrder },
  { id: 'identify_as_automated', check: identifyAsAutomated },
  { id: 'escalate_after_two_failed_attempts', check: escalateAfterTwoFailedAttempts },
  { id: 'cancel_requires_human_approval', check: cancelRequiresHumanApproval },
]);

/** Runs every hard rule. Takes no configuration, so no configuration can switch one off. */
export function checkHardRules(action: ProposedAction): HardRuleFinding[] {
  return HARD_RULES.map((rule) => rule.check(action)).filter((finding) => finding !== null);
}
