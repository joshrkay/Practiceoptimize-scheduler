import type { CaseSource, Locale, PaymentClass, ReadinessItemSource } from './ports.js';

export interface ChecklistItemView {
  id: string;
  label: string;
  status: 'done' | 'todo';
  ownedByPatient: boolean;
}

/**
 * Everything the patient page may show. Adding a field here is a privacy decision:
 * the mapper below picks each field by name and never spreads the source record.
 */
export interface PatientCaseView {
  locale: Locale;
  paymentClass: PaymentClass;
  procedureDate: string;
  arrivalTime: string;
  facility: { name: string; address: string; parking: string };
  surgeon: string;
  locationPhone: string;
  checklist: ChecklistItemView[];
  openItems: ChecklistItemView[];
}

function label(item: ReadinessItemSource, locale: Locale): string {
  return (locale === 'es' ? item.patientLabel.es : undefined) ?? item.patientLabel.en;
}

export function toPatientCaseView(
  source: CaseSource,
  locale: Locale = source.preferredLocale,
): PatientCaseView {
  const checklist: ChecklistItemView[] = source.readinessItems
    .filter((item) => item.patientVisible === true)
    .map((item) => ({
      id: String(item.id),
      label: label(item, locale),
      status: item.status === 'complete' || item.status === 'waived' ? 'done' : 'todo',
      ownedByPatient: item.owner === 'patient',
    }));
  return {
    locale,
    paymentClass: source.paymentClass,
    procedureDate: String(source.procedureDate),
    arrivalTime: String(source.arrivalTime),
    facility: {
      name: String(source.facility.name),
      address: String(source.facility.address),
      parking: String(source.facility.parking),
    },
    surgeon: String(source.surgeon.displayName),
    locationPhone: String(source.location.phone),
    checklist,
    openItems: checklist.filter((item) => item.ownedByPatient && item.status === 'todo'),
  };
}
