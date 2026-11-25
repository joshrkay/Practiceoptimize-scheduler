/**
 * Synthetic podiatry readiness rules for tests and local runs. Not clinical guidance:
 * they stand in for what a pilot practice and its ASC would configure.
 */
import type { ReadinessRule } from '../rules.js';

export const PODIATRY_PRACTICE_ID = 'practice-podiatry-demo';
export const DEMO_ASC_ID = 'facility-demo-asc';
export const DEMO_OFFICE_ID = 'facility-demo-office';

type RuleInput = Omit<ReadinessRule, 'practiceId' | 'version' | 'source' | 'enabled' | 'patientFacing'> &
  Partial<Pick<ReadinessRule, 'patientFacing' | 'enabled'>>;

function practiceRule(input: RuleInput): ReadinessRule {
  return { practiceId: PODIATRY_PRACTICE_ID, version: 1, source: 'practice', enabled: true, patientFacing: false, ...input };
}

function facilityRule(facilityId: string, input: RuleInput): ReadinessRule {
  return {
    practiceId: PODIATRY_PRACTICE_ID,
    version: 1,
    source: 'facility',
    facilityId,
    enabled: true,
    patientFacing: false,
    ...input,
  };
}

export const podiatryPracticeRules: readonly ReadinessRule[] = [
  practiceRule({
    id: 'rule-surgical-consent',
    description: 'Every elective case needs a signed surgical consent.',
    when: {},
    item: { key: 'consent.surgical', type: 'surgical_consent', label: 'Signed surgical consent', owner: 'surgeon', dueDaysBeforeSurgery: 1 },
  }),
  practiceRule({
    id: 'rule-preop-instructions',
    description: 'Send pre-op instructions to the patient.',
    patientFacing: true,
    when: {},
    item: { key: 'instructions.preop', type: 'patient_instructions', label: 'Pre-op instructions sent', owner: 'agent', dueDaysBeforeSurgery: 5 },
  }),
  practiceRule({
    id: 'rule-asc-hp',
    description: 'Cases at a facility need a history and physical.',
    when: { sitesOfService: ['asc'] },
    item: { key: 'hp', type: 'history_and_physical', label: 'History and physical', owner: 'provider', dueDaysBeforeSurgery: 3, validityDays: 30 },
  }),
  practiceRule({
    id: 'rule-asc-anesthesia-packet',
    description: 'Cases at a facility need the anesthesia questionnaire packet.',
    when: { sitesOfService: ['asc'] },
    item: { key: 'anesthesia.packet', type: 'anesthesia_packet', label: 'Anesthesia packet', owner: 'patient', dueDaysBeforeSurgery: 7 },
  }),
  practiceRule({
    id: 'rule-office-sedation-packet',
    description: 'Office cases under sedation still need the anesthesia packet.',
    when: { sitesOfService: ['office_procedure_room'], anesthesia: ['mac', 'regional', 'general'] },
    item: { key: 'anesthesia.packet', type: 'anesthesia_packet', label: 'Anesthesia packet', owner: 'patient', dueDaysBeforeSurgery: 7 },
  }),
  practiceRule({
    id: 'rule-diabetes-a1c',
    description: 'Diabetic patients need an A1c within 90 days of surgery.',
    when: { riskFlags: ['diabetes'] },
    item: { key: 'lab.a1c', type: 'lab', label: 'Hemoglobin A1c', owner: 'agent', dueDaysBeforeSurgery: 7, validityDays: 90 },
  }),
  practiceRule({
    id: 'rule-diabetes-pcp-clearance',
    description: 'Diabetic patients having facility cases need PCP clearance.',
    when: { riskFlags: ['diabetes'], sitesOfService: ['asc'] },
    item: { key: 'clearance.pcp', type: 'clearance', label: 'PCP clearance', owner: 'agent', dueDaysBeforeSurgery: 7, validityDays: 30 },
  }),
  practiceRule({
    id: 'rule-vascular-study',
    description: 'Patients with vascular disease need a non-invasive vascular study.',
    when: { riskFlags: ['vascular_disease'] },
    item: { key: 'imaging.vascular', type: 'imaging_study', label: 'Non-invasive vascular study', owner: 'agent', dueDaysBeforeSurgery: 10, validityDays: 180 },
  }),
  practiceRule({
    id: 'rule-smoker-fusion-cessation',
    description: 'Smokers having a fusion need a cessation plan.',
    when: { riskFlags: ['smoker'], procedureTags: ['fusion'] },
    item: { key: 'smoking.cessation', type: 'other', label: 'Smoking cessation plan', owner: 'surgeon', dueDaysBeforeSurgery: 28 },
  }),
  practiceRule({
    id: 'rule-authorization',
    description: 'Insured cases need prior authorization when the payer requires it.',
    when: { caseTypes: ['insured', 'mixed'], authorizationRequired: true },
    item: { key: 'authorization', type: 'authorization', label: 'Prior authorization', owner: 'agent', dueDaysBeforeSurgery: 5 },
  }),
  practiceRule({
    id: 'rule-self-pay-quote',
    description: 'Self-pay and mixed cases need a quote.',
    when: { caseTypes: ['self_pay', 'mixed'] },
    item: { key: 'financial.quote', type: 'financial_quote', label: 'Self-pay quote', owner: 'scheduler', dueDaysBeforeSurgery: 21 },
  }),
  practiceRule({
    id: 'rule-self-pay-consent',
    description: 'Self-pay and mixed cases need financial consent.',
    patientFacing: true,
    when: { caseTypes: ['self_pay', 'mixed'] },
    item: { key: 'financial.consent', type: 'financial_consent', label: 'Financial consent', owner: 'patient', dueDaysBeforeSurgery: 14 },
  }),
  practiceRule({
    id: 'rule-self-pay-deposit',
    description: 'Self-pay and mixed cases need a deposit.',
    when: { caseTypes: ['self_pay', 'mixed'] },
    item: { key: 'financial.deposit', type: 'deposit', label: 'Deposit received', owner: 'patient', dueDaysBeforeSurgery: 7 },
  }),
  practiceRule({
    id: 'rule-in-house-dme',
    description: 'In-house DME is dispensed on surgery day.',
    when: { inHouseDme: true },
    item: { key: 'dme.dispense', type: 'dme_dispensing', label: 'Dispense post-op DME', owner: 'scheduler', dueDaysBeforeSurgery: 0 },
  }),
];

export const demoAscRules: readonly ReadinessRule[] = [
  facilityRule(DEMO_ASC_ID, {
    id: 'rule-asc-hp-14',
    description: 'The ASC requires an H&P within 14 days.',
    when: {},
    item: { key: 'hp', type: 'history_and_physical', label: 'History and physical (ASC form)', owner: 'provider', dueDaysBeforeSurgery: 2, validityDays: 14 },
  }),
  facilityRule(DEMO_ASC_ID, {
    id: 'rule-asc-diabetes-glucose',
    description: 'The ASC requires a day-of-surgery glucose check for diabetic patients.',
    when: { riskFlags: ['diabetes'] },
    item: { key: 'lab.glucose', type: 'lab', label: 'Day-of-surgery glucose', owner: 'provider', dueDaysBeforeSurgery: 0 },
  }),
];
