import { EHR_CAPABILITIES, PILOT_CAPABILITY_MATRIX, supportedCapabilities } from '../../src/index.js';
import { buildFakePractice, FAKE_PRACTICE, PATIENT_ID } from '../support/fake-harness.js';
import { describeEhrConnectorContract } from './ehr-connector-contract.js';

const fixture = {
  patientId: PATIENT_ID,
  missingPatientId: 'pt-missing',
  phiMarkers: ['Drew', 'Synthetic', '1970-05-05'],
  minOrders: 1,
  documentId: 'doc-1',
  providerId: 'prov-1',
  window: { from: '2027-02-01T13:00:00.000Z', to: '2027-02-08T00:00:00.000Z' },
  inBasketRecipientId: 'pool-front-desk',
};

for (const ehr of ['athenahealth', 'eclinicalworks', 'nextgen'] as const) {
  describeEhrConnectorContract(`in-memory fake (${ehr}, pilot matrix)`, () => ({
    connector: buildFakePractice().connector,
    ctx: { practiceId: FAKE_PRACTICE, locationId: `loc-${ehr}` },
    expected: { ehr, supported: supportedCapabilities(PILOT_CAPABILITY_MATRIX[ehr]) },
    fixture,
  }));
}

describeEhrConnectorContract('in-memory fake (athenahealth, every capability verified)', () => ({
  connector: buildFakePractice({ athenahealth: { 'inbasket.send': 'supported' } }).connector,
  ctx: { practiceId: FAKE_PRACTICE, locationId: 'loc-athenahealth' },
  expected: { ehr: 'athenahealth', supported: new Set(EHR_CAPABILITIES) },
  fixture,
}));

describeEhrConnectorContract('in-memory fake (nextgen, read-only connection)', () => ({
  connector: buildFakePractice({
    nextgen: { 'appointments.book': 'unsupported', 'chart.write': 'unsupported', 'schedule.read': 'unsupported' },
  }).connector,
  ctx: { practiceId: FAKE_PRACTICE, locationId: 'loc-nextgen' },
  expected: {
    ehr: 'nextgen',
    supported: new Set(['orders.read', 'patient.read', 'coverage.read', 'documents.read', 'appointments.read'] as const),
  },
  fixture,
}));
