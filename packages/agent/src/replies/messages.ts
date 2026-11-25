/**
 * Fixed patient-facing text. The emergency wording is safety text: short, fixed, bilingual, and never
 * model-generated. Changing it needs clinical sign-off.
 */
export const URGENT_INSTRUCTIONS =
  "If this is an emergency, call 911 now. For new symptoms, call your surgeon's office right away. " +
  'If you are thinking of harming yourself, call or text 988. ' +
  'Si es una emergencia, llame al 911 ahora. Para sintomas nuevos, llame al consultorio de su cirujano de inmediato.';

export function urgentInstructions(officePhone: string | null): string {
  return officePhone ? `${URGENT_INSTRUCTIONS} Office: ${officePhone}` : URGENT_INSTRUCTIONS;
}

export function helpText(locationPhone: string): string {
  return `You can reach the office at ${locationPhone}.`;
}

export function changeLinkText(url: string): string {
  return `To ask for a different time, pick one of three options here: ${url} The office will confirm your change.`;
}

export const CHANGE_NO_SLOTS_TEXT =
  'We got your request to change your time. The office will contact you to follow up.';
