import type { FacilityInfo } from './ports.js';
import type { VendorCaseInput, VendorRequestFields } from './types.js';

export function initialsOf(first: string, last: string): string {
  return `${first.trim().charAt(0).toUpperCase()}${last.trim().charAt(0).toUpperCase()}`;
}

function hasImplant(c: VendorCaseInput): boolean {
  return c.implantSystem !== null && c.implantSystem.trim() !== '';
}

/** A case needs a vendor request when it has an implant system or special equipment. */
export function needsVendor(c: VendorCaseInput): boolean {
  return hasImplant(c) || c.specialEquipment.length > 0;
}

/**
 * Explicit allowlist mapper: builds the vendor-facing fields one by one.
 * Never spread or copy the case record; new case fields stay private until added here on purpose.
 */
export function toVendorRequestFields(
  c: VendorCaseInput,
  facility: Pick<FacilityInfo, 'name' | 'timezone'>,
): VendorRequestFields {
  const d = new Date(c.surgeryStart);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: facility.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const startTime = new Intl.DateTimeFormat('en-US', {
    timeZone: facility.timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return {
    caseRef: c.caseRef,
    patientInitials: initialsOf(c.patient.firstName, c.patient.lastName),
    date,
    startTime,
    facilityName: facility.name,
    procedure: c.procedure,
    implantSystem: hasImplant(c) ? (c.implantSystem as string) : 'None (equipment only)',
    trayNeeds: [...c.trayNeeds],
    specialEquipment: [...c.specialEquipment],
  };
}
