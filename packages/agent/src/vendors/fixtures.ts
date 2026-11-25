import type { VendorCaseInput, VendorRep } from './types.js';

/** Synthetic podiatry case: first-MTP fusion plate set at an ASC (stands in for the knee-replacement fixture). */
export const mtpFusionCase: VendorCaseInput = {
  practiceId: 'practice-1',
  caseId: 'case-mtp-1',
  caseRef: 'CASE-1041',
  surgeonId: 'surgeon-1',
  facilityId: 'asc-1',
  surgeryStart: '2026-12-05T14:30:00Z',
  procedure: 'First MTP joint fusion',
  patient: { firstName: 'Zelda', lastName: 'Testpatient', dateOfBirth: '1961-07-19' },
  diagnosis: 'Hallux rigidus with end-stage degenerative arthritis',
  implantSystem: 'ToeFuse Plate Set (synthetic)',
  trayNeeds: ['Fusion plate tray', 'Cannulated screw set'],
  specialEquipment: [],
};

export const hammertoeCase: VendorCaseInput = {
  ...mtpFusionCase,
  caseId: 'case-ht-1',
  caseRef: 'CASE-1042',
  procedure: 'Second hammertoe correction',
  patient: { firstName: 'Quinn', lastName: 'Fakename', dateOfBirth: '1972-02-03' },
  diagnosis: 'Rigid hammertoe',
  implantSystem: 'HammerFix Implant (synthetic)',
  trayNeeds: ['Hammertoe implant tray'],
};

export const noImplantCase: VendorCaseInput = {
  ...mtpFusionCase,
  caseId: 'case-bun-1',
  caseRef: 'CASE-1043',
  procedure: 'Soft tissue neuroma excision',
  implantSystem: null,
  trayNeeds: [],
  specialEquipment: [],
};

export const preferredRep: VendorRep = {
  vendorId: 'vendor-a',
  repName: 'Rep Alpha',
  contact: 'rep.alpha@vendor.example',
};

export const directoryRep: VendorRep = {
  vendorId: 'vendor-b',
  repName: 'Rep Bravo',
  contact: 'rep.bravo@vendor.example',
};
