/** Task type -> allowed case field paths (dot notation). Minimum-necessary: list only what the task needs. */
export const FIELD_POLICIES = {
  draft_patient_instructions: [
    'patient.name',
    'procedure.date',
    'procedure.arrivalTime',
    'procedure.name',
    'facility.name',
    'facility.address',
    'prepRules',
  ],
  schedule_confirmation: ['patient.name', 'procedure.date', 'procedure.arrivalTime', 'facility.name'],
  authorization_request: [
    'patient.name',
    'patient.dateOfBirth',
    'procedure.cpt',
    'procedure.name',
    'procedure.date',
    'insurance.payer',
    'insurance.memberId',
  ],
} as const satisfies Record<string, readonly string[]>;

export type TaskType = keyof typeof FIELD_POLICIES;

/** Lowercased key names that must never reach a model, even if a policy or nested object includes them. */
export const NEVER_SEND_KEYS: readonly string[] = ['ssn', 'socialsecuritynumber', 'socialsecurity'];
