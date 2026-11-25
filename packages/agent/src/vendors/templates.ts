import type { OutboundKind, VendorRequestFields } from './types.js';

/** Renders from allowlisted fields only, so nothing outside the allowlist can reach the text. */
function details(f: VendorRequestFields): string {
  const lines = [
    `Case reference: ${f.caseRef}`,
    `Patient initials: ${f.patientInitials}`,
    `Date: ${f.date}`,
    `Start time: ${f.startTime}`,
    `Facility: ${f.facilityName}`,
    `Procedure: ${f.procedure}`,
    `Implant system: ${f.implantSystem}`,
    `Tray needs: ${f.trayNeeds.length > 0 ? f.trayNeeds.join('; ') : 'none listed'}`,
  ];
  if (f.specialEquipment.length > 0) {
    lines.push(`Special equipment: ${f.specialEquipment.join('; ')}`);
  }
  return lines.join('\n');
}

const REPLY_LINE =
  'Please reply to confirm (1) that you or a rep will attend and (2) that the trays will be delivered on time.';

export function renderVendorMessage(
  kind: OutboundKind,
  f: VendorRequestFields,
  changes: string[] = [],
): { subject: string; body: string } {
  const ref = f.caseRef;
  switch (kind) {
    case 'request':
      return {
        subject: `Rep and tray request, case ${ref}, ${f.date}`,
        body: `Hello,\n\nWe request your attendance and implant trays for the case below.\n\n${details(f)}\n\n${REPLY_LINE}`,
      };
    case 'update':
      return {
        subject: `UPDATED rep and tray request, case ${ref}, ${f.date}`,
        body: `Hello,\n\nThis case has changed. Please use the updated details.\n\nChanged: ${changes.join(', ')}\n\n${details(f)}\n\n${REPLY_LINE}`,
      };
    case 'reconfirm':
      return {
        subject: `Reconfirm rep and trays, case ${ref}, ${f.date}`,
        body: `Hello,\n\nSurgery is within 48 hours. Please reconfirm.\n\n${details(f)}\n\n${REPLY_LINE}`,
      };
    case 'cancel':
      return {
        subject: `CANCELLED rep and tray request, case ${ref}, ${f.date}`,
        body: `Hello,\n\nThe case below is cancelled. No rep or trays are needed.\n\nCase reference: ${ref}\nDate: ${f.date}\nFacility: ${f.facilityName}`,
      };
  }
}
