/** Minimum necessary: the only PHI fields each request type may carry. Anything else is dropped. */

export type RequestType =
  | 'clearance_request'
  | 'lab_order'
  | 'asc_scheduling_request'
  | 'pre_admission_testing_request'
  | 'vendor_case_notice';

export const PHI_ALLOWLIST: Readonly<Record<RequestType, readonly string[]>> = {
  clearance_request: ['patientName', 'dateOfBirth', 'procedure', 'surgeryDate', 'surgeonName', 'clearanceQuestions'],
  lab_order: ['patientName', 'dateOfBirth', 'testsRequested', 'diagnosisCode', 'surgeryDate'],
  asc_scheduling_request: ['patientName', 'procedure', 'surgeryDate', 'surgeonName', 'estimatedDuration', 'laterality'],
  pre_admission_testing_request: ['patientName', 'dateOfBirth', 'procedure', 'surgeryDate', 'anesthesiaType'],
  vendor_case_notice: ['procedure', 'surgeryDate', 'surgeonName', 'facilityName', 'implantList'],
};

export const REQUEST_SUBJECTS: Readonly<Record<RequestType, string>> = {
  clearance_request: 'Preoperative clearance request',
  lab_order: 'Preoperative lab request',
  asc_scheduling_request: 'Surgical case scheduling request',
  pre_admission_testing_request: 'Pre-admission testing request',
  vendor_case_notice: 'Upcoming case notice',
};

export function filterFields(
  requestType: RequestType,
  fields: Readonly<Record<string, string>>,
): { allowed: Record<string, string>; dropped: string[] } {
  const allow = new Set(PHI_ALLOWLIST[requestType]);
  const allowed: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allow.has(k)) allowed[k] = v;
    else dropped.push(k);
  }
  return { allowed, dropped };
}
