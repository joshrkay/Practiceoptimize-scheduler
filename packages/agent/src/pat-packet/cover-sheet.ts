import type { CaseDocument, CaseInfo, DocumentType } from './ports.js';

export interface CoverSheetInput {
  info: CaseInfo;
  documents: CaseDocument[]; // already in facility order
  pendingTypes: DocumentType[];
  referencesPacketId?: string | undefined;
}

export function renderCoverSheet(input: CoverSheetInput): string {
  const { info, documents, pendingTypes, referencesPacketId } = input;
  const lines = [
    referencesPacketId
      ? `PRE-ADMISSION TESTING ADDENDUM (refers to packet ${referencesPacketId})`
      : 'PRE-ADMISSION TESTING PACKET',
    `Patient: ${info.patientLabel}`,
    `Procedure: ${info.procedureLabel}`,
    `Surgery date: ${info.surgeryDate}`,
    '',
    'Contents:',
    ...documents.map((d, i) => `${i + 1}. ${d.title} (${d.type})`),
  ];
  if (pendingTypes.length > 0) {
    lines.push('', 'Pending (to follow as an addendum):', ...pendingTypes.map((t) => `- ${t}`));
  }
  return lines.join('\n');
}
