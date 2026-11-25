import type { CaseContext, DirectoryEntry, ReadinessItem } from './ports.js';

/** Synthetic: diabetic patient, bunionectomy at an ASC. */
export const bunionectomyCase: CaseContext = {
  practiceId: 'practice-podiatry-1',
  caseId: 'case-bunion-1',
  patientId: 'patient-synthetic-1',
  facilityId: 'asc-lakeside',
  surgeryDate: '2026-12-15',
  procedure: 'Bunionectomy, left foot',
  surgeonName: 'Dr. Synthetic Surgeon',
};

const base = {
  practiceId: bunionectomyCase.practiceId,
  caseId: bunionectomyCase.caseId,
  neededBy: '2026-12-08',
  status: 'open' as const,
};

export const items: Record<'cardiology' | 'a1c' | 'vascular', ReadinessItem> = {
  cardiology: { ...base, id: 'item-cardiology', kind: 'clearance', subtype: 'cardiology' },
  a1c: { ...base, id: 'item-a1c', kind: 'test', subtype: 'a1c', testDate: '2026-12-01' },
  vascular: { ...base, id: 'item-vascular', kind: 'test', subtype: 'vascular_study', testDate: '2026-12-02' },
};

export const directoryEntries: Record<string, DirectoryEntry> = {
  'provider:cardiology': { id: 'dir-cardiology', name: 'Synthetic Cardiology Group', kind: 'provider' },
  'lab:a1c': { id: 'dir-lab', name: 'Synthetic Lab', kind: 'lab' },
  'imaging:vascular_study': { id: 'dir-vascular', name: 'Synthetic Vascular Imaging', kind: 'imaging' },
};

export const ranges = { a1c: { min: 4, max: 8, unit: '%' } };
