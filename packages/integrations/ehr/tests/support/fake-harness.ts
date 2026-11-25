/** Test harness: the in-memory connector seeded with synthetic podiatry data. */
import {
  InMemoryEhrConnector,
  LocationSourceMap,
  type CapabilitySupport,
  type EhrCapability,
  type EhrSystem,
  type FakeEhrLocationData,
} from '../../src/index.js';

export const FAKE_PRACTICE = 'practice-fake-podiatry';
export const PATIENT_ID = 'pt-1001';

export const seedData = (locationId: string): FakeEhrLocationData => ({
  patients: [{ id: PATIENT_ID, givenName: 'Drew', familyName: 'Synthetic', birthDate: '1970-05-05', sex: 'other' }],
  coverage: {
    [PATIENT_ID]: [
      { payerName: 'Synthetic Secondary Plan', memberId: 'SEC-2', rank: 2 },
      { payerName: 'Synthetic Health Plan', memberId: 'MEM-1', rank: 1, groupNumber: 'GRP-9' },
    ],
  },
  orders: [
    {
      externalId: 'ord-1',
      practiceId: FAKE_PRACTICE,
      locationId,
      patientId: PATIENT_ID,
      status: 'new',
      priority: 'routine',
      orderedAt: '2027-01-02T10:00:00.000Z',
      receivedAt: '2027-01-02T10:01:00.000Z',
      procedures: [{ code: '28296', codeSystem: 'CPT', description: 'Bunionectomy' }],
      diagnoses: [{ code: 'M20.11', codeSystem: 'ICD-10-CM' }],
    },
  ],
  documents: [
    {
      id: 'doc-1',
      patientId: PATIENT_ID,
      documentType: 'Progress Note',
      title: 'Podiatry consult',
      authoredAt: '2026-12-20T09:00:00.000Z',
      contentType: 'text/plain',
      content: 'Synthetic consult note.',
    },
  ],
  appointments: [
    {
      id: 'appt-existing',
      patientId: PATIENT_ID,
      providerId: 'prov-1',
      visitType: 'Consult',
      start: '2027-02-02T15:00:00.000Z',
      end: '2027-02-02T15:30:00.000Z',
      status: 'booked',
    },
  ],
  slots: [
    { id: 'slot-1', providerId: 'prov-1', visitType: 'Post-op', start: '2027-02-01T14:00:00.000Z', end: '2027-02-01T14:30:00.000Z' },
    { id: 'slot-2', providerId: 'prov-1', visitType: 'Post-op', start: '2027-02-02T15:00:00.000Z', end: '2027-02-02T15:30:00.000Z' },
    { id: 'slot-3', providerId: 'prov-2', visitType: 'Post-op', start: '2027-02-03T15:00:00.000Z', end: '2027-02-03T15:30:00.000Z' },
  ],
});

export function buildFakePractice(overrides: Partial<Record<EhrSystem, Partial<Record<EhrCapability, CapabilitySupport>>>> = {}) {
  const ehrs = ['athenahealth', 'eclinicalworks', 'nextgen'] as const;
  const sources = new LocationSourceMap(
    ehrs.map((ehr) => ({
      practiceId: FAKE_PRACTICE,
      locationId: `loc-${ehr}`,
      ehr,
      redox: { destinationId: `dest-${ehr}`, patientIdType: 'MR' },
      ...(overrides[ehr] ? { capabilityOverrides: overrides[ehr] } : {}),
    })),
  );
  const connector = new InMemoryEhrConnector(sources);
  for (const ehr of ehrs) connector.seed(FAKE_PRACTICE, `loc-${ehr}`, seedData(`loc-${ehr}`));
  return { connector, sources };
}
